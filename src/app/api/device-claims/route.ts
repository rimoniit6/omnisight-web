'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, SAFE_EMPLOYEE_SELECT } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/device-claims
// List device claims for the caller's organization (admin session).
// Pending claims are what the Admin "Pending Devices" workflow consumes.
// Also serves:
//   - ?summary=true — org-wide status counts (server-side groupBy, not a
//     first-page projection) so the approvals page stats can never disagree
//     with the actual queue.
//   - ?q= — org-scoped search over device name/hostname and the bound
//     employee's names (case-insensitive).
//   - Lazy expiry transition (no scheduler needed): any `pending` claim past
//     its redemption window is flipped to `expired` here on read, so the queue
//     always shows the real state. Idempotent, org-scoped, and a re-registering
//     device always creates a FRESH claim (it is never resurrected).
export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const parsePageNumber = (value: string | null, fallback: number) => {
      const parsed = Number.parseInt(value ?? '', 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const page = Math.max(1, parsePageNumber(searchParams.get('page'), 1));
    const pageSize = Math.min(100, Math.max(1, parsePageNumber(searchParams.get('pageSize'), 20)));
    const q = (searchParams.get('q') ?? '').trim().slice(0, 100);
    const wantSummary = searchParams.get('summary') === 'true';

    const emptySummary = { pending: 0, approved: 0, rejected: 0, revoked: 0, cancelled: 0, expired: 0 };

    // Org-less super-admin: no business data to list — return an empty page
    // (consistent with the org-less dashboard). Mutations are already
    // org-bound, so nothing can leak across tenants.
    if (!scope.organizationId) {
      return NextResponse.json({
        data: [],
        total: 0,
        page,
        pageSize,
        totalPages: 0,
        ...(wantSummary ? { summary: emptySummary } : {}),
      });
    }

    // Lazy expiry transition — see the doc comment above.
    await db.deviceClaim.updateMany({
      where: {
        organizationId: scope.organizationId,
        status: 'pending',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'expired' },
    });

    const where: Record<string, unknown> = { organizationId: scope.organizationId };
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { device: { name: { contains: q, mode: 'insensitive' } } },
        { device: { hostname: { contains: q, mode: 'insensitive' } } },
        { employee: { firstName: { contains: q, mode: 'insensitive' } } },
        { employee: { lastName: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [claims, total, summaryRows] = await Promise.all([
      db.deviceClaim.findMany({
        where,
        // Never include full employee rows — they carry agentPassword.
        include: {
          device: {
            include: {
              employee: { select: SAFE_EMPLOYEE_SELECT },
            },
          },
          employee: { select: SAFE_EMPLOYEE_SELECT },
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.deviceClaim.count({ where }),
      wantSummary
        ? db.deviceClaim.groupBy({
            by: ['status'],
            where: { organizationId: scope.organizationId },
            _count: { _all: true },
          })
        : Promise.resolve([] as Array<{ status: string; _count: { _all: number } }>),
    ]);

    // Resolve the assigned projects for each claim's bound employee (B-10:
    // Device → Employee → Department → Projects, all via existing relations).
    const employeeIds = [...new Set(claims.map((c) => c.employeeId).filter(Boolean))] as string[];
    const memberships = employeeIds.length
      ? await db.projectMember.findMany({
          where: { employeeId: { in: employeeIds } },
          include: { project: { select: { id: true, name: true, status: true, color: true } } },
        })
      : [];
    const membersByEmployee = new Map<string, typeof memberships>();
    for (const m of memberships) {
      const list = membersByEmployee.get(m.employeeId) ?? [];
      list.push(m);
      membersByEmployee.set(m.employeeId, list);
    }

    const data = claims.map((c) => {
      return {
        id: c.id,
        deviceId: c.deviceId,
        status: c.status,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        expiresAt: c.expiresAt,
        approvedAt: c.approvedAt,
        rejectedAt: c.rejectedAt,
        rejectionReason: c.rejectionReason,
        approvedBy: c.approvedBy,
        cancelledAt: c.cancelledAt,
        cancellationReason: c.cancellationReason,
        device: {
          id: c.device.id,
          name: c.device.name,
          hostname: c.device.hostname,
          operatingSystem: c.device.operatingSystem,
          osVersion: c.device.osVersion,
          processor: c.device.processor,
          memory: c.device.memory,
          agentVersion: c.device.agentVersion,
          status: c.device.status,
          lastHeartbeat: c.device.lastHeartbeat,
          registeredAt: c.device.registeredAt,
          employeeId: c.device.employeeId,
        },
        // Assignment data (server-derived, existing relations only):
        employee: c.employee
          ? {
              id: c.employee.id,
              employeeId: c.employee.employeeId,
              firstName: c.employee.firstName,
              lastName: c.employee.lastName,
              email: c.employee.email,
              status: c.employee.status,
              departmentId: c.employee.departmentId,
              department: c.employee.department
                ? { id: c.employee.department.id, name: c.employee.department.name }
                : null,
            }
          : c.device.employee
            ? {
                id: c.device.employee.id,
                employeeId: c.device.employee.employeeId,
                firstName: c.device.employee.firstName,
                lastName: c.device.employee.lastName,
                email: c.device.employee.email,
                status: c.device.employee.status,
                departmentId: c.device.employee.departmentId,
                department: c.device.employee.department
                  ? { id: c.device.employee.department.id, name: c.device.employee.department.name }
                  : null,
              }
            : null,
        projects: c.employeeId
          ? (membersByEmployee.get(c.employeeId) ?? []).map((m) => ({
              id: m.project.id,
              name: m.project.name,
              status: m.project.status,
              color: m.project.color,
              role: m.role,
            }))
          : [],
      };
    });

    const totalPages = Math.ceil(total / pageSize);
    const summary: Record<string, number> = { ...emptySummary };
    for (const row of summaryRows) {
      if (row.status in summary) summary[row.status] = row._count._all;
    }
    return NextResponse.json({
      data,
      total,
      page,
      pageSize,
      totalPages,
      ...(wantSummary ? { summary } : {}),
    });
  } catch (error) {
    log.error('api.device-claims.', { error: String('DeviceClaims GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch device claims' }, { status: 500 });
  }
}
