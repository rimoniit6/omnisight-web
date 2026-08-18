import type { Prisma } from '@prisma/client';

/**
 * Internal OmniSight monitoring processes that must NEVER be counted as
 * employee application activity.
 *
 * The Desktop Agent's own process (electron-builder `executableName:
 * OmniSightAgent` → `OmniSightAgent.exe` on Windows) is the monitoring
 * process itself — time it spends in the foreground is NOT employee
 * application usage and must not appear in Top Applications & Websites,
 * activity summaries, usage counts/durations, reports, analytics, team
 * comparison, or AI-generated insights.
 *
 * Exclusion is centralized here and applied at the DATA layer (agent-side
 * collection + server ingestion + every aggregation route) — never by hiding
 * rows in the UI. Matching is case-insensitive so `omnisightagent.exe`,
 * `OmniSightAgent.exe`, and `OMNISIGHTAGENT.EXE` are all excluded. During the
 * brand transition the legacy binary name `worklensaiagent.exe` is also
 * excluded (old installs may still be running until upgraded).
 *
 * NOTE: keep this list in sync with the agent-side canonical list in
 * `omnisight-agent/src/lib/internal-process.ts`.
 */
export const INTERNAL_AGENT_PROCESS_NAMES: ReadonlyArray<string> = [
  'omnisightagent.exe',
  'worklensaiagent.exe', // legacy binary — removed once all installs have migrated
];

/**
 * Prisma `ActivityWhereInput` matching internal agent processes
 * (case-insensitive). Add to a top-level `where` under `NOT` to exclude them
 * from DB-side aggregates/counts:
 *
 *   where: { employeeId: id, NOT: INTERNAL_AGENT_ACTIVITY_FILTER }
 *
 * Note: unlike `isInternalAgentProcess`, the DB-side `in` filter does NOT trim
 * whitespace — stored process names never carry surrounding spaces in
 * practice, but callers preferring strict parity should also rely on the JS
 * helper for in-memory rows.
 */
export const INTERNAL_AGENT_ACTIVITY_FILTER: Prisma.ActivityWhereInput = {
  applicationName: { in: [...INTERNAL_AGENT_PROCESS_NAMES], mode: 'insensitive' },
};

/**
 * NULL-safe complement of INTERNAL_AGENT_ACTIVITY_FILTER for use at the TOP
 * level of a Prisma `where` (AND semantics), NOT under `NOT:`.
 *
 * Why this exists: `NOT: { applicationName: { in: [...] } }` compiles to
 * `NOT (applicationName IN (...))`, and under SQL three-valued logic a NULL
 * `applicationName` makes that predicate NULL → the row is silently dropped.
 * NULL applicationName covers ALL website, idle, screenshot and work_session
 * rows (the agent uploads those without an application name), so the NOT form
 * hid 63% of real activity data. This predicate keeps NULL rows and excludes
 * ONLY actual internal-agent processes:
 *
 *   (applicationName IS NULL OR applicationName NOT IN (internal names))
 *
 * Use it as:  where: { employeeId: id, ...NON_INTERNAL_AGENT_ACTIVITY_FILTER }
 */
export const NON_INTERNAL_AGENT_ACTIVITY_FILTER: Prisma.ActivityWhereInput = {
  OR: [
    { applicationName: null },
    // `notIn` + `mode` is the top-level (StringNullableFilter) form — `not: { in }`
    // would produce a NestedStringNullableFilter that has no `mode`, so this
    // keeps the case-insensitive exclusion type-safe AND NULL-safe.
    { applicationName: { notIn: [...INTERNAL_AGENT_PROCESS_NAMES], mode: 'insensitive' } },
  ],
};

/**
 * True when the given application/process name is an internal OmniSight
 * monitoring process (case-insensitive). Null/undefined/empty → false.
 */
export function isInternalAgentProcess(applicationName: string | null | undefined): boolean {
  if (!applicationName) return false;
  return INTERNAL_AGENT_PROCESS_NAMES.includes(applicationName.trim().toLowerCase());
}

/**
 * Filters a list of activity rows down to non-internal rows. The agent's own
 * process contributes zero usage count and zero duration everywhere this is
 * applied. Callers MUST ensure the queried rows carry `applicationName` (the
 * select includes it) — otherwise nothing can be filtered and the rows would
 * still be counted.
 */
export function excludeInternalAgentActivities<T>(rows: T[]): T[] {
  return rows.filter(
    (row) => !isInternalAgentProcess((row as { applicationName?: string | null }).applicationName)
  );
}
