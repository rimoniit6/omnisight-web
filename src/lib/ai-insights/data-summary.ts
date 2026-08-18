// AI Insights — deterministic DATA SUMMARY engine.
//
// When the AI provider is unavailable/disabled/failing, the Insights
// experience must NOT die. This module produces a factual, deterministic
// summary STRICTLY from the canonical measured dataset (the same dataset that
// would have been sent to the AI provider). Every number in every finding is
// copied from the dataset — nothing is invented, nothing is random, nothing is
// inferred.
//
// Claim policy:
//   ALLOWED  — totals, percentages, averages, counts, highest/lowest,
//              rankings, project-hour distribution, category distribution,
//              comparisons between fields that exist in the dataset.
//   FORBIDDEN — personality/emotional/motivation judgments, intent, causal
//              explanations, performance diagnoses, anything not derivable
//              from the dataset.
//
// This output is NEVER labeled as AI-generated.

import type { InsightDataset } from './dataset';
import type { FallbackReason } from './fallback-codes';

export type DataSummaryFindingType = 'productivity' | 'activity' | 'project' | 'attendance';

export interface DataSummaryFinding {
  type: DataSummaryFindingType;
  title: string;
  statement: string;
  evidence: Record<string, number | string>;
}

export interface DataSummaryEvidenceRow {
  label: string;
  value: string;
}

export interface DataSummary {
  mode: 'DATA_SUMMARY';
  title: string;
  summary: string;
  findings: DataSummaryFinding[];
  /** Key-value provenance rows for the UI (events, productive, total, …). */
  evidence: DataSummaryEvidenceRow[];
  generatedAt: string;
  datasetHash: string;
  source: 'database';
  aiProvider: null;
  aiModel: null;
  fallbackReason: FallbackReason | null;
}

const MAX_FINDING_EMPLOYEES = 10;
const MAX_FINDING_PROJECTS = 10;

function fmtSec(seconds: number): string {
  return `${seconds.toLocaleString('en-US')} sec`;
}

function fmtHours(hours: number): string {
  return `${hours.toLocaleString('en-US', { maximumFractionDigits: 1 })}h`;
}

function fmtDay(iso: string): string {
  return iso.slice(0, 10);
}

/** Percent with 0 decimals, e.g. 19. → "19%". */
function pct(v: number): string {
  return `${Math.round(v)}%`;
}

/**
 * Build the deterministic Data Summary for a measured dataset.
 *
 * `fallbackReason` records WHY the AI path was not used (PROVIDER_* code or
 * null when this is a first-class "AI disabled" run) — it is metadata, never
 * a claim about employee data.
 */
