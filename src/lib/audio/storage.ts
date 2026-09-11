import { basename } from 'path';
import crypto from 'crypto';
import { storage } from '@/lib/storage';
import { getOrgStorage } from '@/lib/org-storage';
import type { AllowedAudioMime } from './types';

const AUDIO_BUCKET = 'audio';

/**
 * Resolve the storage driver for an organization's audio artifacts.
 *
 * Same organization-aware model as screenshots: an org with an ACTIVE
 * dedicated storage change-request resolves its own driver (getOrgStorage);
 * only an org that never opted in falls back to the platform driver. After a
 * storage cutover the org driver is authoritative — audio objects must never
 * silently continue landing in platform storage while the audio metadata rows
 * live in the org's own database.
 */
async function audioStorageDriver(orgId: string): Promise<ReturnType<typeof storage>> {
  const res = await getOrgStorage(orgId);
  return res.mode === 'org' ? res.driver : storage();
}

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
  const driver = await audioStorageDriver(orgId);
  await driver.put(audioKey(orgId, filename), { bytes, contentType: mimeType });
}

/** Read an audio file. */
export async function getAudio(orgId: string, filename: string): Promise<Buffer> {
  const driver = await audioStorageDriver(orgId);
  return driver.get(audioKey(orgId, filename));
}

/** Delete an audio file. */
export async function deleteAudio(orgId: string, filename: string): Promise<void> {
  const driver = await audioStorageDriver(orgId);
  await driver.delete(audioKey(orgId, filename));
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
  const driver = await audioStorageDriver(orgId);
  return driver.getSignedUrl(audioKey(orgId, filename), expiresInSeconds);
}

/** Resolve a storage key from a filePath column value. */
export function audioKeyFromPath(orgId: string, filePath: string): string {
  return audioKey(orgId, basename(filePath || ''));
}
