import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';

/**
 * POST /api/projects/[id]/restore
 *
 * Restore an archived (cancelled) project back to active status. Admin-only,
 * org-scoped, preserves all members/time-entries/history, and is audited.
 * Uses the existing status enum — no new status is invented.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id } = await params;

    // Project must belong to the caller's org; cross-org ids -> 404.
    const existing = await db.project.findFirst({
      where: { id, organizationId: admin.organizationId },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Only cancelled (archived) projects can be restored.
    if (existing.status !== 'cancelled') {
      return NextResponse.json(
        { error: 'Only archived (cancelled) projects can be restored' },
        { status: 409 }
      );
    }

    const project = await db.project.update({
      where: { id },
      data: { status: 'active' },
      include: {
        department: { select: { id: true, name: true } },
        organization: { select: { id: true, name: true } },
      },
    });

    // Audit log
    await db.auditLog.create({
      data: {
        action: 'update',
        resource: 'project',
        resourceId: id,
        description: `Restored archived project "${existing.name}" (status set to active)`,
        userId: admin.userId,
        organizationId: existing.organizationId,
      },
    });

    return NextResponse.json({ data: project, message: 'Project restored' });
  } catch (error) {
    console.error('Project restore POST error:', error);
    return NextResponse.json({ error: 'Failed to restore project' }, { status: 500 });
  }
}
