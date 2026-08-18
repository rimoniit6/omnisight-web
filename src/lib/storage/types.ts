/**
 * Storage abstraction — the single seam between the application and where
 * binary artifacts (screenshots, avatars) physically live.
 *
 * Two drivers:
 *  - "local"    — filesystem under <cwd>/uploads (self-hosted, dev, tests)
 *  - "supabase" — Supabase Storage buckets via the public REST API
 *                 (Vercel serverless: the filesystem is read-only, so
 *                 artifacts MUST live in object storage)
 *
 * Keys are driver-independent strings:
 *  - screenshots: "screenshots/<orgId>/<uuid>.<ext>"
 *  - avatars:     "avatars/<uuid>.png"
 *
 * The active driver is chosen once per process from environment:
 *  STORAGE_DRIVER=supabase + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *  In production: missing credentials cause a hard failure (fail-closed).
 *  In development/test: falls back to local with a logged warning.
 */

export type StorageDriverKind = 'local' | 'supabase';

export interface StorageObject {
  bytes: Buffer;
  contentType: string;
}

export interface StorageError extends Error {
  code: 'not_found' | 'unavailable';
}

export function storageError(code: StorageError['code'], message: string): StorageError {
  const err = new Error(message) as StorageError;
  err.code = code;
  return err;
}

export interface StorageDriver {
  readonly kind: StorageDriverKind;
  /** Write (or overwrite) an object. */
  put(key: string, object: StorageObject): Promise<void>;
  /** Read an object. Throws StorageError{code:'not_found'} when absent. */
  get(key: string): Promise<Buffer>;
  /** Delete an object. Absent objects are treated as already deleted. */
  delete(key: string): Promise<void>;
  /**
   * Time-limited URL usable to fetch a private object (supabase only).
   * Returns null when the driver cannot produce one (local).
   */
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string | null>;
  /** Stable public URL for a public-bucket object; null when unsupported. */
  getPublicUrl(key: string): string | null;
}

/** Canonical bucket names used across the codebase. */
export const SCREENSHOTS_BUCKET = 'screenshots';
export const AVATARS_BUCKET = 'avatars';

export const SCREENSHOTS_KEY_PREFIX = `${SCREENSHOTS_BUCKET}/`;
export const AVATARS_KEY_PREFIX = `${AVATARS_BUCKET}/`;

/** Content types for objects we store. */
export const SCREENSHOT_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};