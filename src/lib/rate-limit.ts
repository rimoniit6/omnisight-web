// OmniSight — PostgreSQL-backed shared rate limiter (topology-independent)
//
// Token bucket stored in the `RateLimitCounter` table. The refill math runs in
// ONE atomic UPSERT (row lock), so concurrent requests across ANY number of
// application instances serialize on the row and can never bypass the limit —
// there is no read-modify-write race window. The bucket refills continuously
// (rate = limit/windowMs tokens per ms of elapsed time), giving
// sliding-window-like semantics without the fixed-window boundary burst.
//
// Failure behavior: an unavailable store never silently lifts a guard.
//   - security-critical keys (login, agent auth, registration, discovery,
//     org creation, claim/registration writes,
//     agent-account writes) FAIL CLOSED → the request is denied with a short
//     retry so brute-force/registration guards cannot be disabled by an outage.
//   - convenience/abuse throttles (heartbeat, agent-write, analytics reads,
//     exports, uploads) fail OPEN with a logged warning — a DB blip must not
//     break legitimate traffic on non-security paths (the endpoints themselves
//     still require the DB, so they fail anyway if the store is unreachable).
//
// Stale rows are removed by the rate-limit sweep job (src/lib/jobs) so the
// table stays bounded by active keys.

import { db } from '@/lib/db';
import { log } from '@/lib/logger';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

// Key prefixes that must never become unrestricted if the shared store is
// unreachable. Everything else is a convenience/abuse throttle.
const SECURITY_CRITICAL_PREFIXES = [
  'login:',
  'agent-auth:',
  'agent-login:',
  'agent-register:',
  'agent-discover:',
  'orgCreate:',
  'device-claim:',
  'agent-account-write:',
  'ai-test-connection:',
  'license-validate:', // self-hosted license validation — fail closed
];

function isSecurityCritical(key: string): boolean {
  return SECURITY_CRITICAL_PREFIXES.some((p) => key.startsWith(p));
}

// Log label only (the identifier half may contain emails/IPs — never logged).
function labelOf(key: string): string {
  return key.split(':')[0] || 'rate-limit';
}

/**
 * Check + consume one token for `key` in a shared PostgreSQL token bucket.
 * Returns allowed=false (with retryAfterSeconds) when the bucket is empty.
 */
export async function checkRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const now = Date.now();
  try {
    const rows = await db.$queryRaw<Array<{ tokens: number }>>`
      INSERT INTO "RateLimitCounter" ("key", tokens, "lastRefill", "updatedAt")
      VALUES (${key}, ${limit}::double precision - 1, ${now}::bigint, now())
      ON CONFLICT ("key") DO UPDATE SET
        tokens = LEAST(
                   ${limit}::double precision,
                   "RateLimitCounter".tokens
                     + (${limit}::double precision / ${windowMs}::double precision)
                       * (${now}::bigint - "RateLimitCounter"."lastRefill")::double precision
                 ) - 1,
        "lastRefill" = GREATEST("RateLimitCounter"."lastRefill", ${now}::bigint),
        "updatedAt" = now()
      RETURNING tokens
    `;
    const tokens = Number(rows[0]?.tokens ?? limit - 1);
    if (tokens >= 0) {
      return { allowed: true, limit, remaining: Math.max(0, Math.floor(tokens)), retryAfterSeconds: 0 };
    }
    // Refill rate = limit/windowMs tokens per second; seconds until ≥1 token.
    const retryAfterSeconds = Math.max(1, Math.ceil((-tokens * windowMs) / limit / 1000));
    return { allowed: false, limit, remaining: 0, retryAfterSeconds };
  } catch (err) {
    log.error('rate_limit.store_error', { key: labelOf(key), error: String(err) });
    if (isSecurityCritical(key)) {
      // Fail CLOSED: deny with a short retry rather than silently removing the
      // brute-force/registration guard.
      return { allowed: false, limit, remaining: 0, retryAfterSeconds: 5 };
    }
    return { allowed: true, limit, remaining: 0, retryAfterSeconds: 0 };
  }
}

/**
 * Standard production limits.
 */
export const RATE_LIMITS = {
  login: { limit: 10, windowMs: 5 * 60 * 1000 }, // 10 attempts / 5 min / IP+email
  agentAuthenticate: { limit: 20, windowMs: 60 * 1000 }, // 20 / min / IP
  agentRegister: { limit: 10, windowMs: 60 * 1000 }, // 10 / min / IP
  agentDiscover: { limit: 20, windowMs: 60 * 1000 }, // 20 / min / IP+deviceKey (device discovery)
  deviceClaimWrite: { limit: 30, windowMs: 60 * 1000 }, // approve/reject/revoke claim / IP
  orgCreate: { limit: 10, windowMs: 60 * 1000 }, // org creation / min / IP+admin (bootstrap path)
  aiTestConnection: { limit: 10, windowMs: 60 * 1000 }, // 10 / min / IP
  licenseGenerate: { limit: 10, windowMs: 60 * 1000 }, // license key creation / IP (super admin)
  licenseValidate: { limit: 5, windowMs: 60 * 1000 }, // 5 license validations / min / IP

  // ── Sensitive / expensive API classes (applied centrally in proxy.ts) ──
  exportCsv: { limit: 15, windowMs: 60 * 1000 }, // CSV/Excel export / IP
  exportPdf: { limit: 15, windowMs: 60 * 1000 }, // PDF generation / IP
  bulkWrite: { limit: 15, windowMs: 60 * 1000 }, // bulk ops (batch updates) / IP
  importWrite: { limit: 5, windowMs: 60 * 1000 }, // CSV import / IP
  employeeWrite: { limit: 30, windowMs: 60 * 1000 }, // create/update employee / IP
  deviceWrite: { limit: 30, windowMs: 60 * 1000 }, // create/update/delete device / IP
  aiWrite: { limit: 10, windowMs: 60 * 1000 }, // AI ops (analyze/detect/generate) / IP
  analyticsRead: { limit: 60, windowMs: 60 * 1000 }, // expensive analytics GET / IP
  uploadAvatar: { limit: 20, windowMs: 60 * 1000 }, // avatar upload / IP
  screenshotImage: { limit: 120, windowMs: 60 * 1000 }, // image bytes / IP (thumbnails+paging)
  agentHeartbeat: { limit: 600, windowMs: 60 * 1000 }, // per agent token (15s cadence)
  agentWrite: { limit: 120, windowMs: 60 * 1000 }, // other agent writes / per token
  agentAccountWrite: { limit: 20, windowMs: 60 * 1000 }, // create/reset/status agent acct / IP
  agentLogin: { limit: 20, windowMs: 60 * 1000 }, // 20 / min / IP
} as const;

// Client IP is resolved through the CANONICAL resolver (src/lib/client-ip.ts)
// so rate limiting, audit logging, agent auth and the login route can never
// disagree about who the client is (see client-ip.ts for the trust model and
// behavior matrix). Re-exported here for backward compatibility with existing
// imports.
export { getClientIpFromHeaders } from './client-ip';
