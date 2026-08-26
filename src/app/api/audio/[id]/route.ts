import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdminOrg, authError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { deleteAudio, audioKeyFromPath } from '@/lib/audio/storage';

// GET /api/audio/[id] — single recording with full details
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
      include: {
        employee: {
          select: { id: true, firstName: true, lastName: true, employeeId: true, avatar: true },
        },
        device: { select: { id: true, name: true, hostname: true, status: true } },
        transcription: true,
      },
    });

    if (!recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }

    return NextResponse.json(recording);
  } catch (error) {
    log.error('api.audio.detail', { error: String(error) }, requestContext(request));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// DELETE /api/audio/[id] — delete recording + transcription + stored file
export async function DELETE(
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

    // Delete stored file (best-effort — don't fail the whole operation if the file is already gone)
    if (recording.filePath) {
      try {
        await deleteAudio(admin.organizationId, recording.filePath);
      } catch {
        // File may already be deleted — continue with DB cleanup
      }
    }

    // Delete DB records atomically (transcription is cascade-deleted with recording)
    await db.$transaction(async (tx) => {
      await tx.audioRecording.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          action: 'delete',
          resource: 'audio_recording',
          resourceId: recording.id,
          description: `Audio recording deleted: ${recording.fileName}`,
          userId: admin.userId,
          organizationId: admin.organizationId,
        },
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('api.audio.delete', { error: String(error) }, requestContext(request));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
