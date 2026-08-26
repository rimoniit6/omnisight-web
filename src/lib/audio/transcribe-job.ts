import { db } from '@/lib/db';
import { log } from '@/lib/logger';
import { getAudioSignedUrl } from '@/lib/audio/storage';
import { MAX_AUDIO_RETRIES } from '@/lib/audio/types';

const TRANSCRIPTION_SERVICE_URL = process.env.TRANSCRIPTION_SERVICE_URL || 'http://localhost:8001';
const TRANSCRIPTION_API_KEY = process.env.TRANSCRIPTION_API_KEY || '';

interface TranscriptionSubmitResult {
  recordingId: string;
  success: boolean;
  error?: string;
}

/**
 * Submit an audio recording to the transcription microservice.
 * Returns success/failure — the service handles the callback asynchronously.
 */
export async function submitForTranscription(
  recordingId: string,
): Promise<TranscriptionSubmitResult> {
  const recording = await db.audioRecording.findUnique({
    where: { id: recordingId },
    select: {
      id: true,
      organizationId: true,
      filePath: true,
      status: true,
      retryCount: true,
    },
  });

  if (!recording) {
    return { recordingId, success: false, error: 'Recording not found' };
  }

  // Only submit uploaded or queued recordings that haven't exceeded retries
  if (recording.status !== 'uploaded' && recording.status !== 'queued') {
    return { recordingId, success: false, error: `Invalid status: ${recording.status}` };
  }

  if (recording.retryCount >= MAX_AUDIO_RETRIES) {
    return { recordingId, success: false, error: 'Max retries exceeded' };
  }

  // Generate signed URL for the audio file
  const signedUrl = await getAudioSignedUrl(recording.organizationId, recording.filePath, 3600);
  if (!signedUrl) {
    return { recordingId, success: false, error: 'Failed to generate signed URL' };
  }

  // Update status to queued
  await db.audioRecording.update({
    where: { id: recordingId },
    data: { status: 'queued' },
  });

  // Submit to transcription service
  try {
    const response = await fetch(`${TRANSCRIPTION_SERVICE_URL}/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': TRANSCRIPTION_API_KEY,
      },
      body: JSON.stringify({
        recording_id: recording.id,
        organization_id: recording.organizationId,
        audio_url: signedUrl,
      }),
      signal: AbortSignal.timeout(30_000), // 30s timeout for submission
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      log.error('audio.transcribe.submit_failed', {
        recordingId,
        status: response.status,
        error: errorText,
      });
      return { recordingId, success: false, error: `Service returned ${response.status}: ${errorText}` };
    }

    // Update status to transcribing
    await db.audioRecording.update({
      where: { id: recordingId },
      data: { status: 'transcribing' },
    });

    return { recordingId, success: true };
  } catch (error) {
    log.error('audio.transcribe.submit_error', {
      recordingId,
      error: String(error),
    });
    return { recordingId, success: false, error: String(error) };
  }
}

/**
 * Process pending audio transcriptions.
 * Called by the job runner to pick up uploaded/queued recordings.
 */
export async function processPendingTranscriptions(limit = 5): Promise<{
  processed: number;
  submitted: number;
  failed: number;
  errors: string[];
}> {
  const result = { processed: 0, submitted: 0, failed: 0, errors: [] as string[] };

  // Find recordings that need transcription (uploaded or queued, not exceeded retries)
  const pending = await db.audioRecording.findMany({
    where: {
      status: { in: ['uploaded', 'queued'] },
      retryCount: { lt: MAX_AUDIO_RETRIES },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  });

  for (const rec of pending) {
    result.processed++;
    const submitResult = await submitForTranscription(rec.id);
    if (submitResult.success) {
      result.submitted++;
    } else {
      result.failed++;
      result.errors.push(`${rec.id}: ${submitResult.error}`);
    }
  }

  return result;
}
