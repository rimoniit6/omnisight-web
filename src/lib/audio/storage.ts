import { basename } from 'path';
import crypto from 'crypto';
import { storage } from '@/lib/storage';
import type { AllowedAudioMime } from './types';

const AUDIO_BUCKET = 'audio';

/** Storage key for an audio object. Keys are NEVER derived from client input. */
export function audioKey(orgId: string, filename: string): string {
  const name = basename(filename);
  if (!name) throw new Error('Empty audio filename');
  return `${AUDIO_BUCKET}/${orgId}/${name}`;
}

/** Generate a server-side unique filename from the original MIME type. */
export function generateAudioFilename(mimeType: AllowedAudioMime): string {
  const extMap: Record<string, string> = {
    'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
    'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
  };
  const ext = extMap[mimeType] || 'bin';
  return `${crypto.randomUUID()}.${ext}`;
}

/** Store an audio file. */
export async function putAudio(
  orgId: string,
  filename: string,
  bytes: Buffer,
  mimeType: string,
): Promise<void> {
  await storage().put(audioKey(orgId, filename), { bytes, contentType: mimeType });
}

/** Read an audio file. */
export async function getAudio(orgId: string, filename: string): Promise<Buffer> {
  return storage().get(audioKey(orgId, filename));
}

/** Delete an audio file. */
export async function deleteAudio(orgId: string, filename: string): Promise<void> {
  await storage().delete(audioKey(orgId, filename));
}

/**
 * Generate a time-limited download URL for the audio file.
 * Returns a signed URL (Supabase) or null (local — caller should stream).
 */
export async function getAudioSignedUrl(
  orgId: string,
  filename: string,
  expiresInSeconds = 3600,
): Promise<string | null> {
  return storage().getSignedUrl(audioKey(orgId, filename), expiresInSeconds);
}

/** Resolve a storage key from a filePath column value. */
export function audioKeyFromPath(orgId: string, filePath: string): string {
  return audioKey(orgId, basename(filePath || ''));
}
