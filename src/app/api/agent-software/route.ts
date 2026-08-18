'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import {
  resolveAgentSoftwareConfig,
  saveAgentServerUrl,
} from '@/lib/agent-software';
import { GUEST_PENDING_LIMIT_SETTING_KEY } from '@/lib/guests';

// GET /api/agent-software
// Org-scoped agent software configuration + recent build metadata (admin-only).
// Never exposes the enrollment code itself — only whether enrollment is
// enabled and whether the last build baked a code.
export async function GET(req: NextRequest) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const [config, lastBuild, recentBuilds, guestPendingCount] = await Promise.all([
      resolveAgentSoftwareConfig(admin.organizationId),
      db.agentBuild.findFirst({
        where: { organizationId: admin.organizationId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          serverUrl: true,
          enrollmentCodeBaked: true,
          agentVersion: true,
          status: true,
          sha256: true,
          fileName: true,
          error: true,
          requestedBy: true,
          startedAt: true,
          completedAt: true,
          createdAt: true,
        },
      }),
      db.agentBuild.findMany({
        where: { organizationId: admin.organizationId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          serverUrl: true,
          enrollmentCodeBaked: true,
          agentVersion: true,
          status: true,
          sha256: true,
          fileName: true,
          error: true,
          createdAt: true,
          completedAt: true,
        },
      }),
      db.guest.count({
        where: { organizationId: admin.organizationId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
      }),
    ]);

    const pendingGuestLimit = config.guestPendingLimit;
    const remaining = Math.max(0, pendingGuestLimit - guestPendingCount);

    return NextResponse.json({
      config: {
        ...config,
        pendingGuestCount: guestPendingCount,
        remaining,
      },
      lastBuild,
      builds: recentBuilds,
    });
  } catch (error) {
    console.error('Agent software GET error:', error);
    return NextResponse.json({ error: 'Failed to load agent software configuration' }, { status: 500 });
  }
}

// PUT /api/agent-software
// Persist the org's agent software configuration (validated, org-scoped,
// audited). Body: { serverUrl?: string, guestPendingLimit?: number }.
export async function PUT(req: NextRequest) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const body = await req.json().catch(() => ({})) as { serverUrl?: unknown; guestPendingLimit?: unknown };
    const descriptions: string[] = [];

    if (body.serverUrl !== undefined && body.serverUrl !== null && body.serverUrl !== '') {
      const saved = await saveAgentServerUrl(admin.organizationId, body.serverUrl);
      if (!saved.ok) {
        return NextResponse.json({ error: saved.error }, { status: 422 });
      }
      descriptions.push('server URL');
    }

    if (body.guestPendingLimit !== undefined && body.guestPendingLimit !== null) {
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
      descriptions.push(`pending guest limit ${n}`);

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
    }

    if (descriptions.length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 422 });
    }

    // Single audit log for all other changes (server URL)
    if (descriptions.some(d => d !== `pending guest limit ${body.guestPendingLimit}`)) {
      await db.auditLog.create({
        data: {
          action: 'configure',
          resource: 'settings',
          resourceId: admin.organizationId,
          description: `Agent software configuration updated: ${descriptions.filter(d => !d.startsWith('pending guest limit')).join(', ')}`,
          userId: admin.userId,
          ipAddress: req.headers.get('x-real-ip') ?? undefined,
          organizationId: admin.organizationId,
        },
      });
    }

    const config = await resolveAgentSoftwareConfig(admin.organizationId);
    const guestPendingCount = await db.guest.count({
      where: { organizationId: admin.organizationId, status: { in: ['ACTIVE', 'SUSPENDED'] } },
    });
    const remaining = Math.max(0, config.guestPendingLimit - guestPendingCount);

    return NextResponse.json({
      success: true,
      config: {
        ...config,
        pendingGuestCount: guestPendingCount,
        remaining,
      },
    });
  } catch (error) {
    console.error('Agent software PUT error:', error);
    return NextResponse.json({ error: 'Could not update the guest enrollment limit.' }, { status: 500 });
  }
}

