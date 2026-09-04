'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';
import { EMPLOYEE_ONLINE_THRESHOLD_MS, LIFECYCLE_PINNED_STATUSES } from '@/lib/presence';
import { createOrgNotification } from '@/lib/notifications/service';
import { log, requestContext } from '@/lib/logger';

// ─── Query parameter contracts ────────────────────────────────────────────
// Only enum values that actually exist in the schema are accepted. Anything
// else is rejected with 400 — never silently ignored and never passed to the DB.

const EMPLOYEE_STATUSES = ['active', 'inactive', 'archived'] as const;
const EMPLOYEE_ROLES = ['manager', 'employee'] as const;
const DEVICE_STATUSES = ['online', 'offline', 'no_device'] as const;
const SORT_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'designation',
  'status',
  'joinDate',
  'createdAt',
  'department.name',
  'organization.name',
  'name',
] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SEARCH_LENGTH = 100;

/** Parse an integer param with a valid range. Returns null when invalid. */
function parseIntParam(value: string | null, fallback: number, max: number): number | null {
  if (value === null || value === '') return fallback;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

/** Parse a YYYY-MM-DD date param into a valid Date, or null when invalid. */
function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  if (!DATE_RE.test(value)) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export async function GET(req: NextRequest) {
  try {
    // Hard requirement: a valid session is mandatory. Without one the list is
    // never returned (previously it leaked every organization's employees).
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { searchParams } = new URL(req.url);

    // ── Pagination (validated server-side) ────────────────────────────────
    // `limit` is accepted as a legacy alias for pageSize.
    const page = parseIntParam(searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER);
    const pageSize = parseIntParam(
      searchParams.get('pageSize') ?? searchParams.get('limit'),
      20,
      500
    );
    if (page === null || pageSize === null) {
      return NextResponse.json(
        { error: 'Invalid page or pageSize parameter. Must be a positive integer.' },
        { status: 400 }
      );
    }
    const skip = (page - 1) * pageSize;

    // ── Search ─────────────────────────────────────────────────────────────
    const search = (searchParams.get('search') || '').trim().slice(0, MAX_SEARCH_LENGTH);

    // ── Status ─────────────────────────────────────────────────────────────
    const rawStatus = (searchParams.get('status') || '').trim().toLowerCase();
    if (rawStatus && !(EMPLOYEE_STATUSES as readonly string[]).includes(rawStatus)) {
      return NextResponse.json({ error: `Invalid status. Allowed: ${EMPLOYEE_STATUSES.join(', ')}` }, { status: 400 });
    }
    const status = (rawStatus || null) as (typeof EMPLOYEE_STATUSES)[number] | null;

    // ── Role (manager/employee, derived from the department-manager relation) ──
    const role = (searchParams.get('role') || '').trim().toLowerCase();
    if (role && !(EMPLOYEE_ROLES as readonly string[]).includes(role)) {
      return NextResponse.json({ error: `Invalid role. Allowed: ${EMPLOYEE_ROLES.join(', ')}` }, { status: 400 });
    }

    // ── Device status ──────────────────────────────────────────────────────
    const deviceStatus = (searchParams.get('deviceStatus') || '')
      .trim()
      .toLowerCase()
      .replace('-', '_');
    if (deviceStatus && !(DEVICE_STATUSES as readonly string[]).includes(deviceStatus)) {
      return NextResponse.json({ error: `Invalid deviceStatus. Allowed: ${DEVICE_STATUSES.join(', ')}` }, { status: 400 });
    }

    // ── Created date range ─────────────────────────────────────────────────
    const createdFrom = parseDateParam(searchParams.get('createdFrom'));
    const createdTo = parseDateParam(searchParams.get('createdTo'));
    if ((searchParams.get('createdFrom') && !createdFrom) || (searchParams.get('createdTo') && !createdTo)) {
      return NextResponse.json(
        { error: 'Invalid createdFrom/createdTo. Use YYYY-MM-DD.' },
        { status: 400 }
      );
    }

    // ── Sorting ────────────────────────────────────────────────────────────
    const sortBy = (searchParams.get('sortBy') || '').trim();
    if (sortBy && !(SORT_FIELDS as readonly string[]).includes(sortBy)) {
      return NextResponse.json({ error: `Invalid sortBy. Allowed: ${SORT_FIELDS.join(', ')}` }, { status: 400 });
    }
    const rawOrder = (searchParams.get('sortOrder') || 'asc').trim().toLowerCase();
    const direction: 'asc' | 'desc' | null = rawOrder === 'desc' ? 'desc' : rawOrder === 'asc' ? 'asc' : null;
    if (!direction) {
      return NextResponse.json({ error: 'Invalid sortOrder. Allowed: asc, desc' }, { status: 400 });
    }

    // ── Tenant scoping ─────────────────────────────────────────────────────
    // Tenant identity always comes from the session. The organizationId param
    // is honored ONLY for org-less global super_admins; org-bound sessions are
    // always pinned to their own organization regardless of the param.
    // If an explicit organizationId query param is provided that differs from
    // the session's active org, reject with 403 (cross-org access denied).
    const where: Prisma.EmployeeWhereInput = {};
    if (scope.organizationId) {
      const explicitOrgId = searchParams.get('organizationId');
      if (explicitOrgId && explicitOrgId !== scope.organizationId) {
        return NextResponse.json({ error: 'Cross-organization access denied' }, { status: 403 });
      }
      where.organizationId = scope.organizationId;
    } else {
      // Phase 2 privacy: org-less global super_admins may target an explicit
      // organization ONLY when it is MANAGED. CUSTOMER_DB / PRIVATE orgs are
      // rejected — operational data there is never reachable from the console.
      const orgParam = searchParams.get('organizationId');
      if (orgParam) {
        const org = await db.organization.findUnique({
          where: { id: orgParam },
          select: { id: true, deploymentMode: true },
        });
        if (!org) {
          return NextResponse.json({ error: 'Organization not found' }, { status: 400 });
        }
        if (org.deploymentMode !== 'MANAGED') {
          return NextResponse.json(
            { error: 'Operational data for customer-owned organizations is not accessible from the Super Admin console', code: 'TENANT_ACCESS_DENIED_FOR_MODE' },
            { status: 403 },
          );
        }
        where.organizationId = orgParam;
      }
    }

    // Archived employees are hidden by default (existing behavior); selecting
    // the "archived" status explicitly opts into seeing them.
    if (!status) {
      where.status = { not: 'archived' };
    } else {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { email: { contains: search } },
        { employeeId: { contains: search } },
      ];
    }

    // ── Department (resolved within the caller's org) ──────────────────────
    const departmentId = (searchParams.get('departmentId') || '').trim();
    const departmentName = (searchParams.get('department') || '').trim();
    if (departmentId) {
      const dept = await db.department.findFirst({
        where: {
          id: departmentId,
          ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
        },
        select: { id: true },
      });
      if (!dept) {
        return NextResponse.json({ error: 'Department not found in your organization' }, { status: 400 });
      }
      where.departmentId = departmentId;
    } else if (departmentName) {
      const dept = await db.department.findFirst({
        where: {
          name: departmentName,
          ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
        },
        select: { id: true },
      });
      if (dept) where.departmentId = dept.id;
    }

    // ── Role: department managers vs everyone else ─────────────────────────
    if (role === 'manager') {
      where.departmentAsManager = { some: {} };
    } else if (role === 'employee') {
      where.departmentAsManager = { none: {} };
    }

    // ── Device status (live: heartbeat freshness, not the sticky column) ──
    // 'online' = at least one non-lifecycle device with a heartbeat inside the
    // centralized presence window. 'offline' = has devices, none of them live.
    const presenceCutoff = new Date(Date.now() - EMPLOYEE_ONLINE_THRESHOLD_MS);
    if (deviceStatus === 'online') {
      where.devices = {
        some: {
          status: { notIn: [...LIFECYCLE_PINNED_STATUSES] },
          lastHeartbeat: { gt: presenceCutoff },
        },
      };
    } else if (deviceStatus === 'offline') {
      // Has at least one device, but none currently online.
      where.AND = [
        { devices: { some: {} } },
        {
          devices: {
            none: {
              status: { notIn: [...LIFECYCLE_PINNED_STATUSES] },
              lastHeartbeat: { gt: presenceCutoff },
            },
          },
        },
      ];
    } else if (deviceStatus === 'no_device') {
      where.devices = { none: {} };
    }

    // ── Created date range ─────────────────────────────────────────────────
    if (createdFrom || createdTo) {
      where.createdAt = {};
      if (createdFrom) where.createdAt.gte = new Date(`${createdFrom.toISOString().slice(0, 10)}T00:00:00.000Z`);
      if (createdTo) where.createdAt.lte = new Date(`${createdTo.toISOString().slice(0, 10)}T23:59:59.999Z`);
    }

    // ── Ordering ───────────────────────────────────────────────────────────
    let orderBy: Prisma.EmployeeOrderByWithRelationInput | Prisma.EmployeeOrderByWithRelationInput[] = { createdAt: 'desc' };
    if (sortBy) {
      if (sortBy === 'department.name') {
        orderBy = { department: { name: direction } };
      } else if (sortBy === 'organization.name') {
        orderBy = { organization: { name: direction } };
      } else if (sortBy === 'name') {
        orderBy = [{ firstName: direction }, { lastName: direction }];
      } else {
        orderBy = { [sortBy]: direction };
      }
    }

    // Records + total count run in parallel — no N+1, no sequential awaits.
    const [employees, total, activeCount, inactiveCount] = await Promise.all([
      db.employee.findMany({
        where,
        include: {
          department: { select: { id: true, name: true } },
          devices: {
            where: { status: { in: ['online', 'offline'] } },
            select: { id: true, name: true, status: true, lastHeartbeat: true },
          },
        },
        orderBy,
        skip,
        take: pageSize,
      }),
      db.employee.count({ where }),
      db.employee.count({ where: { ...where, status: 'active' } }),
      db.employee.count({ where: { ...where, status: 'inactive' } }),
    ]);

    const totalPages = Math.ceil(total / pageSize);

    // Never expose agent credentials to the web app
    const safeEmployees = employees.map(({ agentPassword: _agentPassword, ...rest }) => rest);

    return NextResponse.json({
      data: safeEmployees,
      total,
      page,
      pageSize,
      totalPages,
      activeCount,
      inactiveCount,
      pagination: { page, pageSize, total, totalPages },
    });
  } catch (error) {
    log.error('api.employees.', { error: String('Employees GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch employees' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // Admin-only mutation; org derived from the session — never the client.
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const body = await req.json();
    const { firstName, lastName, email, phone, designation, departmentId, employeeId, joinDate } = body;

    if (!firstName || !lastName || !email || !employeeId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
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

    const employee = await db.employee.create({
      data: {
        firstName,
        lastName,
        email,
        phone,
        designation,
        departmentId: departmentId || null,
        employeeId,
        joinDate: joinDate ? new Date(joinDate) : null,
        organizationId: admin.organizationId,
      },
      include: { department: { select: { id: true, name: true } } },
    });

    // Never expose agent credentials to the web app
    const { agentPassword: _agentPassword, ...safeEmployee } = employee;

    // Real `new_employee` notification producer (N-6): a genuine trigger —
    // an employee was actually created — with structured employee linkage.
    await createOrgNotification(db, {
      title: `New Employee: ${firstName} ${lastName}`,
      message: `${firstName} ${lastName} (${employeeId}) joined the organization.`,
      type: 'new_employee',
      priority: 'low',
      status: 'unread',
      actionUrl: '/employees',
      entityType: 'employee',
      entityId: employee.id,
      employeeId: employee.id,
      organizationId: admin.organizationId,
    });

    return NextResponse.json({ data: safeEmployee }, { status: 201 });
  } catch (error: unknown) {
    log.error('api.employees.', { error: String('Employees POST error:') }, requestContext(req));
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json({ error: 'Employee ID or email already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to create employee' }, { status: 500 });
  }
}
