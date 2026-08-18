// AI Insights — server-side dataset aggregation.
//
// Builds the CONTROLLED, bounded dataset that is (a) shown as deterministic
// "measured" metrics and (b) fed to the AI provider. Every query is org-scoped
// through the authenticated session; filters (employee/department/project,
// date range) narrow the same dataset used for BOTH the measured stats and the
// AI prompt — the UI can never show AI analysis over a different window than
// its statistics.
//
// The dataset is deliberately aggregate-only: no raw Activity rows, no raw
// TimeEntry rows, no PII beyond employee display name + department + role, no
// secrets. Bounded to MAX_EMPLOYEES so a large org cannot blow up the prompt.

import { db } from '@/lib/db';
import { hasActiveConsent } from '@/lib/consent';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER } from '@/lib/agent-process';
import { createHash } from 'crypto';

export interface InsightFilters {
  periodStart: Date;
  periodEnd: Date;
  employeeId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
}

export interface EmployeeMetrics {
  employeeId: string;
  name: string;
  designation: string | null;
  department: string | null;
  status: string;
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
  totalSeconds: number;
  activityCount: number;
  productivityPct: number; // 0-100, 0 when no activity
  topApps: { name: string; seconds: number }[];
  projects: { projectId: string; name: string; hours: number }[];
}

export interface ProjectMetrics {
  projectId: string;
  name: string;
  status: string;
  estimatedHours: number;
  totalHours: number;
  overdue: boolean;
}

export interface InsightDataset {
  period: { start: Date; end: Date };
  filters: { employeeId: string | null; departmentId: string | null; projectId: string | null };
  org: { id: string; name: string; timezone: string };
  employees: EmployeeMetrics[];
  projects: ProjectMetrics[];
  totals: {
    productiveSeconds: number;
    neutralSeconds: number;
    unproductiveSeconds: number;
    totalSeconds: number;
    activityCount: number;
    productivityPct: number;
  };
  consentSkipped: number;
  truncated: boolean;
  /** Deterministic hash of (org, period, filters, dataset shape) for caching. */
  hash: string;
}

const MAX_EMPLOYEES = 50;
const MAX_TOP_APPS = 5;

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Aggregate one employee's activities (already filtered to the org + period,
 * internal agent processes excluded at query time) into seconds per category.
 */
function aggregateActivityRows(
  rows: Array<{ duration: number; category: string | null; applicationName: string | null }>
): { productive: number; neutral: number; unproductive: number; total: number } {
  let productive = 0;
  let neutral = 0;
  let unproductive = 0;
  for (const r of rows) {
    if (r.category === 'productive') productive += r.duration;
    else if (r.category === 'unproductive') unproductive += r.duration;
    else neutral += r.duration;
  }
  return { productive, neutral, unproductive, total: productive + neutral + unproductive };
}

/**
 * Build the bounded, real-data AI Insights dataset.
 *
 * Steps (all org-scoped, batched — no N+1):
 *  1. Resolve employees (optional employeeId/departmentId filter; status active).
 *  2. Consent gate: only employees with ACTIVE activity_tracking consent are
 *     analyzed (fail-closed, same semantics as sentiment). Skipped counted.
 *  3. Activity aggregates in the period (one batched query, internal-agent rows
 *     excluded at query time via NON_INTERNAL_AGENT_ACTIVITY_FILTER).
 *  4. Top apps per employee (bounded by a duration-ordered take per employee).
 *  5. TimeEntry hours per employee+project in the period (manual + auto).
 *  6. Project metrics (status, estimatedHours, overdue) + org totals.
 */
