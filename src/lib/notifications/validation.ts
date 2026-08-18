// OmniSight — shared validation for Notification + Alert payloads.
//
// Enforced at every boundary (manual POST, agent routes, producers) so no
// arbitrary/unsafe value is ever persisted: length bounds, canonical enum
// checks (re-exported from constants), actionUrl scheme safety, and bounded
// metadata JSON.

import { isNotificationType, isNotificationPriority, isAlertSeverity, isAlertStatus } from './constants';

export const MAX_TITLE_LENGTH = 200;
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_DESCRIPTION_LENGTH = 2000;
export const MAX_ACTION_URL_LENGTH = 500;
export const MAX_ENTITY_ID_LENGTH = 200;
export const MAX_METADATA_BYTES = 8 * 1024; // 8 KB serialized JSON cap
export const MAX_BATCH_IDS = 200;

/** Internal relative URL prefix — only these SPA routes are navigable. */
const SAFE_INTERNAL_PREFIXES = [
  '/anomalies',
  '/employees',
  '/devices',
  '/projects',
  '/consent',
  '/policies',
  '/notifications',
  '/alerts',
  '/security',
];

const UNSAFE_PROTOCOLS = ['javascript:', 'data:', 'vbscript:', 'file:'];

/**
 * Validate a notification actionUrl.
 *
 * Rules:
 * - must be a string within the length bound
 * - relative internal URLs must start with an approved SPA prefix
 * - absolute URLs must be http(s) and same-origin safe in intent
 * - javascript:/data:/vbscript:/file: are always rejected
 * Returns an error message, or null when the value is acceptable (or absent).
 */
export function validateActionUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'actionUrl must be a string';
  if (value.length > MAX_ACTION_URL_LENGTH) return `actionUrl must be at most ${MAX_ACTION_URL_LENGTH} characters`;

  const trimmed = value.trim();
  if (trimmed === '') return null;

  const lower = trimmed.toLowerCase();
  for (const proto of UNSAFE_PROTOCOLS) {
    if (lower.startsWith(proto)) return 'actionUrl uses an unsafe protocol';
  }

  // Absolute URLs: only http(s), and never a foreign host (must stay in-app).
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    if (!/^https?:\/\//i.test(trimmed)) return 'actionUrl must use http(s)';
    try {
      const url = new URL(trimmed);
      const host = url.hostname;
      if (host && !(host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1')) {
        return 'actionUrl must point to this application';
      }
      return null;
    } catch {
      return 'actionUrl is malformed';
    }
  }

  // Relative internal URL — must be a known SPA route (no `//` protocol-relative).
  if (trimmed.startsWith('//')) return 'actionUrl must not be protocol-relative';
  if (!trimmed.startsWith('/')) return 'actionUrl must be an absolute path';
  const path = trimmed.split(/[?#]/, 1)[0];
  if (!SAFE_INTERNAL_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) {
    return 'actionUrl must be an internal application route';
  }
  return null;
}

/** Length-bound a required title (returns error message or null). */
export function validateTitle(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'title is required';
  if (value.length > MAX_TITLE_LENGTH) return `title must be at most ${MAX_TITLE_LENGTH} characters`;
  return null;
}

export function validateMessage(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'message is required';
  if (value.length > MAX_MESSAGE_LENGTH) return `message must be at most ${MAX_MESSAGE_LENGTH} characters`;
  return null;
}

export function validateDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'description must be a string';
  if (value.length > MAX_DESCRIPTION_LENGTH) return `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
  return null;
}

export function validateNotificationType(value: unknown): string | null {
  if (!isNotificationType(value)) return 'type must be one of the supported notification types';
  return null;
}

export function validateNotificationPriority(value: unknown): string | null {
  if (value === undefined || value === null) return null; // defaults to medium
  if (!isNotificationPriority(value)) return 'priority must be low, medium, high, or critical';
  return null;
}

export function validateAlertSeverity(value: unknown): string | null {
  if (!isAlertSeverity(value)) return 'severity must be info, warning, error, or critical';
  return null;
}

export function validateAlertStatus(value: unknown): string | null {
  if (!isAlertStatus(value)) return 'status must be pending, acknowledged, resolved, or archived';
  return null;
}

/**
 * Serialize a metadata object safely: must be a plain object (or absent),
 * and the serialized JSON must fit the size cap. Returns the JSON string, or
 * null when the value is absent. Throws a TypeError with a stable message for
 * the caller to map to 4xx.
 */
export function serializeMetadata(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('metadata must be a JSON object');
  }
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new TypeError('metadata must be valid JSON');
  }
  if (json.length > MAX_METADATA_BYTES) {
    throw new TypeError(`metadata must be at most ${MAX_METADATA_BYTES} bytes`);
  }
  return json;
}

/** Bound a nullable entityId string. */
export function validateEntityId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'entityId must be a string';
  if (value.length > MAX_ENTITY_ID_LENGTH) return `entityId must be at most ${MAX_ENTITY_ID_LENGTH} characters`;
  return null;
}

/** Bound a nullable entityType string (free-form, length-bounded only). */
export function validateEntityType(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'entityType must be a string';
  if (value.length > 60) return 'entityType must be at most 60 characters';
  return null;
}
