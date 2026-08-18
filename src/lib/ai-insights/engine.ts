// AI Insights — engine orchestrator.
//
// Flow (shared by GET /api/insights/ai-analysis and POST /api/insights):
//   build dataset → check ai_insights_enabled → call provider → validate
//   structured response → return { measured, analysis, meta }.
//
// PRODUCT RULE: real employee data from the database is ALWAYS the source of
// truth; AI is optional for interpretation. When the provider is available the
// result is a validated AI_ANALYSIS over that dataset. When the provider is
// unavailable, disabled, quota-exhausted, rate-limited, misconfigured, returns
// 4xx/5xx, times out, or its response fails validation, the engine NEVER fails
// the Insights experience: it returns a deterministic DATA_SUMMARY generated
// from the SAME measured dataset (see data-summary.ts). The fallback triggers
// NO further AI request and is never labeled as AI.
//
// The provider is injectable (`aiCall`) so unit tests can assert the call
// happens and feed deterministic responses; the routes pass the real
// callAIProvider.

import { db } from '@/lib/db';
import { callAIProvider, type AIProviderResult } from '@/lib/ai-provider-helper';
import { buildInsightDataset, type InsightDataset, type InsightFilters } from './dataset';
import { validateAiInsightResponse, type AiInsightResponse } from './contract';
import { generateDataSummary, type DataSummary, type DataSummaryEvidenceRow } from './data-summary';
import { normalizeFallbackReason, REASON_DISABLED, type FallbackReason } from './fallback-codes';
import { AI_INSIGHTS_SYSTEM_PROMPT, buildAiInsightsUserPrompt } from './prompt';

export type AiStatus = 'generated' | 'disabled' | 'not_configured' | 'error';
export type AnalysisMode = 'AI_ANALYSIS' | 'DATA_SUMMARY';

/** A finding in either analysis mode (AI findings carry severity/desc; data-summary findings carry statement + numeric evidence). */
export interface AnalysisFinding {
  type: string;
  title: string;
  severity?: string;
  description?: string;
  statement?: string;
  employeeId?: string | null;
  projectId?: string | null;
  evidence?: Record<string, number | string> | { metric: string; value: string; comparison?: string } | null;
}

export interface AiInsightsResult {
  measured: InsightDataset;
  /** AI content — non-null ONLY when the provider actually generated a validated response. */
  ai: AiInsightResponse | null;
  /**
   * Always present. mode === 'AI_ANALYSIS' when a validated AI response was
   * produced; mode === 'DATA_SUMMARY' when the provider path was skipped or
   * failed (deterministic summary from the same measured dataset).
   */
  analysis: {
    mode: AnalysisMode;
    title: string;
    summary: string;
    findings: AnalysisFinding[];
    /** Provenance rows (label/value) shown in the UI. */
    evidence: DataSummaryEvidenceRow[];
  };
  meta: {
    aiStatus: AiStatus;
    aiError: string | null;
    /** Internal normalized fallback reason; null when AI_ANALYSIS succeeded. */
    fallbackReason: FallbackReason | null;
    /** True when the deterministic fallback was used (AI skipped/failed). */
    fallbackUsed: boolean;
    /** True when an AI provider was configured and reachable enough to attempt a call. */
    aiAvailable: boolean;
    source: 'database' | 'database+ai';
    provider: string | null;
    model: string | null;
    generatedAt: string;
    period: { start: string; end: string };
    filters: { employeeId: string | null; departmentId: string | null; projectId: string | null };
    datasetHash: string;
    consentSkipped: number;
    truncated: boolean;
  };
}

export interface EngineOptions {
  organizationId: string;
  filters: InsightFilters;
  /** Injectable provider — defaults to the real callAIProvider. */
  aiCall?: (system: string, user: string, opts?: { maxTokens?: number; temperature?: number }) => Promise<AIProviderResult | null>;
  /** Bypass the ai_insights_enabled gate (used by the super-admin test route). */
  force?: boolean;
}

/** Read the instance-global AI Insights toggle (dead setting now wired). */
async function aiInsightsEnabled(): Promise<boolean> {
  const row = await db.systemSetting.findUnique({ where: { key: 'ai_insights_enabled' } });
  // Default ENABLED unless explicitly disabled — matches the UI toggle default.
  return row ? row.value !== 'false' : true;
}

