import { basename } from 'path';

/**
 * Screenshot storage utilities — validation, MIME detection, filename safety.
 *
 * This module intentionally has NO fs/promises dependency so production
 * routes can import these functions without triggering Turbopack filesystem
 * tracing. The orphan-file sweep lives in ./sweep.ts (imported only by the
 * retention background job).
 */

export const ALLOWED_SCREENSHOT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AllowedScreenshotMime = (typeof ALLOWED_SCREENSHOT_MIME_TYPES)[number];

const MIME_TO_EXT: Record<AllowedScreenshotMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Extension for a validated screenshot MIME type (used for stored filenames). */
export function extensionForMime(mime: AllowedScreenshotMime): string {
  return MIME_TO_EXT[mime];
}

/**
 * Detect the actual raster image type from the file signature (magic bytes).
 * Returns null for any unrecognized content — SVG, GIF, BMP, TIFF, HTML, or
 * arbitrary bytes all fail here and are rejected on upload.
 */
export function detectImageMime(bytes: Buffer): AllowedScreenshotMime | null {
  // PNG: 89 50 4E 47 (0x89 'P' 'N' 'G')
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  // WebP: 'RIFF' .... 'WEBP' (bytes 0-3 == RIFF, bytes 8-11 == WEBP)
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Parse width/height from a validated PNG buffer (IHDR, big-endian at bytes
 * 16–23). Returns null for anything that is not a well-formed PNG — malformed
 * buffers and non-PNG files never produce garbage dimensions. JPEG/WebP are
 * intentionally left unparsed (their width/height stay NULL server-side).
 */
export function parsePngDimensions(bytes: Buffer): { width: number; height: number } | null {
  // Signature: 89 50 4E 47 0D 0A 1A 0A
  if (bytes.length < 24) return null;
  if (
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return null;
  }
  // First chunk must be IHDR (length 13).
  const chunkLength = bytes.readUInt32BE(8);
  const chunkType = bytes.toString('ascii', 12, 16);
  if (chunkType !== 'IHDR' || chunkLength !== 13) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  // Reject zero/absurd dimensions — never trust malformed content.
  if (width === 0 || height === 0 || width > 65535 || height > 65535) return null;
  return { width, height };
}

export type UploadValidationResult =
  | { ok: true; mimeType: AllowedScreenshotMime }
  | { ok: false; error: string };

/**
 * Validate an uploaded screenshot: the client-declared MIME must be on the
 * allowlist AND the actual file signature must match it. Never trust the
 * client-provided MIME type alone.
 */
export function validateScreenshotUpload(
  bytes: Buffer,
  claimedType: string
): UploadValidationResult {
  if (!ALLOWED_SCREENSHOT_MIME_TYPES.includes(claimedType as AllowedScreenshotMime)) {
    return {
      ok: false,
      error: 'Only PNG, JPEG and WebP screenshot files are allowed',
    };
  }
  const detected = detectImageMime(bytes);
  if (detected !== claimedType) {
    return {
      ok: false,
      error: 'Image content does not match the declared file type',
    };
  }
  return { ok: true, mimeType: detected };
}

/**
 * Resolve the safe Content-Type for serving a screenshot file. The stored MIME
 * is never trusted blindly: the physical file signature is authoritative. Any
 * file that is not a recognized raster image is served as
 * application/octet-stream (with nosniff) so it can never be interpreted as
 * executable HTML/SVG by the browser.
 */
export function safeServeMime(byte: Buffer): string {
  const detected = detectImageMime(byte);
  if (detected) return detected;
  // Unknown content (corrupt file, legacy artifact, or a tampered upload that
  // predates magic-byte validation). Force a non-executable type.
  return 'application/octet-stream';
}

/**
 * Make a server-derived string safe to embed in a stored filename. Only
 * [A-Za-z0-9._-] survive — path separators, ".." and any other character are
 * replaced with "_", and the segment is length-bounded. The screenshots
 * upload route uses this on the employee code prefix so a crafted
 * employeeId (admin-created, not sanitized at the Employee API) can never
 * turn the stored filename into a path traversal.
 */
export function sanitizeFilenameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

/**
 * P3-8 — sanitize the AGENT-SUPPLIED display name before it is stored in the
 * Screenshot.fileName column (a client-controlled value that is rendered in
 * the admin UI). The physical file on disk is always a server-generated UUID
 * name and is never derived from this value, but the stored display name must
 * still be a bare, harmless filename: path separators (both / and \\) and
 * control characters are stripped, whitespace is collapsed, the value is
 * length-bounded, and an empty result falls back to a neutral default so the
 * column can never carry an empty/whitespace-only or path-like string.
 */
export function sanitizeDisplayFilename(value: string, fallback = 'capture.png'): string {
  const cleaned = value
    .replace(/[\\/\u0000-\u001f\u007f]/g, '') // path separators + control chars
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 255);
  return cleaned || fallback;
}