export async function buildInsightDataset(
  organizationId: string,
  filters: InsightFilters
): Promise<InsightDataset> {
  const { periodStart, periodEnd } = filters;

  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, timezone: true },
  });
  if (!org) throw new Error('Organization not found');

  // 1. Employee scope
  const employeeWhere: Record<string, unknown> = {
    organizationId,
    status: 'active',
    ...(filters.employeeId ? { id: filters.employeeId } : {}),
    ...(filters.departmentId ? { departmentId: filters.departmentId } : {}),
  };
  const employees = await db.employee.findMany({
    where: employeeWhere,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      designation: true,
      status: true,
      departmentId: true,
      department: { select: { name: true } },
      // Project filter: restrict to employees with an ACTIVE membership in
      // the selected project (membership must be org-scoped).
      ...(filters.projectId
        ? {
            projectMembers: {
              where: { projectId: filters.projectId, leftAt: null, organizationId },
              select: { id: true },
            },
          }
        : {}),
    },
    take: 500, // cap the base query; consent + sorting below further bounds it
  });

  let scoped = employees;
  if (filters.projectId) {
    scoped = employees.filter((e) => (e.projectMembers ?? []).length > 0);
  }

  // 2. Consent gate (batched, bounded)
  const consentResults = await Promise.all(
    scoped.map(async (e) => ({ e, consented: await hasActiveConsent(e.id, 'activity_tracking') }))
  );
  const consented = consentResults.filter((r) => r.consented).map((r) => r.e);
  const consentSkipped = scoped.length - consented.length;

  // 3. Activity aggregates in period (one batched query)
  const empIds = consented.map((e) => e.id);
  let activityRows: Array<{
    employeeId: string;
    duration: number;
    category: string | null;
    applicationName: string | null;
  }> = [];
  if (empIds.length > 0) {
    // Fetch the period's activity for the scoped employees (internal agent
    // rows excluded at query time). Bounded by the employee cap; durations
    // aggregated below. Indexed by (employeeId, timestamp).
    const rows = await db.activity.findMany({
      where: {
        employeeId: { in: empIds },
        timestamp: { gte: periodStart, lte: periodEnd },
        ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
      },
      select: { employeeId: true, duration: true, category: true, applicationName: true },
      orderBy: { timestamp: 'asc' },
    });
    activityRows = rows;
  }

  const actByEmp = new Map<string, typeof activityRows>();
  for (const r of activityRows) {
    const list = actByEmp.get(r.employeeId) ?? [];
    list.push(r);
    actByEmp.set(r.employeeId, list);
  }

  // 4. Top apps per employee (duration-ordered, capped per employee)
  const appUsageByEmp = new Map<string, Map<string, number>>();
  for (const r of activityRows) {
    if (!r.applicationName) continue;
    let m = appUsageByEmp.get(r.employeeId);
    if (!m) {
      m = new Map();
      appUsageByEmp.set(r.employeeId, m);
    }
    m.set(r.applicationName, (m.get(r.applicationName) || 0) + r.duration);
  }

  // 5. TimeEntry hours per employee+project in the period
  let timeEntries: Array<{ employeeId: string; projectId: string; hours: number }> = [];
  if (empIds.length > 0) {
    const entries = await db.timeEntry.findMany({
      where: {
        employeeId: { in: empIds },
        organizationId,
        date: { gte: periodStart, lte: periodEnd },
      },
      select: { employeeId: true, projectId: true, hours: true },
    });
    timeEntries = entries;
  }
  const hoursByEmpProject = new Map<string, number>();
  for (const t of timeEntries) {
    const key = `${t.employeeId}:${t.projectId}`;
    hoursByEmpProject.set(key, (hoursByEmpProject.get(key) || 0) + t.hours);
  }

  // 6. Project info for referenced projects
  const referencedProjectIds = new Set<string>();
  for (const key of hoursByEmpProject.keys()) referencedProjectIds.add(key.split(':')[1]);
  if (filters.projectId) referencedProjectIds.add(filters.projectId);
  let projectRows: Array<{
    id: string;
    name: string;
    status: string;
    estimatedHours: number;
    deadline: Date | null;
  }> = [];
  if (referencedProjectIds.size > 0) {
    projectRows = await db.project.findMany({
      where: { id: { in: [...referencedProjectIds] }, organizationId },
      select: { id: true, name: true, status: true, estimatedHours: true, deadline: true },
    });
  }
  const projectHours = new Map<string, number>();
  for (const t of timeEntries) {
    projectHours.set(t.projectId, (projectHours.get(t.projectId) || 0) + t.hours);
  }
  const projects: ProjectMetrics[] = projectRows.map((p) => ({
    projectId: p.id,
    name: p.name,
    status: p.status,
    estimatedHours: p.estimatedHours,
    totalHours: round1(projectHours.get(p.id) || 0),
    overdue: p.status === 'active' && !!p.deadline && p.deadline.getTime() < Date.now(),
  }));

  // Build per-employee metrics, sorted by total tracked seconds desc, capped.
  const metrics: EmployeeMetrics[] = consented.map((e) => {
    const agg = aggregateActivityRows(actByEmp.get(e.id) ?? []);
    const appMap = appUsageByEmp.get(e.id);
    const topApps = appMap
      ? [...appMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TOP_APPS)
          .map(([name, seconds]) => ({ name, seconds }))
      : [];
    const empProjects = projectRows
      .filter((p) => hoursByEmpProject.has(`${e.id}:${p.id}`))
      .map((p) => ({
        projectId: p.id,
        name: p.name,
        hours: round1(hoursByEmpProject.get(`${e.id}:${p.id}`) || 0),
      }));
    return {
      employeeId: e.id,
      name: `${e.firstName} ${e.lastName}`.trim(),
      designation: e.designation,
      department: e.department?.name ?? null,
      status: e.status,
      productiveSeconds: agg.productive,
      neutralSeconds: agg.neutral,
      unproductiveSeconds: agg.unproductive,
      totalSeconds: agg.total,
      activityCount: (actByEmp.get(e.id) ?? []).length,
      productivityPct: agg.total > 0 ? Math.round((agg.productive / agg.total) * 100) : 0,
      topApps,
      projects: empProjects,
    };
  });

  metrics.sort((a, b) => b.totalSeconds - a.totalSeconds);
  const truncated = metrics.length > MAX_EMPLOYEES;
  const bounded = metrics.slice(0, MAX_EMPLOYEES);

  const totals = bounded.reduce(
    (acc, m) => {
      acc.productiveSeconds += m.productiveSeconds;
      acc.neutralSeconds += m.neutralSeconds;
      acc.unproductiveSeconds += m.unproductiveSeconds;
      acc.totalSeconds += m.totalSeconds;
      acc.activityCount += m.activityCount;
      return acc;
    },
    { productiveSeconds: 0, neutralSeconds: 0, unproductiveSeconds: 0, totalSeconds: 0, activityCount: 0, productivityPct: 0 }
  );
  totals.productivityPct =
    totals.totalSeconds > 0 ? Math.round((totals.productiveSeconds / totals.totalSeconds) * 100) : 0;

  // Deterministic dataset hash (org + period + filters + per-employee seconds).
  const hashSource = JSON.stringify({
    org: organizationId,
    start: periodStart.toISOString(),
    end: periodEnd.toISOString(),
    employeeId: filters.employeeId ?? null,
    departmentId: filters.departmentId ?? null,
    projectId: filters.projectId ?? null,
    employees: bounded.map((m) => [m.employeeId, m.productiveSeconds, m.neutralSeconds, m.unproductiveSeconds, m.activityCount]),
  });
  const hash = createHash('sha256').update(hashSource).digest('hex').slice(0, 16);

  return {
    period: { start: periodStart, end: periodEnd },
    filters: {
      employeeId: filters.employeeId ?? null,
      departmentId: filters.departmentId ?? null,
      projectId: filters.projectId ?? null,
    },
    org: { id: org.id, name: org.name, timezone: org.timezone || 'UTC' },
    employees: bounded,
    projects,
    totals,
    consentSkipped,
    truncated,
    hash,
  };
}
