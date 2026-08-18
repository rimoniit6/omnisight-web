// Self-Portal dashboard contract.
//
// /api/self/dashboard wraps its flat payload in the same { data: ... } envelope
// as the other /api/self routes. The portal must unwrap that envelope before
// reading fields — assigning the whole envelope to the query result used to
// render every Overview card as 0 (undefined → num() → 0). This module exists
// so the unwrap is a pure, unit-testable function and the contract is pinned
// by tests (see tests/hardening.test.ts H-25/H-26).

export interface DashboardData {
  todayHours: number;
  productiveToday: number;
  unproductiveToday: number;
  weeklyProductivity: number;
  productivityChange: number;
  deviceOnline: number;
  deviceTotal: number;
  deviceNames: string[];
  consentGranted: number;
  consentTotal: number;
  consentPending: number;
  timeBreakdown: { productive: number; neutral: number; unproductive: number };
}

/**
 * Unwrap the { data: {...} } envelope returned by /api/self/dashboard.
 *
 * Throws when the envelope is missing or malformed so callers surface the
 * error state instead of rendering a falsy/undefined payload as zeroes.
 * NOTE: callers must still check `res.ok` before calling this — a non-2xx
 * response body ({ error }) must never be treated as dashboard data.
 */
export function unwrapDashboard(json: unknown): DashboardData {
  if (
    json &&
    typeof json === 'object' &&
    'data' in json &&
    (json as { data?: unknown }).data &&
    typeof (json as { data: unknown }).data === 'object'
  ) {
    return (json as { data: DashboardData }).data;
  }
  throw new Error('Dashboard response is missing the data envelope');
}