function mapProviderError(code: string | undefined): { status: AiStatus; aiError: string } {
  switch (code) {
    case 'AI_PROVIDER_NOT_CONFIGURED':
      return { status: 'not_configured', aiError: 'No AI provider is configured. Configure one in Settings → AI Provider.' };
    case 'AI_KEY_MISSING':
    case 'AI_KEY_DECRYPT_FAILED':
      return { status: 'not_configured', aiError: 'The AI provider API key is missing or unreadable. Re-enter it in Settings → AI Provider.' };
    case 'AI_HTTP_404':
      return { status: 'error', aiError: 'Configured AI model/provider endpoint is unavailable (HTTP 404). Check the provider and model in Settings → AI Provider.' };
    case 'AI_HTTP_429':
      return { status: 'error', aiError: 'AI provider rate limit reached. Please try again later.' };
    case 'AI_HTTP_401':
    case 'AI_HTTP_403':
      return { status: 'error', aiError: 'The AI provider rejected the API key (HTTP ' + code.slice(-3) + '). Check Settings → AI Provider.' };
    case 'AI_HTTP_500':
    case 'AI_HTTP_502':
    case 'AI_HTTP_503':
      return { status: 'error', aiError: 'The AI provider returned a server error. Try again shortly.' };
    case 'AI_REQUEST_FAILED':
      return { status: 'error', aiError: 'AI analysis timed out or could not reach the provider. Showing a database-backed summary instead.' };
    case 'AI_RESPONSE_INVALID':
      return { status: 'error', aiError: 'The AI provider returned an unparseable response. Showing a database-backed summary instead.' };
    default:
      return { status: 'error', aiError: 'AI analysis is currently unavailable. Showing a database-backed summary instead.' };
  }
}

/** Build the shared meta envelope (mode fields + existing compat fields). */
function buildMeta(opts: {
  aiStatus: AiStatus;
  aiError: string | null;
  fallbackReason: FallbackReason | null;
  fallbackUsed: boolean;
  aiAvailable: boolean;
  provider: string | null;
  model: string | null;
  dataset: InsightDataset;
}): AiInsightsResult['meta'] {
  return {
    aiStatus: opts.aiStatus,
    aiError: opts.aiError,
    fallbackReason: opts.fallbackReason,
    fallbackUsed: opts.fallbackUsed,
    aiAvailable: opts.aiAvailable,
    source: opts.fallbackUsed ? 'database' : 'database+ai',
    provider: opts.provider,
    model: opts.model,
    generatedAt: new Date().toISOString(),
    period: { start: opts.dataset.period.start.toISOString(), end: opts.dataset.period.end.toISOString() },
    filters: opts.dataset.filters,
    datasetHash: opts.dataset.hash,
    consentSkipped: opts.dataset.consentSkipped,
    truncated: opts.dataset.truncated,
  };
}

/**
 * Run a full AI Insights analysis for an org.
 *
 * Always returns `measured` (deterministic, real-data stats) and `analysis`.
 * `analysis.mode` is 'AI_ANALYSIS' only when the provider was actually called
 * AND its structured response passed schema + entity + numeric validation.
 * Every other outcome produces a deterministic 'DATA_SUMMARY' from the same
 * dataset — the Insights experience never dies because of the provider.
 */
