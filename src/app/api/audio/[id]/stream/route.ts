import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdminOrg, authError } from '@/lib/api';
import { getAudio } from '@/lib/audio/storage';
import { isNotFound } from '@/lib/storage';
import { log, requestContext } from '@/lib/logger';

// GET /api/audio/[id]/stream
// Local-storage audio streaming endpoint — the counterpart of the Supabase
// signed-URL path returned by /api/audio/[id]/download. Authorization happens
// HERE at the stream boundary; the object itself is never addressable by a
// public URL:
//
//   - session auth (global middleware) + requireAdminOrg (admin role or above
//     in an organization),
//   - the recording row must belong to the CALLER's organization — a user from
//     another org (or an org-less super_admin) gets a concealing 404 even with
//     a valid guessed/leaked id,
//   - the physical object is read through the active storage driver under the
//     tenant-scoped key derived from the DB metadata (never from client input),
//   - a revoked employee/device or disabled recording still fails through the
//     org-scoped row lookup (no row → 404) plus the driver read (no object →
//     404),
//   - the response is nosniff and never uses the stored MIME blindly; the
//     stored mimeType is validated at upload time (allowlist) and is re-used
//     here only for Content-Type of an authorized tenant-owned object.
//
// No permanent or guessable URL is exposed: the id is an opaque cuid bound to
// the row, and every request re-derives ownership from the authenticated
// session + server-side records.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id } = await params;

    const recording = await db.audioRecording.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { filePath: true, fileName: true, mimeType: true, status: true },
    });
    if (!recording || !recording.filePath || recording.status !== 'completed') {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }

    let data: Buffer;
    try {
      // getAudio derives the tenant-scoped storage key from the DB filePath
      // basename (bucket audio/<orgId>/<uuid>.webm) — never from the request.
      data = await getAudio(admin.organizationId, recording.filePath);
    } catch (error) {
      if (isNotFound(error)) {
        return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
      }
      throw error;
    }

    const mimeType =
      typeof recording.mimeType === 'string' && recording.mimeType.length > 0
        ? recording.mimeType
        : 'application/octet-stream';
    const safeName = (recording.fileName || 'recording').replace(/["\r\n]/g, '_');

    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(data.length),
        'Content-Disposition': `inline; filename="${safeName}"`,
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    log.error('api.audio.id.stream.', { error: String('Audio stream error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
