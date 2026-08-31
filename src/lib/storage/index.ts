import { basename } from 'path';
import { log } from '@/lib/logger';
import { LocalStorageDriver } from './local';
import { SupabaseStorageDriver } from './supabase';
import {
  StorageDriver,
  StorageDriverKind,
  StorageError,
  storageError,
  SCREENSHOTS_BUCKET,
  AVATARS_BUCKET,
  SCREENSHOT_CONTENT_TYPES,
} from './types';

/**
 * Active storage driver selection (resolved once per process).
 *
 * STORAGE_DRIVER=supabase requires SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY. In production, missing credentials cause a
 * hard failure (fail-closed) so that a misconfiguration never silently
 * downgrades to local filesystem storage. In development/test, missing
 * credentials fall back to the local driver with a logged warning.
 */
/** Placeholder values that indicate unconfigured environment variables. */
const PLACEHOLDER_PATTERNS = [
  /^REPLACE/i,
  /^YOUR_/i,
  /^<.*>$/,
  /^TODO/i,
  /^FIXME/i,
  /^xxx/i,
  /^changeme/i,
];

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(value));
}

export function resolveStorageDriver(): StorageDriver {
  const kind = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
  if (kind === 'supabase') {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    // Detect placeholder credentials — fail closed in ALL environments.
    // A placeholder URL would cause every upload to fail with a network error,
    // but the server would start and appear healthy. This is worse than a
    // startup crash because the failure is silent and discovered only when
    // screenshots stop appearing in the admin panel.
    if (url && isPlaceholder(url)) {
      throw new Error(
        'STORAGE_DRIVER=supabase but SUPABASE_URL appears to be a placeholder value. ' +
        'Set a real Supabase project URL or switch to STORAGE_DRIVER=local for self-hosted development.',
      );
    }
    if (key && isPlaceholder(key)) {
      throw new Error(
        'STORAGE_DRIVER=supabase but SUPABASE_SERVICE_ROLE_KEY appears to be a placeholder value. ' +
        'Set a real service role key or switch to STORAGE_DRIVER=local for self-hosted development.',
      );
    }

    if (url && key) {
      return new SupabaseStorageDriver(url, key);
    }
    // Production: fail closed — missing credentials must not silently downgrade to local storage.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'STORAGE_DRIVER=supabase but SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are missing. ' +
        'Cannot fall back to local storage in production. Set both environment variables.',
      );
    }
    log.warn('storage.supabase_config_missing', {
      reason: 'STORAGE_DRIVER=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing — falling back to local storage (dev/test only)',
    });
  } else if (kind !== 'local') {
    log.warn('storage.unknown_driver', { driver: kind, fallback: 'local' });
  }
  return new LocalStorageDriver();
}

let active: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (!active) active = resolveStorageDriver();
  return active;
}

export function isSupabaseStorage(): boolean {
  return storage().kind === 'supabase';
}

// ═══════════════════════════════════════════════════════════════════════════
// Screenshots
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Storage key for a screenshot object. The DB column keeps the display path
 * "/uploads/screenshots/<filename>"; the physical key is derived from it.
 * An empty filename is rejected (never yields a bucket-root key).
 */
export function screenshotKey(orgId: string, filename: string): string {
  const name = basename(filename);
  if (!name) throw storageError('not_found', 'Empty screenshot filename');
  return `${SCREENSHOTS_BUCKET}/${orgId}/${name}`;
}

/** Key from a stored filePath column value (basename is always extracted). */
export function screenshotKeyFromPath(orgId: string, filePath: string): string {
  return screenshotKey(orgId, basename(filePath || ''));
}

export async function putScreenshot(
  orgId: string,
  filename: string,
  bytes: Buffer,
  mimeType: string
): Promise<void> {
  await storage().put(screenshotKey(orgId, filename), {
    bytes,
    contentType: mimeType,
  });
}

export async function getScreenshot(orgId: string, filePath: string): Promise<Buffer> {
  return storage().get(screenshotKeyFromPath(orgId, filePath));
}

export async function deleteScreenshot(orgId: string, filePath: string): Promise<void> {
  await storage().delete(screenshotKeyFromPath(orgId, filePath));
}

/**
 * Read a screenshot for the AI vision pipeline. Returns a base64 image input
 * (local driver) or a time-limited signed URL (supabase driver — the VLM
 * fetches it server-side). Null when the object is missing/unreadable.
 */
export async function screenshotAiInput(
  orgId: string,
  filePath: string,
  mimeType?: string | null
): Promise<{ type: 'base64'; base64: string; mimeType: string } | { type: 'url'; url: string } | null> {
  const key = screenshotKeyFromPath(orgId, filePath);
  try {
    if (storage().kind === 'supabase') {
      const signed = await storage().getSignedUrl(key, 3600);
      if (!signed) {
        log.error('storage.signed_url_failed', { key });
        return null;
      }
      return { type: 'url', url: signed };
    }
    const bytes = await storage().get(key);
    const ext = basename(key).split('.').pop()?.toLowerCase() ?? '';
    return {
      type: 'base64',
      base64: bytes.toString('base64'),
      mimeType: SCREENSHOT_CONTENT_TYPES[ext] || mimeType || 'image/png',
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    log.error('storage.read_failed', { key, error: String((error as Error)?.message ?? error) });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Avatars
// ═══════════════════════════════════════════════════════════════════════════

export function avatarKey(filename: string): string {
  return `${AVATARS_BUCKET}/${basename(filename)}`;
}

export async function putAvatar(filename: string, bytes: Buffer): Promise<void> {
  await storage().put(avatarKey(filename), { bytes, contentType: 'image/png' });
}

export async function getAvatar(filename: string): Promise<Buffer> {
  return storage().get(avatarKey(filename));
}

/** Public avatar URL (supabase public bucket); null on local (served by the app). */
export function avatarPublicUrl(filename: string): string | null {
  return storage().getPublicUrl(avatarKey(filename));
}

// ═══════════════════════════════════════════════════════════════════════════
// Legacy artifact cleanup (retention)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Remove a stored artifact addressed by its legacy DB path. Screenshot paths
 * go through the driver; legacy non-screenshot paths are converted to storage
 * keys and deleted through the same abstraction — the driver owns the physical
 * deletion (local fs.unlink or Supabase REST DELETE).
 */
export async function removeArtifactByPath(
  orgId: string,
  filePath: string,
  kind: 'screenshot' | 'legacy'
): Promise<boolean> {
  if (kind === 'screenshot') {
    try {
      await deleteScreenshot(orgId, filePath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return true;
      return false;
    }
  }
  // Legacy non-screenshot paths (e.g. /uploads/reports/file.pdf) are converted
  // to storage keys and deleted through the driver abstraction. On supabase
  // the remote object may not exist — the driver treats that as a no-op.
  try {
    const key = filePath.replace(/^\/?uploads\//, '');
    await storage().delete(key);
    return true;
  } catch (error) {
    if (isNotFound(error)) return true;
    return false;
  }
}

export function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      ((error as StorageError).code === 'not_found' ||
        (error as { code?: string }).code === 'ENOENT')
  );
}