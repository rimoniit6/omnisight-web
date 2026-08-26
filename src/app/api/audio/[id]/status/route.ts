import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdminOrg, authError } from '@/lib/api';
import { recordingProgress, type RecordingStatus } from '@/lib/audio/types';

// GET /api/audio/[id]/status — poll processing status
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
      select: {
        id: true,
        status: true,
        retryCount: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }

    const progress = recordingProgress(recording.status as RecordingStatus);

    return NextResponse.json({
      id: recording.id,
      status: recording.status,
      progress,
      retryCount: recording.retryCount,
      errorMessage: recording.errorMessage,
      createdAt: recording.createdAt,
      updatedAt: recording.updatedAt,
    });
  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
