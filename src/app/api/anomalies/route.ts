import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authenticateRequest, getSessionOrg, validatePagination } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import {
  isValidAnomalyType,
  isValidAnomalySeverity,
  isValidAnomalyScore,
  isValidAnomalyConfidence,
  stringifyAnomalyMetadata,
  MetadataTooLargeError,
} from '@/lib/anomalies/constants';

// Severity is intentionally absent: it is stored as a string and alphabetical
// order does not match severity order — only genuinely sortable keys are
// exposed to clients.
const SORTABLE = new Set(['createdAt', 'score']);
const MAX_SEARCH_LENGTH = 200;

// GET /api/anomalies — List anomalies with filters (org-scoped)
// Auth: any authenticated user may view (matches the navigation surface).
// All queries are scoped to the caller's organization server-side.
export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    const { searchParams } = new URL(req.url);

    // F-13: strict pagination — malformed page/pageSize are 422, never a
    // Prisma NaN crash.
    const pagination = validatePagination(searchParams, { defaultPageSize: 50, maxPageSize: 100 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize, skip } = pagination;

    const type = searchParams.get('type') || '';
    const severity = searchParams.get('severity') || '';
    const status = searchParams.get('status') || '';
    const search = (searchParams.get('search') || '').slice(0, MAX_SEARCH_LENGTH);
    const employeeId = searchParams.get('employeeId') || '';

    // F-20: server-side date range on createdAt (both bounds optional).
    const fromRaw = searchParams.get('from');
    const toRaw = searchParams.get('to');
    let createdAtFilter: { gte?: Date; lte?: Date } | undefined;
    if (fromRaw || toRaw) {
      createdAtFilter = {};
      if (fromRaw) {
        const from = new Date(fromRaw);
        if (Number.isNaN(from.getTime())) {
          return NextResponse.json({ error: 'from must be a valid date' }, { status: 422 });
        }
        createdAtFilter.gte = from;
      }
      if (toRaw) {
        const to = new Date(toRaw);
        if (Number.isNaN(to.getTime())) {
          return NextResponse.json({ error: 'to must be a valid date' }, { status: 422 });
        }
        // Inclusive upper bound: a date-picker `to` is the start of the day,
        // so extend to the end of that UTC day.
        createdAtFilter.lte = new Date(to.getTime() + 24 * 60 * 60 * 1000);
      }
    }

    // F-20: validated sort (whitelist) — never arbitrary client sort keys.
    const sortBy = searchParams.get('sortBy') || 'createdAt';
    const sortOrder = searchParams.get('sortOrder') === 'asc' ? 'asc' : 'desc';
    if (!SORTABLE.has(sortBy)) {
      return NextResponse.json({ error: 'sortBy must be one of: createdAt, score' }, { status: 422 });
    }

    // Tenant isolation: every query is forced to the caller's organization.
    const where: Record<string, unknown> = { organizationId: org.id };
    if (type) where.type = type;
    if (severity) where.severity = severity;
    if (status) where.status = status;
    if (employeeId) where.employeeId = employeeId;
    if (createdAtFilter) where.createdAt = createdAtFilter;

    if (search) {
      where.OR = [
        { title: { contains: search } },
        { description: { contains: search } },
      ];
    }

    const [anomalies, total, bySeverity, byStatus, byType] = await Promise.all([
      db.anomaly.findMany({
        where,
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeId: true, avatar: true, designation: true } },
          device: { select: { id: true, name: true, hostname: true } },
        },
        orderBy: { [sortBy]: sortOrder },
        skip,
        take: pageSize,
      }),
      db.anomaly.count({ where }),
      db.anomaly.groupBy({ by: ['severity'], where: { organizationId: org.id }, _count: { _all: true } }),
      db.anomaly.groupBy({ by: ['status'], where: { organizationId: org.id }, _count: { _all: true } }),
      db.anomaly.groupBy({ by: ['type'], where: { organizationId: org.id }, _count: { _all: true } }),
    ]);

    const bySeverityMap: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const g of bySeverity) bySeverityMap[g.severity] = g._count._all;
    const byStatusMap: Record<string, number> = { detected: 0, investigating: 0, resolved: 0, false_positive: 0 };
    for (const g of byStatus) byStatusMap[g.status] = g._count._all;
    const byTypeMap: Record<string, number> = {};
    for (const g of byType) byTypeMap[g.type] = g._count._all;

    const stats = {
      total: bySeverityMap.critical + bySeverityMap.high + bySeverityMap.medium + bySeverityMap.low,
      bySeverity: bySeverityMap,
      byStatus: byStatusMap,
      byType: byTypeMap,
    };

    return NextResponse.json({
      data: anomalies,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      stats,
    });
  } catch (error) {
    console.error('Anomalies GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch anomalies' }, { status: 500 });
  }
}

