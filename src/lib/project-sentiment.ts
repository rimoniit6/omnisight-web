// OmniSight — Project-Scoped Sentiment Analysis
//
// Project sentiment is derived EXCLUSIVELY from data that belongs to the
// project (TimeEntry rows: hours, category, billable, date). The Activity
// model has no project ownership, so employee-wide activity is NEVER
// relabeled as project sentiment — only the project's own time-entry data
// contributes to the signals below.
//
// Reuses the same score/mood/risk heuristics as the employee-level analyzer
// (see src/app/api/sentiment/analyze/route.ts) adapted to project signals.

export interface TimeEntryRow {
  employeeId: string;
  date: Date;
  hours: number;
  category: string | null;
  billable: boolean;
}

/** Productive time categories (TimeEntry.category value set). */
export const PRODUCTIVE_CATEGORIES = ['development', 'design', 'testing', 'review'];

export interface ProjectSignals {
  /** Total hours logged to the project in the current window. */
  hoursThisPeriod: number;
  /** Total hours logged to the project in the previous (comparison) window. */
  hoursLastPeriod: number;
  /** Percentage change vs previous window (0 when last window was empty). */
  hoursTrend: number;
  /** Hours in productive categories. */
  productiveHours: number;
  /** Productive share of total hours (0-100). */
  productiveRatio: number;
  /** Billable hours. */
  billableHours: number;
  /** Billable share of total hours (0-100). */
  billableRatio: number;
  /** Distinct days with at least one entry in the current window. */
  activeDays: number;
  /** Average hours on active days. */
  dailyAverageHours: number;
  /** Number of time entries in the current window. */
  entryCount: number;
  /** Category -> hours for the current window. */
  categoryDistribution: Record<string, number>;
}

function sumHours(rows: TimeEntryRow[]): number {
  return rows.reduce((sum, r) => sum + r.hours, 0);
}

/**
 * Build project-scoped signals from the project's TimeEntry rows only.
 * `current` = entries inside the analysis window; `previous` = entries in the
 * preceding window of equal length (used for the trend).
 */
export function calculateProjectSignals(
  current: TimeEntryRow[],
  previous: TimeEntryRow[]
): ProjectSignals {
  const hoursThisPeriod = sumHours(current);
  const hoursLastPeriod = sumHours(previous);
  const hoursTrend =
    hoursLastPeriod > 0
      ? ((hoursThisPeriod - hoursLastPeriod) / hoursLastPeriod) * 100
      : 0;

  const productiveHours = current
    .filter((r) => r.category && PRODUCTIVE_CATEGORIES.includes(r.category))
    .reduce((sum, r) => sum + r.hours, 0);

  const productiveRatio =
    hoursThisPeriod > 0 ? (productiveHours / hoursThisPeriod) * 100 : 0;

  const billableHours = current
    .filter((r) => r.billable)
    .reduce((sum, r) => sum + r.hours, 0);

  const billableRatio =
    hoursThisPeriod > 0 ? (billableHours / hoursThisPeriod) * 100 : 0;

  const activeDays = new Set(
    current.map((r) => r.date.toISOString().split('T')[0])
  ).size;

  const dailyAverageHours =
    activeDays > 0 ? hoursThisPeriod / activeDays : 0;

  const categoryDistribution: Record<string, number> = {};
  for (const r of current) {
    const cat = r.category || 'uncategorized';
    categoryDistribution[cat] = (categoryDistribution[cat] || 0) + r.hours;
  }

  return {
    hoursThisPeriod: Math.round(hoursThisPeriod * 100) / 100,
    hoursLastPeriod: Math.round(hoursLastPeriod * 100) / 100,
    hoursTrend: Math.round(hoursTrend * 10) / 10,
    productiveHours: Math.round(productiveHours * 100) / 100,
    productiveRatio: Math.round(productiveRatio * 10) / 10,
    billableHours: Math.round(billableHours * 100) / 100,
    billableRatio: Math.round(billableRatio * 10) / 10,
    activeDays,
    dailyAverageHours: Math.round(dailyAverageHours * 100) / 100,
    entryCount: current.length,
    categoryDistribution,
  };
}

