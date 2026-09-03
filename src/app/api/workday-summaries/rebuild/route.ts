import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg, parseJsonBody, BodyParseError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { safeTimezone, localDayKey, dayKeysBetween } from '@/lib/timezone';
import { rebuildDaysForOrg } from '@/lib/jobs/workday-summary';

// POST /api/workday-summaries/rebuild — deterministic whole-day recompute +
// upsert for a bounded org-local date range (manager+ only; viewer/employee
// are never allowed to trigger aggregation work). Reads the SAME raw Activity
// rows the scheduled job reads and writes the SAME summary content, so a
// rebuild and the hourly job can never disagree. No raw telemetry is ever
// deleted or modified. Bounded to the 90-day product window and to the
// organization derived from the authenticated session.

const MAX_REBUILD_RANGE_DAYS = 90;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDayKey(v: string | null | undefined): v is string {
  if (!v || !DAY_RE.test(v)) return false;
  const t = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}

export async function POST(req: NextRequest) {
  try {
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);
    const orgId = scope.organizationId;

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (err) {
      if (err instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw err;
    }

    const { startDate: rawStart, endDate: rawEnd, employeeId } = body as {
      startDate?: unknown;
      endDate?: unknown;
      employeeId?: unknown;
    };
    const startDate = typeof rawStart === 'string' ? rawStart : undefined;
    const endDate = typeof rawEnd === 'string' ? rawEnd : undefined;
    if (!validDayKey(startDate) || !validDayKey(endDate)) {
      return NextResponse.json(
        { error: 'startDate and endDate are required YYYY-MM-DD day keys' },
        { status: 422 }
      );
    }
    if (startDate > endDate) {
      return NextResponse.json({ error: 'startDate must not be after endDate' }, { status: 422 });
    }

    const org = await db.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
    const tz = safeTimezone(org?.timezone ?? 'UTC');
    // A rebuild must never process future days (they do not exist yet in the
    // org's local calendar and would just be dropped).
    const todayKey = localDayKey(new Date(), tz);
    if (endDate > todayKey) {
      return NextResponse.json(
        { error: `endDate must not be after today (${todayKey}) in the organization timezone` },
        { status: 422 }
      );
    }

    const dayKeys = dayKeysBetween(startDate, endDate);
    if (dayKeys.length > MAX_REBUILD_RANGE_DAYS) {
      return NextResponse.json(
        { error: `Rebuild range exceeds the ${MAX_REBUILD_RANGE_DAYS}-day window` },
        { status: 422 }
      );
    }

    // Optional employee scoping — validated to belong to the org (foreign →
    // 404, never a silent cross-org no-op).
    let empId: string | undefined;
    if (employeeId !== undefined && employeeId !== null) {
      if (typeof employeeId !== 'string' || employeeId.length === 0) {
        return NextResponse.json({ error: 'employeeId must be a non-empty string' }, { status: 422 });
      }
      const employee = await db.employee.findFirst({
        where: { id: employeeId, organizationId: orgId },
        select: { id: true },
      });
      if (!employee) {
        return NextResponse.json({ error: 'Employee not found in this organization' }, { status: 404 });
      }
      empId = employeeId;
    }

    const result = await rebuildDaysForOrg(orgId, dayKeys, { employeeId: empId });
    if (result.errors.length > 0) {
      log.error('api.workday-summaries.rebuild', { organizationId: orgId, error: result.errors.join('; ') }, requestContext(req));
      return NextResponse.json({ error: 'Rebuild failed' }, { status: 500 });
    }

    return NextResponse.json({
      data: {
        organizationId: orgId,
        startDate,
        endDate,
        employeeId: empId ?? null,
        summariesUpserted: result.upserted,
        employeesWithData: result.employeesWithData,
      },
    });
  } catch {
    log.error('api.workday-summaries.rebuild', { error: String('Work day summary rebuild error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to rebuild work day summaries' }, { status: 500 });
  }
}
