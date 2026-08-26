'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER } from '@/lib/agent-process';
import { safeTimezone, zonedDayStart, zonedDayEnd, localDayKey } from '@/lib/timezone';
import { subDays } from 'date-fns';
import { log, requestContext } from '@/lib/logger';

// GET /api/employees/[id]/websites?from&to&page&pageSize
// Admin telemetry: domain-only website usage for one employee.
//
//   - PRIVACY: rows are aggregated by BARE DOMAIN (the stored `url` value on
//     website-type activity rows is already a normalized hostname — the agent
//     and the ingestion route enforce this). No full URL, path, query or page
//     content can appear: this endpoint only emits `domain` + aggregate
//     counts/durations. (It also strips an `https://` prefix defensively if a
//     legacy row ever contained one.)
//   - `data` is strictly paginated (page ≥ 1, pageSize 1..100).
//   - `summary` is a DB-side aggregate over the FULL filtered dataset.
//   - Manager+ read scope, same convention as employee activities.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_SLICE_MS = 5_000;

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Normalize a stored value to a bare lowercase domain (defensive only). */
function toDomain(raw: string): string {
  const cleaned = raw.replace(/^https?:\/\/(www\.)?/i, '').split(/[/?#]/)[0].toLowerCase();
  return cleaned.replace(/^www\./, '');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { searchParams } = new URL(request.url);

  const rawPage = searchParams.get('page');
  const rawPageSize = searchParams.get('pageSize');
  const page = rawPage === null ? 1 : Number(rawPage);
  const pageSize = rawPageSize === null ? 50 : Number(rawPageSize);
  if (
    (rawPage !== null && (!Number.isInteger(page) || page < 1)) ||
    (rawPageSize !== null && (!Number.isInteger(pageSize) || pageSize < 1)) ||
    pageSize > 100
  ) {
    return NextResponse.json(
      { error: 'page must be a positive integer and pageSize must be between 1 and 100' },
      { status: 422 }
    );
  }

  const fromParam = searchParams.get('from');
  const toParam = searchParams.get('to');
  if (fromParam && !isIsoDate(fromParam)) {
    return NextResponse.json({ error: 'Invalid from. Use YYYY-MM-DD.' }, { status: 422 });
  }
  if (toParam && !isIsoDate(toParam)) {
    return NextResponse.json({ error: 'Invalid to. Use YYYY-MM-DD.' }, { status: 422 });
  }

  try {
    const scope = await requireSessionOrg(request, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const employee = await db.employee.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      select: { id: true, organizationId: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // Organization-local day boundaries (single source of truth: the
    // employee's OWN organization timezone). "Today" means today in the
    // org's timezone — never the server's UTC midnight, which shifts the
    // window by the org offset (e.g. Asia/Dhaka +06) and can exclude an
    // entire local day.
    const org = await db.organization.findUnique({
      where: { id: employee.organizationId },
      select: { timezone: true },
    });
    const orgTz = safeTimezone(org?.timezone);

    const now = new Date();
    let startDate: Date;
    let endDate: Date;
    if (fromParam && toParam) {
      startDate = zonedDayStart(fromParam, orgTz);
      endDate = zonedDayEnd(toParam, orgTz);
    } else if (fromParam) {
      startDate = zonedDayStart(fromParam, orgTz);
      endDate = now;
    } else {
      startDate = zonedDayStart(localDayKey(subDays(now, 6), orgTz), orgTz);
      endDate = now;
    }

    // Website activity rows (NULL applicationName preserved by the NULL-safe
    // filter). Internal-agent processes are excluded.
    const where = {
      employeeId: id,
      type: 'website' as const,
      url: { not: null },
      timestamp: { gte: startDate, lte: endDate },
      ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
    };

    const rows = await db.activity.findMany({
      where,
      select: { url: true, duration: true, timestamp: true },
      orderBy: { timestamp: 'desc' },
    });

    // Aggregate by domain across the FULL filtered dataset (server-side; the
    // dataset is bounded by date range, so in-memory aggregation over the
    // paginated page would undercount).
    const map = new Map<string, { domain: string; visits: number; totalSeconds: number; firstSeen: number; lastSeen: number }>();
    for (const r of rows) {
      if (!r.url) continue;
      const domain = toDomain(r.url);
      if (!domain) continue;
      const entry = map.get(domain) ?? { domain, visits: 0, totalSeconds: 0, firstSeen: Number.POSITIVE_INFINITY, lastSeen: 0 };
      entry.visits += 1;
      // Sub-5s slices are noise (same threshold as the collector).
      entry.totalSeconds += Math.max(0, r.duration);
      const ts = r.timestamp.getTime();
      if (ts < entry.firstSeen) entry.firstSeen = ts;
      if (ts > entry.lastSeen) entry.lastSeen = ts;
      map.set(domain, entry);
    }

    const aggregated = [...map.values()]
      .map((e) => ({ ...e, totalSeconds: Math.round(e.totalSeconds) }))
      .sort((a, b) => b.totalSeconds - a.totalSeconds);

    const total = aggregated.length;
    const data = aggregated.slice((page - 1) * pageSize, page * pageSize).map((e) => ({
      domain: e.domain,
      visits: e.visits,
      totalSeconds: e.totalSeconds,
      firstSeen: new Date(e.firstSeen).toISOString(),
      lastSeen: new Date(e.lastSeen).toISOString(),
    }));

    const totalSeconds = aggregated.reduce((s, e) => s + e.totalSeconds, 0);
    const totalVisits = aggregated.reduce((s, e) => s + e.visits, 0);

    const totalPages = Math.ceil(total / pageSize);
    return NextResponse.json({
      data,
      total,
      page,
      pageSize,
      totalPages,
      summary: { totalSeconds, totalVisits, domains: total },
      minSliceMs: MIN_SLICE_MS,
    });
  } catch (error) {
    log.error('api.employees.id.websites.', { error: String('Admin website telemetry error:') }, requestContext(request));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
