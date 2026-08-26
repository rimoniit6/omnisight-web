import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdminOrg, authError } from '@/lib/api';
import { getAudioSignedUrl } from '@/lib/audio/storage';

// GET /api/audio/[id]/download — download original audio file
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireAdminOrg(request);
    if (!admin.ok) return authError(admin);

    const { id } = await params;
    const recording = await db.audioRecording.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true, filePath: true, fileName: true, mimeType: true },
    });

    if (!recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }

    if (!recording.filePath) {
      return NextResponse.json({ error: 'Audio file not available' }, { status: 404 });
    }

    // Try signed URL first (Supabase)
    const signedUrl = await getAudioSignedUrl(admin.organizationId, recording.filePath);
    if (signedUrl) {
      return NextResponse.json({ url: signedUrl, fileName: recording.fileName, mimeType: recording.mimeType });
    }

    // Local storage: return the path for client-side download via a streaming endpoint
    return NextResponse.json({
      path: `/api/audio/${recording.id}/stream`,
      fileName: recording.fileName,
      mimeType: recording.mimeType,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
