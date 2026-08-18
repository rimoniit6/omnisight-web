// AI Insights — structured response contract + validation.
//
// The AI provider must answer with EXACTLY this shape. Every referenced
// employeeId/projectId must exist in the supplied dataset, and numeric claims
// carried in `evidence` must match the measured values within tolerance —
// otherwise the response is rejected (never persisted, never shown as AI).
//
// Zod v4 (`z.strictObject` rejects unknown keys → a hallucinated field such as
// a made-up `managerName` fails the parse instead of being silently kept).

import { z } from 'zod';
import type { InsightDataset } from './dataset';

const FINDING_TYPES = ['productivity', 'risk', 'trend', 'project', 'attendance'] as const;
const SEVERITIES = ['low', 'medium', 'high'] as const;
const PRIORITIES = ['low', 'medium', 'high'] as const;

export const aiInsightResponseSchema = z.strictObject({
  summary: z.string().min(1).max(2000),
  overallAssessment: z.string().min(1).max(2000),
  keyFindings: z
    .array(
      z.strictObject({
        type: z.enum(FINDING_TYPES),
        severity: z.enum(SEVERITIES),
        title: z.string().min(1).max(200),
        description: z.string().min(1).max(1500),
        employeeId: z.string().optional(),
        projectId: z.string().optional(),
        evidence: z
          .strictObject({
            metric: z.string().min(1).max(80),
            value: z.string().min(1).max(120),
            comparison: z.string().max(300).optional(),
          })
          .optional(),
      })
    )
    .max(12),
  recommendations: z
    .array(
      z.strictObject({
        priority: z.enum(PRIORITIES),
        title: z.string().min(1).max(200),
        description: z.string().min(1).max(1500),
      })
    )
    .max(8),
});

export type AiInsightResponse = z.infer<typeof aiInsightResponseSchema>;

export interface AiInsightValidationResult {
  ok: boolean;
  data?: AiInsightResponse;
  reason?: string;
}

/**
 * Tolerance helpers for numeric evidence claims.
 * - Percentages: within 5 percentage points.
 * - Durations (seconds): within 10% relative (min 60s floor).
 */
function withinTolerance(claim: number, measured: number, kind: 'pct' | 'seconds'): boolean {
  if (kind === 'pct') return Math.abs(claim - measured) <= 5;
  const abs = Math.abs(claim - measured);
  return abs <= Math.max(60, measured * 0.1);
}

/**
 * Extract every numeric run from a claim string. Handles models that write
 * "53241", "14.79h (53241 sec)", "19%", "1,234" etc. The claim is accepted
 * when ANY numeric run matches the measured value within tolerance — a
 * mixed-unit string like "14.79h (53241 sec)" must NOT be collapsed into one
 * mangled number (14.7953241) that falsely looks fabricated.
 */
