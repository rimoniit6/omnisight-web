'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { artifactPath } from '@/lib/agent-software';
import { readFileSync } from 'node:fs';

// GET /api/agent-software/builds/[id]/download
// Download the built OmniSightAgent.exe installer for THIS organization
// (admin-only, org-scoped).
//
// Security:
//   - Requires an authenticated ORG-BOUND admin session; cross-org build ids
//     are indistinguishable from missing ones (404).
//   - The file path is derived from the DB record (fileName), never from user
//     input — no path traversal, no arbitrary filesystem access. The org id
//     and file name are sanitized to [A-Za-z0-9_-] in artifactPath().
//   - Artifacts live under uploads/agent-builds/ (never public/static).
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
      select: { id: true, status: true, fileName: true, serverUrl: true },
    });
    if (!build) {
      return NextResponse.json({ error: 'Build not found' }, { status: 404 });
    }
    if (build.status !== 'completed' || !build.fileName) {
      return NextResponse.json({ error: 'This build has no downloadable artifact' }, { status: 404 });
    }

    const filePath = artifactPath(admin.organizationId, build.fileName);
    let bytes: Buffer;
    try {
      bytes = readFileSync(filePath);
    } catch {
      return NextResponse.json({ error: 'Artifact is no longer available on this host' }, { status: 404 });
    }

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.microsoft.portable-executable',
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="OmniSightAgent-${build.id}.exe"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    console.error('Agent build download error:', error);
    return NextResponse.json({ error: 'Failed to download artifact' }, { status: 500 });
  }
}
