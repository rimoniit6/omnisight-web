import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdminOrg, authError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { MAX_AUDIO_RETRIES } from '@/lib/audio/types';

// POST /api/audio/[id]/retry — retry a failed transcription
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const admin = await requireAdminOrg(request);
    if (!admin.ok) return authError(admin);

    const { id } = await params;
    const recording = await db.audioRecording.findFirst({
      where: { id, organizationId: admin.organizationId },
    });

    if (!recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }

    // Only failed recordings can be retried
    if (recording.status !== 'failed') {
      return NextResponse.json(
        { error: `Cannot retry a recording with status "${recording.status}". Only failed recordings can be retried.` },
        { status: 422 },
      );
    }

    // Enforce retry limit
    if (recording.retryCount >= MAX_AUDIO_RETRIES) {
      return NextResponse.json(
        { error: `Maximum retry attempts (${MAX_AUDIO_RETRIES}) exceeded.` },
        { status: 422 },
      );
    }

    // Prevent duplicate retry if already queued
    const pendingJob = await db.jobRun.findUnique({ where: { job: `audio_transcribe:${id}` } });
    if (pendingJob && pendingJob.status === 'running') {
      return NextResponse.json(
        { error: 'Transcription is already in progress.' },
        { status: 409 },
      );
    }

    // Reset state for retry
    await db.audioRecording.update({
      where: { id },
      data: {
        status: 'queued',
        errorMessage: null,
      },
    });

    // Delete old transcription if exists
    await db.audioTranscription.deleteMany({ where: { recordingId: id } });

    await db.auditLog.create({
      data: {
        action: 'update',
        resource: 'audio_recording',
        resourceId: id,
        description: `Audio transcription retry initiated (attempt ${recording.retryCount + 1}/${MAX_AUDIO_RETRIES})`,
        userId: admin.userId,
        organizationId: admin.organizationId,
      },
    });

    return NextResponse.json({
      success: true,
      status: 'queued',
      retryCount: recording.retryCount + 1,
    });
  } catch (error) {
    log.error('api.audio.retry', { error: String(error) }, requestContext(request));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