function claimNumbers(value: string): number[] {
  const cleaned = value.replace(/,/g, '');
  const nums: number[] = [];
  for (const m of cleaned.matchAll(/-?\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (!Number.isNaN(n)) nums.push(n);
  }
  return nums;
}

/**
 * Validate a raw AI response against:
 *  1. the strict Zod schema (shape + unknown-field rejection),
 *  2. entity references (employeeId/projectId MUST exist in the dataset),
 *  3. numeric evidence claims (must match the measured metric within tolerance).
 *
 * Rejects (never silently accepts) fabricated entities or made-up numbers.
 */
export function validateAiInsightResponse(
  raw: unknown,
  dataset: InsightDataset
): AiInsightValidationResult {
  const parsed = aiInsightResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `AI response failed schema validation: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
  }
  const response = parsed.data;

  const employeeIds = new Set(dataset.employees.map((e) => e.employeeId));
  const projectIds = new Set(dataset.projects.map((p) => p.projectId));

  // Employee lookup by id for numeric claim checks.
  const employeeById = new Map(dataset.employees.map((e) => [e.employeeId, e]));

  for (const finding of response.keyFindings) {
    if (finding.employeeId && !employeeIds.has(finding.employeeId)) {
      return { ok: false, reason: `AI referenced unknown employeeId "${finding.employeeId}"` };
    }
    if (finding.projectId && !projectIds.has(finding.projectId)) {
      return { ok: false, reason: `AI referenced unknown projectId "${finding.projectId}"` };
    }
    if (finding.evidence) {
      const { metric, value } = finding.evidence;
      const claimNums = claimNumbers(value);
      if (claimNums.length > 0) {
        const emp = finding.employeeId ? employeeById.get(finding.employeeId) : undefined;
        // Every REAL measured number for the scoped entity (employee when the
        // finding names one, else org totals). The claim must match ANY of
        // them within tolerance — the model may quote productive, neutral,
        // unproductive, total, productivity % or the activity count, and we
        // must accept whichever real value it actually copied. A fabricated
        // number matches none of them and is rejected.
        const src = emp ?? {
          productivityPct: dataset.totals.productivityPct,
          totalSeconds: dataset.totals.totalSeconds,
          productiveSeconds: dataset.totals.productiveSeconds,
          neutralSeconds: dataset.totals.neutralSeconds,
          unproductiveSeconds: dataset.totals.unproductiveSeconds,
          activityCount: dataset.totals.activityCount,
        };
        // Metric kind gates which measured values the claim may match.
        // A "% productivity" claim must match the measured pct (never a
        // seconds value — "5" must not sneak past via activityCount=4), and
        // a seconds claim must match a seconds value (never the pct).
        const metricKey = metric.toLowerCase();
        const pctKind = metricKey.includes('productiv') || metricKey.includes('pct') || metricKey.includes('%');
        const secKind =
          metricKey.includes('second') || metricKey.includes('time') || metricKey.includes('tracked')
          || metricKey.includes('duration') || metricKey.includes('hour') || metricKey.includes('minute')
          || (metricKey.includes('activity') && (metricKey.includes('count') || metricKey.includes('event')));
        const candidates: Array<{ v: number; kind: 'pct' | 'seconds' }> = [];
        if (pctKind) candidates.push({ v: src.productivityPct, kind: 'pct' });
        if (secKind) {
          candidates.push(
            { v: src.totalSeconds, kind: 'seconds' },
            { v: src.productiveSeconds, kind: 'seconds' },
            { v: src.neutralSeconds, kind: 'seconds' },
            { v: src.unproductiveSeconds, kind: 'seconds' },
            { v: src.activityCount, kind: 'seconds' },
          );
        }
        // Project metrics are also supplied to the model: estimated hours and
        // logged hours per project, expressed in HOURS (e.g. "logged 1.6h").
        // When the finding names a project, or the claim references project
        // data, accept a value matching ANY real project's estimatedHours /
        // totalHours — in HOURS and in SECONDS (×3600), because the model may
        // quote either unit ("1.6" or "5760"). A fabricated number matches
        // none of the real values and is rejected.
        if (secKind && (metricKey.includes('project') || !!finding.projectId)) {
          const scope = finding.projectId
            ? dataset.projects.filter((p) => p.projectId === finding.projectId)
            : dataset.projects;
          for (const p of scope) {
            candidates.push(
              { v: p.estimatedHours, kind: 'seconds' },
              { v: p.totalHours, kind: 'seconds' },
              { v: p.estimatedHours * 3600, kind: 'seconds' },
              { v: p.totalHours * 3600, kind: 'seconds' },
            );
          }
        }
        // Unknown metric → no numeric cross-check possible; rely on schema
        // and entity checks only (never reject a legitimate finding).
        if (candidates.length === 0) continue;

        // ANY numeric run must match ANY candidate of the metric's kind within
        // tolerance. "14.79h (53241 sec)" → [14.79, 53241] → 53241 matches
        // total → accepted; "Neutral time (seconds) = 43218" → matches
        // neutral → accepted; "5%" (pct kind) → [5] vs 71 → rejected.
        const matches = claimNums.some((claimNum) =>
          candidates.some((c) => withinTolerance(claimNum, c.v, c.kind))
        );
        if (!matches) {
          return { ok: false, reason: `AI fabricated numeric claim: ${metric} = ${value}` };
        }
      }
    }
  }

  return { ok: true, data: response };
}
