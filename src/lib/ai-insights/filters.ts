// AI Insights — shared filter parsing + validation.
//
// Both GET (query params) and POST (JSON body) accept the same filter set.
// Entity ids are validated org-scoped; dates are validated ISO days; the
// window is capped (max 90 days, "today" inclusive) so a client can never ask
// for a pathological range. Filter identity is echoed back in every response
// so the UI always knows exactly which dataset produced the analysis.

import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { zonedDayStart, zonedDayEnd, localDayKey } from '@/lib/timezone';

export interface ParsedInsightFilters {
  periodStart: Date;
  periodEnd: Date;
  employeeId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 90;

export type FilterParseResult =
  | { ok: true; filters: ParsedInsightFilters }
  | { ok: false; response: NextResponse };

/**
 * Validate + normalize filters for one org.
 *
 * - `from`/`to` are YYYY-MM-DD (org-local days). Default = last 7 days.
 * - from > to or span > MAX_DAYS → 422.
 * - employeeId / departmentId / projectId must belong to the org → 422/404.
 */
export async function parseInsightFilters(
  organizationId: string,
  orgTimezone: string,
  params: { from?: string; to?: string; employeeId?: string | null; departmentId?: string | null; projectId?: string | null }
): Promise<FilterParseResult> {
  const { from, to } = params;

  const now = new Date();
  let startKey: string;
  let endKey: string;

  if (from && to) {
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      return { ok: false, response: NextResponse.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, { status: 422 }) };
    }
    if (from > to) {
      return { ok: false, response: NextResponse.json({ error: 'from must be on or before to' }, { status: 422 }) };
    }
    startKey = from;
    endKey = to;
  } else if (from) {
    if (!DATE_RE.test(from)) {
      return { ok: false, response: NextResponse.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, { status: 422 }) };
    }
    startKey = from;
    endKey = now.toISOString().slice(0, 10);
  } else if (to) {
    if (!DATE_RE.test(to)) {
      return { ok: false, response: NextResponse.json({ error: 'Invalid date. Use YYYY-MM-DD.' }, { status: 422 }) };
    }
    endKey = to;
    const d = new Date(to);
    d.setDate(d.getDate() - 6);
    startKey = d.toISOString().slice(0, 10);
  } else {
    // Default = the LAST 7 ORG-LOCAL calendar days ending today in the org's
    // timezone. Never derive the day key from the UTC date: when the org is
    // ahead of UTC (e.g. Asia/Dhaka is +06) the local date rolls over hours
    // before UTC midnight, and a UTC-derived endKey would silently exclude
    // today's activity from the window.
    endKey = localDayKey(now, orgTimezone);
    const d = new Date(now.getTime() - 6 * 86_400_000);
    startKey = localDayKey(d, orgTimezone);
  }

  const daySpan = Math.round((new Date(endKey).getTime() - new Date(startKey).getTime()) / 86_400_000) + 1;
  if (daySpan > MAX_DAYS) {
    return { ok: false, response: NextResponse.json({ error: `Date range may span at most ${MAX_DAYS} days` }, { status: 422 }) };
  }

  const periodStart = zonedDayStart(startKey, orgTimezone);
  const periodEnd = zonedDayEnd(endKey, orgTimezone);

  // Org-scoped entity validation (conceals cross-org ids as not found).
  if (params.employeeId) {
    const emp = await db.employee.findFirst({ where: { id: params.employeeId, organizationId }, select: { id: true } });
    if (!emp) return { ok: false, response: NextResponse.json({ error: 'Employee not found' }, { status: 404 }) };
  }
  if (params.departmentId) {
    const dept = await db.department.findFirst({ where: { id: params.departmentId, organizationId }, select: { id: true } });
    if (!dept) return { ok: false, response: NextResponse.json({ error: 'Department not found' }, { status: 404 }) };
  }
  if (params.projectId) {
    const proj = await db.project.findFirst({ where: { id: params.projectId, organizationId }, select: { id: true } });
    if (!proj) return { ok: false, response: NextResponse.json({ error: 'Project not found' }, { status: 404 }) };
  }

  return {
    ok: true,
    filters: {
      periodStart,
      periodEnd,
      employeeId: params.employeeId ?? null,
      departmentId: params.departmentId ?? null,
      projectId: params.projectId ?? null,
    },
  };
}