export function calculateProjectScore(signals: ProjectSignals): number {
  let score = 50;

  if (signals.hoursTrend > 20) score += 10;
  else if (signals.hoursTrend > 0) score += 5;
  else if (signals.hoursTrend < -20) score -= 10;
  else if (signals.hoursTrend < -10) score -= 5;

  if (signals.productiveRatio > 70) score += 10;
  else if (signals.productiveRatio > 50) score += 5;
  else if (signals.productiveRatio < 30) score -= 10;

  // Overwork: sustained high daily hours is a burnout signal.
  if (signals.dailyAverageHours > 10) score -= 8;
  else if (signals.dailyAverageHours > 8) score -= 5;

  // Low chargeable (billable) share on a real workload.
  if (signals.billableRatio < 50 && signals.entryCount >= 3) score -= 3;

  // Sporadic engagement: few active days.
  if (signals.activeDays < 2 && signals.entryCount > 0) score -= 3;

  return Math.max(0, Math.min(100, score));
}

export function determineProjectMood(score: number): string {
  if (score > 70) return 'positive';
  if (score >= 40) return 'neutral';
  if (score >= 25) return 'negative';
  return 'critical';
}

export function calculateProjectRiskFactors(
  signals: ProjectSignals,
  score: number
): string[] {
  const risks: string[] = [];
  if (signals.dailyAverageHours > 10) risks.push('burnout_risk');
  if (signals.dailyAverageHours > 8) risks.push('overworked');
  if (signals.hoursTrend < -20 || (signals.productiveRatio < 30 && score < 40)) {
    risks.push('underperforming');
  }
  if (signals.productiveRatio < 30) risks.push('disengaged');
  if (signals.activeDays < 2 && signals.entryCount > 0) {
    risks.push('irregular_hours');
  }
  if (signals.hoursTrend < -20) risks.push('declining_engagement');
  return risks;
}

export function generateProjectRulesInsight(
  signals: ProjectSignals,
  score: number,
  mood: string,
  risks: string[]
): { insight: string; recommendation: string } {
  const parts: string[] = [];

  if (signals.hoursTrend > 20) {
    parts.push('Project engagement has increased strongly in this period.');
  } else if (signals.hoursTrend < -20) {
    parts.push('Project engagement has declined significantly in this period.');
  } else if (signals.hoursTrend !== 0) {
    parts.push('Project engagement is relatively stable.');
  }

  if (signals.productiveRatio > 70) {
    parts.push('Most logged time is in productive categories.');
  } else if (signals.productiveRatio < 30) {
    parts.push('A large share of logged time is outside productive categories.');
  }

  if (signals.dailyAverageHours > 10) {
    parts.push('Daily hours on this project exceed a healthy workload.');
  } else if (signals.dailyAverageHours > 8) {
    parts.push('Daily hours on this project are at the upper bound.');
  }

  if (parts.length === 0) {
    parts.push('No major project sentiment concerns detected in this period.');
  }

  const insight = parts.join(' ');

  let recommendation = 'Continue monitoring project engagement.';
  if (risks.includes('burnout_risk')) {
    recommendation =
      'Review workload distribution on this project and encourage breaks.';
  } else if (risks.includes('disengaged')) {
    recommendation =
      'Check in with the employee about their engagement with this project.';
  } else if (risks.includes('underperforming')) {
    recommendation =
      'Review task assignment and provide support to restore momentum.';
  } else if (mood === 'positive') {
    recommendation =
      'Project engagement is healthy. Consider recognizing the contribution.';
  }

  return { insight, recommendation };
}

/**
 * Human-readable summary lines for the AI prompt. Only aggregate project
 * metrics are included — no raw URLs, no credentials, no PII beyond the
 * employee name the caller already passes.
 */
export function projectSignalsPromptLines(signals: ProjectSignals): string[] {
  return [
    `Hours this period: ${signals.hoursThisPeriod.toFixed(1)}h`,
    `Hours previous period: ${signals.hoursLastPeriod.toFixed(1)}h`,
    `Hours trend: ${signals.hoursTrend > 0 ? '+' : ''}${signals.hoursTrend.toFixed(1)}%`,
    `Productive hours: ${signals.productiveHours.toFixed(1)}h (${signals.productiveRatio.toFixed(1)}% of total)`,
    `Billable ratio: ${signals.billableRatio.toFixed(1)}%`,
    `Active days: ${signals.activeDays}`,
    `Daily average: ${signals.dailyAverageHours.toFixed(1)}h`,
    `Time entries: ${signals.entryCount}`,
  ];
}
