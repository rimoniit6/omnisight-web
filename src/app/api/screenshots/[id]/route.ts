import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';
import { getClientIp } from '@/lib/agent/auth';
import { deleteScreenshot, isNotFound } from '@/lib/storage';

// GET /api/screenshots/[id] — single screenshot with full details
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Tenant isolation: cross-org screenshot detail access is concealed (404).
    const scope = await requireSessionOrg(req);
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const { id } = await params;
    const screenshot = await db.screenshot.findFirst({
      where: { id, organizationId: scope.organizationId },
      include: {
        employee: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            employeeId: true,
            avatar: true,
            designation: true,
            department: { select: { name: true } },
          },
        },
        device: { select: { id: true, name: true, hostname: true, status: true } },
      },
    });

    if (!screenshot) {
      return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
    }

    return NextResponse.json(screenshot);
  } catch (error) {
    console.error('Screenshot detail error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/screenshots/[id]
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Admin-only mutation; the screenshot must belong to the caller's org.
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id } = await params;
    const screenshot = await db.screenshot.findFirst({
      where: { id, organizationId: admin.organizationId },
    });

    if (!screenshot) {
      return NextResponse.json({ error: 'Screenshot not found' }, { status: 404 });
    }

    // Try to delete the stored object through the active storage driver
    // (local filesystem, or Supabase Storage on Vercel). A missing object or
    // an absent filePath (nothing stored) is treated as already deleted —
    // the DB row is still removed.
    if (screenshot.filePath) {
      try {
        await deleteScreenshot(admin.organizationId, screenshot.filePath);
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }

    // Delete the DB record AND write the audit log atomically: a failed
    // deletion rolls back the audit row too, so a success audit record is
    // never created unless the deletion itself succeeded.
    await db.$transaction(async (tx) => {
      await tx.screenshot.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          action: 'delete',
          resource: 'screenshot',
          resourceId: screenshot.id,
          description: `Screenshot ${screenshot.id} deleted`,
          userId: admin.userId,
          ipAddress: getClientIp(req),
          organizationId: admin.organizationId,
        },
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Screenshot delete error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
