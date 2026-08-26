import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { authError, requireSessionOrg, requireAdminOrg, validatePagination } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// Authoritative value sets (mirror of the Project model comments). The UI and
// every mutation must agree with these — never invent new enum values.
const PROJECT_STATUSES = ['active', 'on_hold', 'completed', 'cancelled'] as const;
const PROJECT_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
const PROJECT_BUDGET_TYPES = ['fixed', 'hourly', 'retainer'] as const;
const MAX_NAME_LENGTH = 120;

function isStatus(v: unknown): v is (typeof PROJECT_STATUSES)[number] {
  return typeof v === 'string' && (PROJECT_STATUSES as readonly string[]).includes(v);
}
function isPriority(v: unknown): v is (typeof PROJECT_PRIORITIES)[number] {
  return typeof v === 'string' && (PROJECT_PRIORITIES as readonly string[]).includes(v);
}
function isBudgetType(v: unknown): v is (typeof PROJECT_BUDGET_TYPES)[number] {
  return typeof v === 'string' && (PROJECT_BUDGET_TYPES as readonly string[]).includes(v);
}
function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v) && v >= 0;
}

interface ValidatedProject {
  name?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  start: Date | null;
  deadline: Date | null;
  estimatedHours?: number;
  color?: string;
  budgetType?: string | null;
  hourlyRate?: number | null;
  tags: string | null;
}

/**
 * Validate + normalize the shared Project payload fields (create & update).
 * Returns { ok: true, data } or { ok: false, status, error }.
 */
function validateProjectPayload(body: Record<string, unknown>): { ok: true; data: ValidatedProject } | { ok: false; status: number; error: string } {
  const { name, description, status, priority, deadline, startDate, estimatedHours, color, budgetType, hourlyRate, tags } = body;

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false as const, status: 400, error: 'Project name is required' };
    }
    if (name.trim().length > MAX_NAME_LENGTH) {
      return { ok: false as const, status: 422, error: `Project name must be ${MAX_NAME_LENGTH} characters or fewer` };
    }
  }
  if (status !== undefined && !isStatus(status)) {
    return { ok: false as const, status: 422, error: `Invalid status. Allowed: ${PROJECT_STATUSES.join(', ')}` };
  }
  if (priority !== undefined && !isPriority(priority)) {
    return { ok: false as const, status: 422, error: `Invalid priority. Allowed: ${PROJECT_PRIORITIES.join(', ')}` };
  }
  if (budgetType !== undefined && budgetType !== null && !isBudgetType(budgetType)) {
    return { ok: false as const, status: 422, error: `Invalid budget type. Allowed: ${PROJECT_BUDGET_TYPES.join(', ')}` };
  }
  if (estimatedHours !== undefined && estimatedHours !== null && !isNonNegativeNumber(estimatedHours)) {
    return { ok: false as const, status: 422, error: 'Estimated hours must be a non-negative number' };
  }
  if (hourlyRate !== undefined && hourlyRate !== null && !isNonNegativeNumber(hourlyRate)) {
    return { ok: false as const, status: 422, error: 'Hourly rate must be a non-negative number' };
  }

  // Dates: must parse; startDate must be <= deadline when both are present.
  const start = startDate ? new Date(String(startDate)) : null;
  const end = deadline ? new Date(String(deadline)) : null;
  if (startDate && (!start || Number.isNaN(start.getTime()))) {
    return { ok: false as const, status: 422, error: 'Invalid start date' };
  }
  if (deadline && (!end || Number.isNaN(end.getTime()))) {
    return { ok: false as const, status: 422, error: 'Invalid deadline' };
  }
  if (start && end && start.getTime() > end.getTime()) {
    return { ok: false as const, status: 422, error: 'Start date must be on or before the deadline' };
  }

  const tagsStr = tags !== undefined ? (tags === null ? null : JSON.stringify(tags)) : null;

  return {
    ok: true as const,
    data: {
      name: name !== undefined ? String(name).trim() : undefined,
      description:
        description === undefined ? undefined : description === null ? null : String(description),
      status: status === undefined ? undefined : String(status),
      priority: priority === undefined ? undefined : String(priority),
      start,
      deadline: end,
      estimatedHours: estimatedHours === undefined ? undefined : Number(estimatedHours),
      color: color === undefined ? undefined : String(color),
      budgetType:
        budgetType === undefined ? undefined : budgetType === null ? null : String(budgetType),
      hourlyRate: hourlyRate === undefined ? undefined : hourlyRate === null ? null : Number(hourlyRate),
      tags: tagsStr,
    },
  };
}

/** Case-insensitive duplicate-name check (SQLite has no `mode: insensitive`). */
async function findDuplicateName(organizationId: string, name: string, excludeId?: string) {
  const existing = await db.project.findMany({
    where: { organizationId, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, name: true },
  });
  const needle = name.toLowerCase();
  return existing.find((p) => p.name.toLowerCase() === needle) ?? null;
}