// POST /api/anomalies — Create anomaly manually (manager+)
// Manager+ role; employeeId/deviceId must belong to the caller's org.
// F-12: type/severity/score/confidence are strictly validated (422 on
// unknown values) — unknown severities can no longer corrupt the stats
// buckets. F-16: metadata is size-bounded. F-24: creation is audit-logged.
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'manager')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    const body = await req.json();
    const { type, severity, title, description, score, confidence, employeeId, deviceId, metadata, aiAnalysis } = body as {
      type?: unknown;
      severity?: unknown;
      title?: unknown;
      description?: unknown;
      score?: unknown;
      confidence?: unknown;
      employeeId?: string;
      deviceId?: string;
      metadata?: Record<string, unknown>;
      aiAnalysis?: string;
    };

    if (typeof title !== 'string' || !title.trim()) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }
    if (typeof description !== 'string' || !description.trim()) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 });
    }
    if (!isValidAnomalyType(type)) {
      return NextResponse.json({ error: `type must be one of: ${['productivity_drop', 'excessive_idle', 'unusual_login', 'rapid_app_switch', 'overtime_work', 'policy_breach', 'unusual_screenshot', 'low_activity_spike'].join(', ')}` }, { status: 422 });
    }
    if (severity !== undefined && severity !== null && !isValidAnomalySeverity(severity)) {
      return NextResponse.json({ error: 'severity must be one of: low, medium, high, critical' }, { status: 422 });
    }
    if (score !== undefined && score !== null && !isValidAnomalyScore(score)) {
      return NextResponse.json({ error: 'score must be a finite number between 0 and 100' }, { status: 422 });
    }
    if (confidence !== undefined && confidence !== null && !isValidAnomalyConfidence(confidence)) {
      return NextResponse.json({ error: 'confidence must be a finite number between 0 and 1' }, { status: 422 });
    }

    // IDOR guard: a supplied employeeId must belong to the caller's org.
    if (employeeId) {
      const emp = await db.employee.findFirst({
        where: { id: employeeId, organizationId: org.id },
        select: { id: true },
      });
      if (!emp) {
        return NextResponse.json({ error: 'Employee not found in your organization' }, { status: 404 });
      }
    }
    // IDOR guard: a supplied deviceId must belong to the caller's org.
    if (deviceId) {
      const dev = await db.device.findFirst({
        where: { id: deviceId, organizationId: org.id },
        select: { id: true },
      });
      if (!dev) {
        return NextResponse.json({ error: 'Device not found in your organization' }, { status: 404 });
      }
    }

    // F-16: metadata size bound at the API boundary.
    let serializedMetadata: string | null = null;
    try {
      serializedMetadata = stringifyAnomalyMetadata(metadata);
    } catch (error) {
      if (error instanceof MetadataTooLargeError) {
        return NextResponse.json({ error: error.message }, { status: 422 });
      }
      throw error;
    }

    const anomaly = await db.$transaction(async (tx) => {
      const created = await tx.anomaly.create({
        data: {
          type,
          severity: (severity as string) || 'medium',
          title,
          description,
          score: typeof score === 'number' ? score : 0,
          confidence: typeof confidence === 'number' ? confidence : 0,
          employeeId: employeeId || null,
          deviceId: deviceId || null,
          metadata: serializedMetadata,
          aiAnalysis: aiAnalysis || null,
          organizationId: org.id,
        },
      });

      // F-24: manual creation is audit-logged with the authenticated actor.
      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'anomaly',
          resourceId: created.id,
          description: `Anomaly created manually: ${created.title} (${created.type})`,
          userId: auth.userId,
          organizationId: org.id,
        },
      });

      return created;
    });

    return NextResponse.json(anomaly, { status: 201 });
  } catch (error) {
    console.error('Anomalies POST error:', error);
    return NextResponse.json({ error: 'Failed to create anomaly' }, { status: 500 });
  }
}
