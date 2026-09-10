import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiSuccess, apiError, authError } from '@/lib/api';

// GET /api/super-admin/audit — platform security/audit overview (Phase 5 §23).
// Control-plane audit metadata only: action, resource, description, actor
// email, target organization, IP, timestamp. Never exposes passwords, tokens,
// API keys, database credentials, or raw request payloads (AuditLog.metadata
// is deliberately not serialized).
export async function GET(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return authError(admin);

    const { searchParams } = new URL(req.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '25', 10)));
    const action = searchParams.get('action') || '';

    const where: Record<string, unknown> = {};
    if (action) where.action = action;

    const [logs, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        include: {
          organization: { select: { id: true, name: true, slug: true, deploymentMode: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.auditLog.count({ where }),
    ]);

    // Actor emails via a separate lookup (AuditLog.userId has no relation).
    const userIds = Array.from(new Set(logs.map((l) => l.userId).filter((id): id is string => Boolean(id))));
    const users = userIds.length > 0
      ? await db.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    return apiSuccess({
      data: logs.map((l) => ({
        id: l.id,
        action: l.action,
        resource: l.resource,
        description: l.description,
        actorEmail: l.userId ? userById.get(l.userId)?.email ?? null : null,
        actorName: l.userId ? userById.get(l.userId)?.name ?? null : null,
        organization: l.organization
          ? { id: l.organization.id, name: l.organization.name, deploymentMode: l.organization.deploymentMode }
          : null,
        ipAddress: l.ipAddress,
        createdAt: l.createdAt.toISOString(),
      })),
      pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    });
  } catch {
    return apiError('Failed to load audit events', 500);
  }
}