'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';

// GET /api/agent-software/builds/[id]
// Fetch one build record (admin-only, org-scoped — cross-org ids are
// indistinguishable from missing ones → 404).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id } = await params;
    const build = await db.agentBuild.findFirst({
      where: { id, organizationId: admin.organizationId },
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
    });
    if (!build) {
      return NextResponse.json({ error: 'Build not found' }, { status: 404 });
    }
    return NextResponse.json({ data: build });
  } catch (error) {
    console.error('Agent build GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch build' }, { status: 500 });
  }
}
