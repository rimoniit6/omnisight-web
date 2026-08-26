import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { log, requestContext } from '@/lib/logger';
import crypto from 'crypto';

/**
 * POST /api/internal/audio/transcription-callback
 *
 * Internal endpoint for the Python transcription microservice to deliver results.
 * NOT accessible to normal users — authenticated via internal API key only.
 */

function getInternalApiKey(): string {
  return process.env.TRANSCRIPTION_API_KEY || '';
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function POST(request: NextRequest) {
  try {
    // Authenticate via internal API key
    const apiKey = request.headers.get('x-api-key') || '';
    const expectedKey = getInternalApiKey();

    if (!expectedKey) {
      log.error('audio.callback.no_api_key_configured', { error: 'TRANSCRIPTION_API_KEY not set' });
      return NextResponse.json({ error: 'Service not configured' }, { status: 503 });
    }

    if (!apiKey || !timingSafeEqual(apiKey, expectedKey)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      recordingId,
      organizationId,
      success,
      text,
      segments,
      language,
      confidence,
      model,
      duration,
      wordCount,
      processingMs,
      errorMessage,
    } = body as {
      recordingId: string;
      organizationId: string;
      success: boolean;
      text?: string;
      segments?: string;
      language?: string;
      confidence?: number;
      model?: string;
      duration?: number;
      wordCount?: number;
      processingMs?: number;
      errorMessage?: string;
    };

    if (!recordingId || !organizationId) {
      return NextResponse.json({ error: 'Missing required fields: recordingId, organizationId' }, { status: 422 });
    }

    // Verify recording exists and belongs to the specified organization
    const recording = await db.audioRecording.findFirst({
      where: { id: recordingId, organizationId },
    });

    if (!recording) {
      return NextResponse.json({ error: 'Recording not found' }, { status: 404 });
    }

    if (success && text) {
      // Successful transcription
      const wordCountFinal = wordCount || text.split(/\s+/).filter(Boolean).length;

      await db.$transaction(async (tx) => {
        await tx.audioTranscription.upsert({
          where: { recordingId },
          create: {
            recordingId,
            organizationId,
            text,
            segments: segments || null,
            language: language || 'en',
            confidence: confidence ?? null,
            model: model || 'whisper-base',
            duration: duration || 0,
            wordCount: wordCountFinal,
            processingMs: processingMs ?? null,
          },
          update: {
            text,
            segments: segments || null,
            language: language || 'en',
            confidence: confidence ?? null,
            model: model || 'whisper-base',
            duration: duration || 0,
            wordCount: wordCountFinal,
            processingMs: processingMs ?? null,
          },
        });

        await tx.audioRecording.update({
          where: { id: recordingId },
          data: {
            status: 'completed',
            duration: duration || recording.duration,
            language: language || recording.language,
            errorMessage: null,
          },
        });
      });
    } else {
      // Failed transcription
      await db.audioRecording.update({
        where: { id: recordingId },
        data: {
          status: 'failed',
          errorMessage: errorMessage || 'Transcription failed',
          retryCount: { increment: 1 },
        },
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('audio.callback.error', { error: String(error) }, requestContext(request));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
