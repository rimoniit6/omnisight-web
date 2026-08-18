import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { bumpPolicyVersion } from '@/lib/policies/version';

// DELETE /api/app-list/[id] — Remove app from whitelist/blacklist
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Admin-only mutation. Organization identity comes ONLY from the verified
    // session — never from client input.
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id } = await params;

    // Org ownership is part of the lookup boundary: cross-org and nonexistent
    // IDs are concealed identically (404), and produce ZERO mutations.
    const entry = await db.appListEntry.findFirst({
      where: {
        id,
        organizationId: admin.organizationId,
      },
      select: { id: true, appName: true, listType: true },
    });
    if (!entry) {
      return NextResponse.json({ error: 'App list entry not found' }, { status: 404 });
    }

    const updated = await db.$transaction(async (tx) => {
      const result = await tx.appListEntry.update({
        where: { id },
        data: { isActive: false },
      });

      // Policy version bump — same transaction as the write so the version
      // can never drift from the actual policy rows.
      await bumpPolicyVersion(tx, admin.organizationId);

      // Audit log — bound to the authenticated admin and organization.
      await tx.auditLog.create({
        data: {
          action: 'delete',
          resource: 'policy',
          resourceId: result.id,
          description: `Removed ${result.appName} from app ${result.listType}`,
          userId: admin.userId,
          organizationId: admin.organizationId,
        },
      });

      return result;
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    console.error('App list DELETE error:', error);
    return NextResponse.json({ error: 'Failed to remove app' }, { status: 500 });
  }
}