export async function GET(req: NextRequest) {
  try {
    // Authenticated + org-scoped list, including the aggregate stats.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const priority = searchParams.get('priority');
    const departmentId = searchParams.get('departmentId');
    const search = searchParams.get('search') || '';
    const sortBy = searchParams.get('sortBy') || 'newest';
    // Archived (cancelled) projects are hidden from the DEFAULT list. Passing
    // includeArchived=true brings them back; an explicit status filter (e.g.
    // status=cancelled) always wins over the archive default.
    const includeArchived = searchParams.get('includeArchived') === 'true';

    const pagination = validatePagination(searchParams, { defaultPageSize: 50, maxPageSize: 200 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize, skip } = pagination;

    const where: Prisma.ProjectWhereInput = {};
    if (scope.organizationId) where.organizationId = scope.organizationId;

    if (status) {
      // Explicit status filter takes precedence over the archive default.
      where.status = status;
    } else if (!includeArchived) {
      // Default view: hide archived (cancelled) projects.
      where.status = { not: 'cancelled' };
    }
    if (priority) where.priority = priority;
    if (departmentId) where.departmentId = departmentId;
    if (search) {
      // Case-insensitive partial match on the project name (PostgreSQL ILIKE).
      where.name = { contains: search, mode: 'insensitive' };
    }

    const orgFilter: Prisma.ProjectWhereInput = scope.organizationId
      ? { organizationId: scope.organizationId }
      : {};
    const memberOrgFilter = scope.organizationId ? { organizationId: scope.organizationId } : {};
    const timeOrgFilter = scope.organizationId ? { organizationId: scope.organizationId } : {};

    // Server-side sorting: fetch the (filtered) id+sort-key set, compute
    // hours, sort in JS, then slice the page. This keeps pagination correct
    // for hour-based sorts that SQL can't express directly.
    const allMatching = await db.project.findMany({
      where,
      select: { id: true, name: true, createdAt: true, deadline: true },
      orderBy: { createdAt: 'desc' },
    });

    const hoursByProject = allMatching.length > 0
      ? await db.timeEntry.groupBy({
          by: ['projectId'],
          where: { projectId: { in: allMatching.map((p) => p.id) }, ...timeOrgFilter },
          _sum: { hours: true },
        })
      : [];
    const hoursMap = new Map(hoursByProject.map((h) => [h.projectId, h._sum.hours || 0]));

    const sorted = [...allMatching].sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name);
        case 'deadline': {
          if (!a.deadline && !b.deadline) return b.createdAt.getTime() - a.createdAt.getTime();
          if (!a.deadline) return 1; // no deadline last
          if (!b.deadline) return -1;
          const d = a.deadline.getTime() - b.deadline.getTime();
          return d !== 0 ? d : b.createdAt.getTime() - a.createdAt.getTime();
        }
        case 'hours_most': {
          const d = (hoursMap.get(b.id) || 0) - (hoursMap.get(a.id) || 0);
          return d !== 0 ? d : b.createdAt.getTime() - a.createdAt.getTime();
        }
        case 'hours_least': {
          const d = (hoursMap.get(a.id) || 0) - (hoursMap.get(b.id) || 0);
          return d !== 0 ? d : b.createdAt.getTime() - a.createdAt.getTime();
        }
        default: // newest
          return b.createdAt.getTime() - a.createdAt.getTime();
      }
    });

    const total = sorted.length;
    const pageIds = sorted.slice(skip, skip + pageSize).map((p) => p.id);

    const [projects, statusCounts, priorityCounts, totalMembers, uniqueMembers, totalHours, overdueCount, dailyAverageHours] =
      await Promise.all([
        pageIds.length > 0
          ? db.project.findMany({
              where: { id: { in: pageIds } },
              include: {
                department: { select: { id: true, name: true } },
                members: {
                  where: { leftAt: null },
                  select: {
                    id: true,
                    role: true,
                    employee: { select: { id: true, firstName: true, lastName: true, avatar: true } },
                  },
                },
                _count: { select: { members: true, timeEntries: true } },
              },
            })
          : Promise.resolve([]),
        db.project.groupBy({ by: ['status'], where: orgFilter, _count: { id: true } }),
        db.project.groupBy({ by: ['priority'], where: orgFilter, _count: { id: true } }),
        db.projectMember.count({ where: { leftAt: null, ...memberOrgFilter } }),
        db.projectMember.groupBy({
          by: ['employeeId'],
          where: { leftAt: null, ...memberOrgFilter },
          _count: { employeeId: true },
        }),
        db.timeEntry.aggregate({ where: timeOrgFilter, _sum: { hours: true } }),
        db.project.count({ where: { status: 'active', deadline: { lt: new Date() }, ...orgFilter } }),
        db.project.aggregate({ where: orgFilter, _min: { createdAt: true } }),
      ]);

    // Reorder the page to the server-side sorted id order.
    const orderIdx = new Map(pageIds.map((id, i) => [id, i]));
    projects.sort((a, b) => (orderIdx.get(a.id) ?? 0) - (orderIdx.get(b.id) ?? 0));

    const enrichedProjects = projects.map((p) => {
      const lead = p.members.find((m) => m.role === 'lead');
      return {
        ...p,
        memberCount: p._count.members,
        totalHours: hoursMap.get(p.id) || 0,
        lead: lead
          ? { id: lead.employee.id, name: `${lead.employee.firstName} ${lead.employee.lastName}`, avatar: lead.employee.avatar }
          : null,
        _count: undefined,
      };
    });

    const statusCountMap: Record<string, number> = {};
    statusCounts.forEach((s) => { statusCountMap[s.status] = s._count.id; });

    const priorityCountMap: Record<string, number> = {};
    priorityCounts.forEach((p) => { priorityCountMap[p.priority] = p._count.id; });

    const totalPages = Math.ceil(total / pageSize);

    // KPI cards are ORG-WIDE by design (independent of the active search/
    // filter — the filtered total is the paginated `total` below). Summing the
    // status counts is equivalent to a count over the same org filter.
    const orgTotalProjects = Object.values(statusCountMap).reduce((sum, n) => sum + n, 0);

    // "Days elapsed" for the per-day average; at least 1 so the value is
    // always defined (0 projects => 0 hours / 1 day = 0).
    const earliest = dailyAverageHours._min.createdAt;
    const daysElapsed = earliest
      ? Math.max(1, Math.ceil((Date.now() - earliest.getTime()) / 86_400_000))
      : 1;
    const totalHoursValue = totalHours._sum.hours || 0;

    return NextResponse.json({
      data: enrichedProjects,
      total,
      page,
      pageSize,
      totalPages,
      stats: {
        byStatus: statusCountMap,
        byPriority: priorityCountMap,
        totalProjects: orgTotalProjects,
        activeProjects: statusCountMap['active'] || 0,
        totalMembers,
        uniqueMembers: uniqueMembers.length,
        totalHours: totalHoursValue,
        dailyAverageHours: Math.round((totalHoursValue / daysElapsed) * 10) / 10,
        overdueCount,
      },
    });
  } catch (error) {
    log.error('api.projects.', { error: String('Projects GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch projects' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // Admin-only mutation; org derived from the session.
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const body = await req.json();
    const {
      name, description, status, priority, deadline,
      estimatedHours, color, budgetType, hourlyRate,
      departmentId, tags, startDate,
    } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Project name is required' }, { status: 400 });
    }
    const trimmedName = name.trim();
    if (trimmedName.length > MAX_NAME_LENGTH) {
      return NextResponse.json({ error: `Project name must be ${MAX_NAME_LENGTH} characters or fewer` }, { status: 422 });
    }

    const validation = validateProjectPayload({ name, description, status, priority, deadline, startDate, estimatedHours, color, budgetType, hourlyRate, tags });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }
    const v = validation.data;

    // Duplicate project names within the org are rejected (case-insensitive).
    const dup = await findDuplicateName(admin.organizationId, trimmedName);
    if (dup) {
      return NextResponse.json(
        { error: 'A project with this name already exists in your organization' },
        { status: 409 }
      );
    }

    // Cross-org validation: departmentId must belong to the caller's org.
    if (departmentId) {
      const dept = await db.department.findFirst({
        where: { id: departmentId, organizationId: admin.organizationId },
        select: { id: true },
      });
      if (!dept) {
        return NextResponse.json({ error: 'Department not found in your organization' }, { status: 422 });
      }
    }

    const project = await db.$transaction(async (tx) => {
      const created = await tx.project.create({
        data: {
          name: trimmedName,
          description: v.description === undefined ? null : v.description,
          status: v.status || 'active',
          priority: v.priority || 'medium',
          deadline: v.deadline,
          startDate: v.start,
          estimatedHours: v.estimatedHours ?? 0,
          color: v.color || '#10b981',
          budgetType: v.budgetType ?? null,
          hourlyRate: v.hourlyRate ?? null,
          departmentId: departmentId || null,
          tags: v.tags,
          organizationId: admin.organizationId,
        },
        include: { department: { select: { id: true, name: true } } },
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'project',
          resourceId: created.id,
          description: `Created project: ${created.name}`,
          userId: admin.userId,
          organizationId: admin.organizationId,
        },
      });

      return created;
    });

    return NextResponse.json({ data: project }, { status: 201 });
  } catch (error: unknown) {
    log.error('api.projects.', { error: String('Projects POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 });
  }
}
