/** Allowed MIME types for audio upload. */
export const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/webm',
  'audio/wav',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
] as const;

export type AllowedAudioMime = (typeof ALLOWED_AUDIO_MIME_TYPES)[number];

/** Maximum file size for audio upload (100 MB). */
export const MAX_AUDIO_FILE_SIZE = 100 * 1024 * 1024;

/** Maximum retries for failed transcriptions. */
export const MAX_AUDIO_RETRIES = 3;

/** Recording status values — the state machine is: uploaded → queued → transcribing → completed | failed */
export type RecordingStatus = 'uploaded' | 'queued' | 'transcribing' | 'completed' | 'failed';

/** Phase-based progress (no fake precision). */
export function recordingProgress(status: RecordingStatus): number {
  switch (status) {
    case 'uploaded': return 0;
    case 'queued': return 10;
    case 'transcribing': return 50;
    case 'completed': return 100;
    case 'failed': return 0;
  }
}

/** Whether the given MIME type is accepted for audio upload. */
export function isAllowedAudioMime(mime: string): mime is AllowedAudioMime {
  return (ALLOWED_AUDIO_MIME_TYPES as readonly string[]).includes(mime);
}

/** Extension map from MIME type. */
export const MIME_TO_EXTENSION: Record<AllowedAudioMime, string> = {
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
};
