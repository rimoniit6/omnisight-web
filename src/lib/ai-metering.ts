// OmniSight — AI usage metering (Phase 5).
//
// One row per org-scoped AI provider call in the AiUsage table. Metering is
// deliberately additive and best-effort:
//   - It NEVER fails open the product path it observes: a metering write
//     failure is logged and swallowed — the AI result still returns.
//   - Rows are strictly tenant-scoped (organizationId is always the
//     authenticated session's org — never client-supplied).
//   - Tokens are recorded ONLY when the provider reported them; cost is
//     NEVER fabricated (no estimatedCost column, no invented pricing).
//   - No API key, prompt, or response content is ever written.
//   - Retention follows ai_insight_retention_days via the retention job.

import { db } from '@/lib/db';

export type AiUsageOperation =
  | 'ai_insight'
  | 'daily_summary'
  | 'sentiment'
  | 'sentiment_project'
  | 'screenshot_analysis'
  | 'test_connection';

export interface AiUsageWrite {
  organizationId: string;
  provider: string;
  model: string;
  operation: AiUsageOperation | string;
  status: 'success' | 'error';
  errorCode?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  latencyMs?: number | null;
}

/**
 * Best-effort insert of one metering row. Never throws: metering must not
 * break the AI operation it observes. Errors are logged with safe fields only
 * (no key, no payload).
 */
export async function recordAiUsage(record: AiUsageWrite): Promise<void> {
  try {
    await db.aiUsage.create({
      data: {
        organizationId: record.organizationId,
        provider: record.provider,
        model: record.model,
        operation: record.operation,
        status: record.status,
        errorCode: record.errorCode ?? null,
        inputTokens: record.inputTokens ?? null,
        outputTokens: record.outputTokens ?? null,
        totalTokens: record.totalTokens ?? null,
        latencyMs: record.latencyMs ?? null,
      },
    });
  } catch (err) {
    // Deliberately non-fatal. Safe diagnostic only — never the payload/key.
    console.error(
      `AI metering write failed (non-fatal): operation=${record.operation} org=${record.organizationId}`,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/** Provider-reported token counts, when the provider supplies them. */
export interface ProviderTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

/**
 * Wrap an AI provider call with org-scoped metering: measures wall latency,
 * records success/error status, and attaches provider-reported tokens when
 * the underlying call surface carries them (caller passes the `usage` field
 * returned by callAIProvider/callAIProviderVision when present).
 *
 * Config-level misses (provider never attempted → provider/model empty) are
 * NOT recorded: no provider call happened, so there is nothing to meter.
 */
export async function meterAiCall<T extends { provider: string; model: string; error?: string; usage?: ProviderTokenUsage | null } | null>(
  opts: { organizationId: string; operation: AiUsageOperation | string },
  call: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  const result = await call();
  const latencyMs = Date.now() - startedAt;

  // No provider attempted (config-level miss like AI_PROVIDER_NOT_CONFIGURED
  // returns provider '' / model ''). Nothing to meter.
  if (!result || (!result.provider && !result.model)) return result;

  await recordAiUsage({
    organizationId: opts.organizationId,
    provider: result.provider || 'unknown',
    model: result.model || 'unknown',
    operation: opts.operation,
    status: result.error ? 'error' : 'success',
    errorCode: result.error ?? null,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
    totalTokens: result.usage?.totalTokens ?? null,
    latencyMs,
  });

  return result;
}
