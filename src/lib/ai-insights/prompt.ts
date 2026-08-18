// AI Insights — prompt construction.
//
// The system prompt pins the model to the supplied dataset (no invented
// facts), and the user prompt carries ONLY the bounded aggregate dataset built
// by buildInsightDataset — never raw rows, never secrets, never PII beyond the
// display name/department already visible to the admin.

import type { InsightDataset } from './dataset';

export const AI_INSIGHTS_SYSTEM_PROMPT = `You are analyzing workforce/productivity data supplied by the application. Use ONLY the supplied dataset.
Do not invent facts.
Do not infer missing employee activity as fact.
Do not fabricate percentages, durations, projects, or events.
If the data is insufficient, explicitly say so.
Distinguish measured facts from recommendations.
Do not make medical, psychological, legal, or disciplinary diagnoses.

Respond in VALID JSON ONLY (no markdown fences, no commentary) with EXACTLY this structure:
{
  "summary": "2-3 sentence natural-language executive summary of the whole period",
  "overallAssessment": "one paragraph overall assessment",
  "keyFindings": [
    {
      "type": "productivity | risk | trend | project | attendance",
      "severity": "low | medium | high",
      "title": "short finding title",
      "description": "finding grounded ONLY in the supplied metrics",
      "employeeId": "<id from the supplied data, optional>",
      "projectId": "<id from the supplied data, optional>",
      "evidence": { "metric": "metric name from the data", "value": "exact number from the data", "comparison": "optional comparison text" }
    }
  ],
  "recommendations": [
    { "priority": "low | medium | high", "title": "short recommendation", "description": "actionable recommendation grounded in the data" }
  ]
}

Rules:
- Only reference employeeId / projectId values that appear in the supplied dataset.
- "evidence.value" must contain ONLY the bare number copied from the supplied dataset — seconds for durations (e.g. "53241") or an integer percent (e.g. "19"). NEVER add units, labels, ranges, or commentary inside evidence.value; put units/labels in "metric" instead (e.g. "Tracked time (seconds)").
- If the dataset is empty or too small to analyze, say so in summary and return no findings.
- Max 12 keyFindings, max 8 recommendations.`;

function fmtSec(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(2)}h`;
  return `${Math.round(seconds / 60)}m`;
}

export function buildAiInsightsUserPrompt(dataset: InsightDataset): string {
  const { period, org, employees, projects, totals, filters, truncated } = dataset;

  const lines: string[] = [];
  lines.push(`📅 Period: ${period.start.toISOString()} → ${period.end.toISOString()}`);
  lines.push(`🏢 Organization: ${org.name}`);
  lines.push(`Filters: employee=${filters.employeeId ?? 'all'} · department=${filters.departmentId ?? 'all'} · project=${filters.projectId ?? 'all'}`);
  lines.push('');
  lines.push('=== ORG TOTALS (measured) ===');
  lines.push(`- Tracked time: ${fmtSec(totals.totalSeconds)} (${totals.totalSeconds} sec)`);
  lines.push(`- Productive: ${fmtSec(totals.productiveSeconds)} (${totals.productiveSeconds} sec)`);
  lines.push(`- Neutral: ${fmtSec(totals.neutralSeconds)} (${totals.neutralSeconds} sec)`);
  lines.push(`- Unproductive: ${fmtSec(totals.unproductiveSeconds)} (${totals.unproductiveSeconds} sec)`);
  lines.push(`- Productivity: ${totals.productivityPct}%`);
  lines.push(`- Activity events: ${totals.activityCount}`);
  lines.push('');

  if (employees.length === 0) {
    lines.push('No consented employees with activity data in this period.');
    return lines.join('\n');
  }

  lines.push('=== EMPLOYEES (measured, sorted by tracked time) ===');
  for (const e of employees) {
    lines.push(`Employee: ${e.name} (id ${e.employeeId})`);
    lines.push(`  Dept: ${e.department ?? 'Unassigned'} · Role: ${e.designation ?? 'N/A'} · Status: ${e.status}`);
    lines.push(`  Tracked: ${e.totalSeconds} sec (${fmtSec(e.totalSeconds)}) · Productive: ${e.productiveSeconds} sec · Neutral: ${e.neutralSeconds} sec · Unproductive: ${e.unproductiveSeconds} sec`);
    lines.push(`  Productivity: ${e.productivityPct}% · Activity events: ${e.activityCount}`);
    if (e.topApps.length > 0) {
      lines.push(`  Top apps: ${e.topApps.map((a) => `${a.name} (${fmtSec(a.seconds)})`).join(', ')}`);
    }
    if (e.projects.length > 0) {
      lines.push(`  Project hours: ${e.projects.map((p) => `${p.name} (${p.hours}h)`).join(', ')}`);
    }
    lines.push('');
  }

  if (projects.length > 0) {
    lines.push('=== PROJECTS (measured) ===');
    for (const p of projects) {
      lines.push(`- ${p.name} (id ${p.projectId}): status ${p.status}, logged ${p.totalHours}h, estimated ${p.estimatedHours}h${p.overdue ? ', OVERDUE' : ''}`);
    }
    lines.push('');
  }

  if (truncated) lines.push('(Dataset truncated: only the top 50 employees by tracked time are included.)');
  if (dataset.consentSkipped > 0) lines.push(`(${dataset.consentSkipped} employee(s) skipped — no active activity-tracking consent.)`);

  return lines.join('\n');
}
