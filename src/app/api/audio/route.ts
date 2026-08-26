import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdminOrg, authError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { putAudio, generateAudioFilename } from '@/lib/audio/storage';
import {
  ALLOWED_AUDIO_MIME_TYPES,
  MAX_AUDIO_FILE_SIZE,
  isAllowedAudioMime,
  type RecordingStatus,
} from '@/lib/audio/types';

// POST /api/audio — upload an audio file for transcription
export async function POST(request: NextRequest) {
  try {
    const admin = await requireAdminOrg(request);
    if (!admin.ok) return authError(admin);

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const employeeId = formData.get('employeeId') as string | null;
    const deviceId = formData.get('deviceId') as string | null;

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 422 });
    }

    // Validate MIME type
    if (!isAllowedAudioMime(file.type)) {
      return NextResponse.json(
        { error: `Invalid file type: ${file.type}. Allowed: ${ALLOWED_AUDIO_MIME_TYPES.join(', ')}` },
        { status: 422 },
      );
    }

    // Validate file size
    if (file.size > MAX_AUDIO_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: ${MAX_AUDIO_FILE_SIZE / 1024 / 1024}MB` },
        { status: 413 },
      );
    }

    // Validate file extension matches MIME
    const ext = file.name.split('.').pop()?.toLowerCase();
    const mimeExtMap: Record<string, string[]> = {
      'audio/webm': ['webm'],
      'audio/wav': ['wav'],
      'audio/mpeg': ['mp3'],
      'audio/mp3': ['mp3'],
      'audio/ogg': ['ogg'],
      'audio/mp4': ['m4a', 'mp4'],
      'audio/m4a': ['m4a'],
      'audio/x-m4a': ['m4a'],
    };
    if (ext && !mimeExtMap[file.type]?.includes(ext)) {
      return NextResponse.json(
        { error: `File extension ".${ext}" does not match MIME type "${file.type}"` },
        { status: 422 },
      );
    }

    // Generate server-side unique filename
    const filename = generateAudioFilename(file.type as never);
    const bytes = Buffer.from(await file.arrayBuffer());

    // Store via existing storage abstraction
    await putAudio(admin.organizationId, filename, bytes, file.type);

    // Create database record
    const recording = await db.audioRecording.create({
      data: {
        organizationId: admin.organizationId,
        employeeId: employeeId || null,
        deviceId: deviceId || null,
        fileName: file.name,
        filePath: filename,
        fileSize: file.size,
        mimeType: file.type,
        status: 'uploaded',
      },
    });

    // Audit log
    await db.auditLog.create({
      data: {
        action: 'create',
        resource: 'audio_recording',
        resourceId: recording.id,
        description: `Audio recording uploaded: ${file.name} (${(file.size / 1024).toFixed(0)}KB)`,
        userId: admin.userId,
        organizationId: admin.organizationId,
      },
    });

    return NextResponse.json({
      success: true,
      recording: {
        id: recording.id,
        fileName: recording.fileName,
        status: recording.status,
        createdAt: recording.createdAt,
      },
    });
  } catch (error) {
    log.error('api.audio.upload', { error: String(error) }, requestContext(request));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// GET /api/audio — paginated list with filters
export async function GET(request: NextRequest) {
  try {
    const admin = await requireAdminOrg(request);
    if (!admin.ok) return authError(admin);

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, Number(searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get('pageSize')) || 20));
    const status = searchParams.get('status') || undefined;
    const employeeId = searchParams.get('employeeId') || undefined;
    const search = searchParams.get('search') || undefined;
    const dateFrom = searchParams.get('dateFrom');
    const dateTo = searchParams.get('dateTo');

    const where: Record<string, unknown> = { organizationId: admin.organizationId };
    if (status) where.status = status;
    if (employeeId) where.employeeId = employeeId;
    if (search) {
      where.OR = [
        { fileName: { contains: search, mode: 'insensitive' } },
        { transcription: { text: { contains: search, mode: 'insensitive' } } },
        { employee: { firstName: { contains: search, mode: 'insensitive' } } },
        { employee: { lastName: { contains: search, mode: 'insensitive' } } },
      ];
    }
    if (dateFrom || dateTo) {
      const createdAt: Record<string, unknown> = {};
      if (dateFrom) createdAt.gte = new Date(dateFrom);
      if (dateTo) createdAt.lte = new Date(dateTo);
      where.createdAt = createdAt;
    }

    const [recordings, total] = await Promise.all([
      db.audioRecording.findMany({
        where,
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeId: true } },
          device: { select: { id: true, name: true, hostname: true } },
          transcription: {
            select: { id: true, text: true, language: true, wordCount: true, duration: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.audioRecording.count({ where }),
    ]);

    return NextResponse.json({
      data: recordings,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    log.error('api.audio.list', { error: String(error) }, requestContext(request));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
