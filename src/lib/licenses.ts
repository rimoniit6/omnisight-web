// OmniSight — License key helpers (self-hosted)
//
// License keys use the canonical format: OMNISIGHT-XXXX-XXXX-XXXX
// (3 groups of 4 uppercase alphanumerics, prefixed by OMNISIGHT-).
// Generation is cryptographically random (crypto.randomBytes).
//
// SECURITY: license keys are treated as secrets. Never log them or return
// them in error messages / server responses (except to an authenticated Super
// Admin on the management routes, which intentionally persist/display them).

import { randomBytes } from 'crypto';
import { isSelfHosted, getLicenseKey } from '@/lib/config';

const KEY_RE = /^OMNISIGHT-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // 36 chars

const GROUPS = 3;
const PER_GROUP = 4;
const TOTAL_BYTES = GROUPS * PER_GROUP; // 12

/**
 * Generate a fresh license key: OMNISIGHT-XXXX-XXXX-XXXX.
 * Each group is built from independent cryptographically-random bytes mapped
 * into the 36-character uppercase alphanumeric set. Collisions are handled by
 * the caller (unique DB column) — astronomically unlikely.
 */
export function generateLicenseKey(): string {
  const bytes = randomBytes(TOTAL_BYTES);
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = '';
    for (let i = 0; i < PER_GROUP; i++) {
      group += KEY_CHARS[bytes[g * PER_GROUP + i] % KEY_CHARS.length];
    }
    groups.push(group);
  }
  return `OMNISIGHT-${groups.join('-')}`;
}

/** Validate that a key matches the canonical OMNISIGHT-XXXX-XXXX-XXXX format. */
export function isValidLicenseFormat(key: string): boolean {
  return KEY_RE.test(key);
}

/**
 * Self-hosted startup license check.
 *
 * In self-hosted mode this calls the (internal) public validation endpoint to
 * confirm the configured LICENSE_KEY is current. It never logs the key.
 *
 * Behaviour:
 *   - Cloud mode (SELF_HOSTED unset): no-op.
 *   - SELF_HOSTED set but LICENSE_KEY missing: warn (validation disabled).
 *   - Validation returns invalid/expired/revoked: log a loud warning; if
 *     SELF_HOSTED_REQUIRE_LICENSE=true, THROW to refuse server start.
 *   - Network error (e.g. server not yet listening during register()): warn
 *     non-fatally — periodic re-validation happens later.
 */
export async function verifySelfHostedLicenseAtStartup(): Promise<void> {
  if (!isSelfHosted) return;

  const key = getLicenseKey();
  if (!key) {
    console.warn('[license] SELF_HOSTED=true but LICENSE_KEY is not set — license validation is disabled.');
    return;
  }

  const port = process.env.PORT || '3000';
  const baseUrl = process.env.APP_URL || `http://localhost:${port}`;

  try {
    const res = await fetch(`${baseUrl}/api/license/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
      cache: 'no-store',
    });
    const payload = (await res.json().catch(() => ({}))) as { valid?: boolean; reason?: string; data?: { expiresAt?: string; plan?: { name?: string } } };

    if (payload.valid) {
      console.log(
        `[license] valid self-hosted license (plan: ${payload.data?.plan?.name ?? 'unknown'}, expires: ${payload.data?.expiresAt ?? 'unknown'}).`
      );
    } else {
      const reason = payload.reason ?? 'invalid';
      console.error(`[license] SELF-HOSTED LICENSE INVALID (reason: ${reason}). The app is not fully licensed.`);
      if (process.env.SELF_HOSTED_REQUIRE_LICENSE === 'true') {
        throw new Error(`Self-hosted license is invalid at startup (reason: ${reason}). Refusing to start.`);
      }
    }
  } catch (err) {
    // Non-fatal — the HTTP server is often still binding when register() runs.
    console.error(`[license] startup license check failed (will not block boot): ${String(err)}`);
  }
}