export async function runAiInsightsAnalysis(opts: EngineOptions): Promise<AiInsightsResult> {
  const { organizationId, filters, force = false } = opts;
  const aiCall = opts.aiCall ?? callAIProvider;

  const dataset = await buildInsightDataset(organizationId, filters);

  // ── Empty dataset → honest empty state, NO provider call, nothing invented ──
  // "Empty" means NO activity data in the filtered window (employees may
  // still exist; the honest state is that there is nothing to summarize).
  if (dataset.employees.length === 0 || dataset.totals.totalSeconds === 0) {
    const dataSummary = generateDataSummary(dataset, null);
    return {
      measured: dataset,
      ai: null,
      analysis: { ...dataSummary },
      meta: buildMeta({
        aiStatus: 'error',
        aiError: 'No employee activity data is available for the selected filters and period.',
        fallbackReason: null,
        fallbackUsed: true,
        aiAvailable: false,
        provider: null,
        model: null,
        dataset,
      }),
    };
  }

  // ── AI disabled → deterministic Data Summary (NO provider call) ──────────
  const enabled = force || (await aiInsightsEnabled());
  if (!enabled) {
    const dataSummary = generateDataSummary(dataset, REASON_DISABLED);
    return {
      measured: dataset,
      ai: null,
      analysis: { ...dataSummary },
      meta: buildMeta({
        aiStatus: 'disabled',
        aiError: 'AI Insights disabled by administrator. Showing a database-backed summary.',
        fallbackReason: REASON_DISABLED,
        fallbackUsed: true,
        aiAvailable: false,
        provider: null,
        model: null,
        dataset,
      }),
    };
  }

  // ── AI path ──────────────────────────────────────────────────────────────
  const systemPrompt = AI_INSIGHTS_SYSTEM_PROMPT;
  const userPrompt = buildAiInsightsUserPrompt(dataset);

  const aiResult = await aiCall(systemPrompt, userPrompt, { maxTokens: 1200, temperature: 0.3 });

  const fallback = (reason: FallbackReason, aiStatus: AiStatus, aiError: string, provider: string | null, model: string | null, aiAvailable: boolean): AiInsightsResult => {
    const dataSummary = generateDataSummary(dataset, reason);
    return {
      measured: dataset,
      ai: null,
      analysis: { ...dataSummary },
      meta: buildMeta({
        aiStatus,
        aiError,
        fallbackReason: reason,
        fallbackUsed: true,
        aiAvailable,
        provider,
        model,
        dataset,
      }),
    };
  };

  if (!aiResult || !aiResult.text) {
    const reason = normalizeFallbackReason(aiResult?.error ?? 'AI_REQUEST_FAILED');
    const mapped = mapProviderError(aiResult?.error ?? 'AI_REQUEST_FAILED');
    const configLevel = reason === 'PROVIDER_NOT_CONFIGURED';
    return fallback(
      reason,
      mapped.status,
      mapped.aiError,
      // callAIProvider returns '' (not null) for config errors — normalize.
      aiResult?.provider ? aiResult.provider : null,
      aiResult?.model ? aiResult.model : null,
      // A config-level failure means the provider was NEVER configured/attempted;
      // HTTP/transport failures mean it WAS configured and attempted.
      configLevel ? false : true
    );
  }

  // Strip markdown fences if the model wrapped JSON in ```json … ```.
  const fenced = aiResult.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(fenced);
  } catch {
    return fallback('PROVIDER_INVALID_RESPONSE', 'error', 'The AI provider returned malformed JSON. Showing a database-backed summary instead.', aiResult.provider, aiResult.model, true);
  }

  const validation = validateAiInsightResponse(raw, dataset);
  if (!validation.ok || !validation.data) {
    return fallback(
      'PROVIDER_INVALID_RESPONSE',
      'error',
      `AI response validation failed: ${validation.reason ?? 'unknown'}. Showing a database-backed summary instead.`,
      aiResult.provider,
      aiResult.model,
      true
    );
  }

  const ai = validation.data;
  return {
    measured: dataset,
    ai,
    analysis: {
      mode: 'AI_ANALYSIS',
      title: ai.keyFindings[0]?.title || 'AI Analysis',
      summary: `${ai.summary}\n\n${ai.overallAssessment}`,
      findings: ai.keyFindings.map((k) => ({
        type: k.type,
        severity: k.severity,
        title: k.title,
        description: k.description,
        employeeId: k.employeeId ?? null,
        projectId: k.projectId ?? null,
        evidence: k.evidence ?? null,
      })),
      evidence: [
        { label: 'Period', value: `${dataset.period.start.toISOString().slice(0, 10)} → ${dataset.period.end.toISOString().slice(0, 10)}` },
        { label: 'Activity events', value: dataset.totals.activityCount.toLocaleString('en-US') },
        { label: 'Total tracked time', value: `${dataset.totals.totalSeconds.toLocaleString('en-US')} sec` },
        { label: 'Productive time', value: `${dataset.totals.productiveSeconds.toLocaleString('en-US')} sec` },
        { label: 'Productivity', value: `${dataset.totals.productivityPct}%` },
      ],
    },
    meta: buildMeta({
      aiStatus: 'generated',
      aiError: null,
      fallbackReason: null,
      fallbackUsed: false,
      aiAvailable: true,
      provider: aiResult.provider,
      model: aiResult.model,
      dataset,
    }),
  };
}

/** Convenience: narrow an analysis to a DataSummary when in DATA_SUMMARY mode. */
export function asDataSummary(analysis: AiInsightsResult['analysis']): DataSummary | null {
  return analysis.mode === 'DATA_SUMMARY' ? (analysis as unknown as DataSummary) : null;
}