export function generateDataSummary(
  dataset: InsightDataset,
  fallbackReason: FallbackReason | null
): DataSummary {
  const findings: DataSummaryFinding[] = [];
  const evidence: DataSummaryEvidenceRow[] = [];

  const employees = dataset.employees;
  const totals = dataset.totals;

  // ── Period / scope provenance rows ───────────────────────────────────────
  evidence.push(
    { label: 'Period', value: `${fmtDay(dataset.period.start.toISOString())} → ${fmtDay(dataset.period.end.toISOString())}` },
    { label: 'Organization', value: dataset.org.name },
    { label: 'Employees with data', value: String(employees.length) },
    { label: 'Activity events', value: totals.activityCount.toLocaleString('en-US') },
    { label: 'Total tracked time', value: fmtSec(totals.totalSeconds) },
    { label: 'Productive time', value: fmtSec(totals.productiveSeconds) },
    { label: 'Neutral time', value: fmtSec(totals.neutralSeconds) },
    { label: 'Unproductive time', value: fmtSec(totals.unproductiveSeconds) },
    { label: 'Productivity', value: pct(totals.productivityPct) },
  );
  if (dataset.consentSkipped > 0) {
    evidence.push({ label: 'Skipped (no consent)', value: String(dataset.consentSkipped) });
  }

  // ── Empty dataset → honest state, no invented content ───────────────────
  // "Empty" = no employees matched OR no activity in the window (consented
  // employees may exist with zero tracked seconds — nothing to summarize).
  if (employees.length === 0 || totals.totalSeconds === 0) {
    return {
      mode: 'DATA_SUMMARY',
      title: 'No employee data available',
      summary:
        'No employee activity data is available for the selected filters and period. ' +
        'No summary can be produced from an empty dataset.',
      findings: [],
      evidence,
      generatedAt: new Date().toISOString(),
      datasetHash: dataset.hash,
      source: 'database',
      aiProvider: null,
      aiModel: null,
      fallbackReason,
    };
  }

  // ── Org-level summary ────────────────────────────────────────────────────
  const scopeNote = employees.length === 1
    ? `${employees[0].name}`
    : `${employees.length} employees`;
  const summaryParts: string[] = [];
  summaryParts.push(
    `This summary covers ${scopeNote} across the period ${fmtDay(dataset.period.start.toISOString())} to ${fmtDay(dataset.period.end.toISOString())}.`
  );
  summaryParts.push(
    `Recorded activity totaled ${fmtSec(totals.totalSeconds)} across ${totals.activityCount.toLocaleString('en-US')} activity events.`
  );
  if (totals.totalSeconds > 0) {
    summaryParts.push(
      `Productive activity represented ${pct(totals.productivityPct)} of recorded time ` +
      `(${fmtSec(totals.productiveSeconds)} productive, ${fmtSec(totals.neutralSeconds)} neutral, ${fmtSec(totals.unproductiveSeconds)} unproductive).`
    );
  } else {
    summaryParts.push('No categorized activity was recorded in this period.');
  }

  // ── Per-employee productivity findings (highest first) ───────────────────
  const ranked = [...employees].sort((a, b) => b.totalSeconds - a.totalSeconds);
  for (const e of ranked.slice(0, MAX_FINDING_EMPLOYEES)) {
    if (e.totalSeconds === 0) continue;
    findings.push({
      type: 'productivity',
      title: `${e.name} — activity breakdown`,
      statement:
        `${e.name} recorded ${fmtSec(e.totalSeconds)} of activity ` +
        `(${fmtSec(e.productiveSeconds)} productive, ${fmtSec(e.neutralSeconds)} neutral, ` +
        `${fmtSec(e.unproductiveSeconds)} unproductive) with a productivity rate of ${pct(e.productivityPct)}.`,
      evidence: {
        employeeId: e.employeeId,
        name: e.name,
        productiveSeconds: e.productiveSeconds,
        neutralSeconds: e.neutralSeconds,
        unproductiveSeconds: e.unproductiveSeconds,
        totalSeconds: e.totalSeconds,
        productivityPercent: e.productivityPct,
        activityCount: e.activityCount,
      },
    });

    // Top applications (only facts present in the dataset).
    const topApp = e.topApps[0];
    if (topApp) {
      findings.push({
        type: 'activity',
        title: `${e.name} — most-used application`,
        statement: `${e.name} spent the most time in ${topApp.name} (${fmtSec(topApp.seconds)}).`,
        evidence: {
          employeeId: e.employeeId,
          applicationName: topApp.name,
          seconds: topApp.seconds,
        },
      });
    }

    // Project hours (only facts present in the dataset).
    for (const p of e.projects.slice(0, 3)) {
      findings.push({
        type: 'project',
        title: `${e.name} — project hours`,
        statement: `${e.name} logged ${fmtHours(p.hours)} on ${p.name} in this period.`,
        evidence: {
          employeeId: e.employeeId,
          projectId: p.projectId,
          projectName: p.name,
          hours: p.hours,
        },
      });
    }
  }

  // ── Org-wide project findings ────────────────────────────────────────────
  const projectsWithHours = [...dataset.projects]
    .filter((p) => p.totalHours > 0)
    .sort((a, b) => b.totalHours - a.totalHours);
  for (const p of projectsWithHours.slice(0, MAX_FINDING_PROJECTS)) {
    findings.push({
      type: 'project',
      title: `Project ${p.name} — logged hours`,
      statement:
        `Project ${p.name} has ${fmtHours(p.totalHours)} logged hours ` +
        (p.estimatedHours > 0 ? `against an estimate of ${fmtHours(p.estimatedHours)}.` : 'in this period.'),
      evidence: {
        projectId: p.projectId,
        projectName: p.name,
        totalHours: p.totalHours,
        estimatedHours: p.estimatedHours,
        status: p.status,
      },
    });
  }

  // ── Lowest-productivity employee (only when the dataset has data) ────────
  const withActivity = ranked.filter((e) => e.totalSeconds > 0);
  const lowest = withActivity.length > 1 ? withActivity[withActivity.length - 1] : null;
  if (lowest && lowest.totalSeconds > 0) {
    findings.push({
      type: 'productivity',
      title: 'Lowest recorded productivity rate',
      statement: `${lowest.name} recorded the lowest productivity rate at ${pct(lowest.productivityPct)} among the employees in this dataset.`,
      evidence: {
        employeeId: lowest.employeeId,
        name: lowest.name,
        productivityPercent: lowest.productivityPct,
        totalSeconds: lowest.totalSeconds,
      },
    });
  }

  return {
    mode: 'DATA_SUMMARY',
    title: 'Employee Data Summary',
    summary: summaryParts.join(' '),
    findings,
    evidence,
    generatedAt: new Date().toISOString(),
    datasetHash: dataset.hash,
    source: 'database',
    aiProvider: null,
    aiModel: null,
    fallbackReason,
  };
}
