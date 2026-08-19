'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg, requireSessionOrg } from '@/lib/api';
import { GUEST_PENDING_LIMIT_SETTING_KEY } from '@/lib/guests';

// GET /api/guests
// List guest enrollments for the caller's organization (admin session).
// Pending guests are represented by pending zero-touch DeviceClaims — they are
// listed through /api/device-claims?status=pending (a guest is only created as
// a row once an admin approves the claim in GUEST mode).
//
// Serves:
//   - status filter (ACTIVE | SUSPENDED | REJECTED | REVOKED | PENDING)
//   - ?summary=true — org-wide status counts (server-side groupBy)
//   - ?q= — org-scoped search over device name/hostname and the guest's
//     employeeId/email (case-insensitive)
//   - pagination (page/pageSize, clamped 1..100)
//
// Never exposes secrets: only device metadata + lifecycle timestamps.
//
// PUT /api/guests — update the org's guest enrollment pending limit (admin-only).
// Body: { guestPendingLimit: number }
// Validates the value, persists the OrganizationSetting, and produces an audit
// log entry. The limit gates GUEST-mode approval only — normal employee
// enrollment is never affected.

const GUEST_STATUSES = ['PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'REVOKED'] as const;

export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { searchParams } = new URL(req.url);
    const rawStatus = searchParams.get('status');
    const status = rawStatus && (GUEST_STATUSES as readonly string[]).includes(rawStatus) ? rawStatus : null;
    const parsePageNumber = (value: string | null, fallback: number) => {
      const parsed = Number.parseInt(value ?? '', 10);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const page = Math.max(1, parsePageNumber(searchParams.get('page'), 1));
    const pageSize = Math.min(100, Math.max(1, parsePageNumber(searchParams.get('pageSize'), 20)));
    const q = (searchParams.get('q') ?? '').trim().slice(0, 100);
    const wantSummary = searchParams.get('summary') === 'true';

    const emptySummary = { PENDING: 0, ACTIVE: 0, SUSPENDED: 0, REJECTED: 0, REVOKED: 0 };

    // Org-less super-admin: no business data to list (consistent with the
    // org-less device-claims page). Mutations are org-bound.
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

    const where: Record<string, unknown> = { organizationId: scope.organizationId };
    if (status) where.status = status;
    if (q) {
      where.OR = [
        { device: { name: { contains: q, mode: 'insensitive' } } },
        { device: { hostname: { contains: q, mode: 'insensitive' } } },
        { employee: { employeeId: { contains: q, mode: 'insensitive' } } },
        { employee: { email: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [guests, total, summaryRows] = await Promise.all([
      db.guest.findMany({
        where,
        include: {
          device: {
            select: {
              id: true,
              name: true,
              hostname: true,
              operatingSystem: true,
              osVersion: true,
              processor: true,
              memory: true,
              agentVersion: true,
              ipAddress: true,
              status: true,
              lastHeartbeat: true,
              registeredAt: true,
            },
          },
          employee: {
            select: {
              id: true,
              employeeId: true,
              firstName: true,
              lastName: true,
              email: true,
              status: true,
              type: true,
            },
          },
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.guest.count({ where }),
      wantSummary
        ? db.guest.groupBy({
            by: ['status'],
            where: { organizationId: scope.organizationId },
            _count: { _all: true },
          })
        : Promise.resolve([] as Array<{ status: string; _count: { _all: number } }>),
    ]);

    const summary: Record<string, number> = { ...emptySummary };
    for (const row of summaryRows) {
      if (row.status in summary) summary[row.status] = row._count._all;
    }

    return NextResponse.json({
      data: guests.map((g) => ({
        id: g.id,
        deviceId: g.deviceId,
        employeeId: g.employeeId,
        status: g.status,
        approvedAt: g.approvedAt,
        approvedBy: g.approvedBy,
        rejectedAt: g.rejectedAt,
        rejectedBy: g.rejectedBy,
        revokedAt: g.revokedAt,
        revokedBy: g.revokedBy,
        suspendedAt: g.suspendedAt,
        suspendedBy: g.suspendedBy,
        createdAt: g.createdAt,
        updatedAt: g.updatedAt,
        device: g.device,
        employee: g.employee,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      ...(wantSummary ? { summary } : {}),
    });
  } catch (error) {
    console.error('Guests GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch guests' }, { status: 500 });
  }
}

// PUT /api/guests — update the org's guest enrollment pending limit.
// Admin-only, org-scoped, validated, audited.
export async function PUT(req: NextRequest) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const body = await req.json().catch(() => ({})) as { guestPendingLimit?: unknown };

    if (body.guestPendingLimit === undefined || body.guestPendingLimit === null) {
      return NextResponse.json({ error: 'guestPendingLimit is required' }, { status: 422 });
    }

    const n = Number(body.guestPendingLimit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      return NextResponse.json({ error: 'Enter a whole number between 1 and 1000.' }, { status: 422 });
    }

    // Read old value for audit log
    const oldSetting = await db.organizationSetting.findUnique({
      where: { organizationId_key: { organizationId: admin.organizationId, key: GUEST_PENDING_LIMIT_SETTING_KEY } },
    });
    const oldValue = oldSetting ? Number.parseInt(oldSetting.value, 10) : 20;

    await db.organizationSetting.upsert({
      where: { organizationId_key: { organizationId: admin.organizationId, key: GUEST_PENDING_LIMIT_SETTING_KEY } },
      update: { value: String(n), category: 'agent' },
      create: { organizationId: admin.organizationId, key: GUEST_PENDING_LIMIT_SETTING_KEY, value: String(n), category: 'agent' },
    });

    // Audit log for guest pending limit change
    await db.auditLog.create({
      data: {
        action: 'guest_pending_limit_updated',
        resource: 'settings',
        resourceId: admin.organizationId,
        description: `Guest enrollment limit changed from ${oldValue} to ${n}`,
        userId: admin.userId,
        ipAddress: req.headers.get('x-real-ip') ?? undefined,
        organizationId: admin.organizationId,
      },
    });

    // Return current state
    const guestPendingCount = await db.guest.count({
      where: { organizationId: admin.organizationId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
    });
    const remaining = Math.max(0, n - guestPendingCount);

    return NextResponse.json({
      success: true,
      guestPendingLimit: n,
      pendingGuestCount: guestPendingCount,
      remaining,
    });
  } catch (error) {
    console.error('Guests PUT error:', error);
    return NextResponse.json({ error: 'Could not update the guest enrollment limit.' }, { status: 500 });
  }
}
