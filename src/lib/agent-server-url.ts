// OmniSight — canonical Agent server-URL validation policy.
//
// This module is the SINGLE source of truth for what counts as an acceptable
// agent server URL. It is intentionally pure (no server-only imports, no
// database access) so the exact same rules and messages can be enforced by:
//
//   - the Admin Settings API (PUT /api/agent-software — save server URL)
//   - the Agent Builder API (POST /api/agent-software/build)
//   - the build host pre-flight in src/lib/agent-software.ts (startAgentBuild)
//   - the Admin Settings client component (immediate, in-browser feedback)
//
// Policy (environment-aware, driven by NODE_ENV — never by client-supplied
// flags):
//
//   development / test (NODE_ENV !== 'production'):
//     - http:// localhost / 127.0.0.1 (/ [::1]) is ALLOWED so local dev servers
//       like http://localhost:3000 can be configured and built.
//     - https:// URLs are ALWAYS allowed.
//     - http:// for a PUBLIC host is REJECTED ("Public server URLs must use
//       HTTPS.") — arbitrary plaintext traffic is never acceptable.
//
//   production (NODE_ENV === 'production'):
//     - https:// is MANDATORY. Every http:// URL — including loopback — is
//       REJECTED ("Production agent server URLs must use HTTPS.").
//
// Common rejections: malformed URLs, non-HTTP(S) schemes, and URLs carrying
// embedded credentials (which must never be stored or logged).
export type ServerUrlValidation = { ok: true; value: string } | { ok: false; error: string };

export const SERVER_URL_MESSAGES = {
  invalid: 'Enter a valid server URL.',
  scheme: 'Server URL must use HTTP(S).',
  publicHttp: 'Public server URLs must use HTTPS.',
  productionHttp: 'Production agent server URLs must use HTTPS.',
  credentials: 'Server URL must not contain credentials.',
} as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for loopback hosts (localhost, 127.0.0.1, ::1). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host === '::1';
}

export interface ServerUrlPolicy {
  /** HTTPS is mandatory; every http:// URL (loopback included) is rejected. */
  requireHttps: boolean;
}

/** Environment-aware policy. Production = HTTPS-only; anything else allows loopback http. */
export function serverUrlPolicy(env?: string): ServerUrlPolicy {
  return { requireHttps: (env ?? process.env.NODE_ENV) === 'production' };
}

/**
 * Validate a candidate agent server URL against the canonical policy.
 * Returns the normalized (trailing-slash-stripped) value on success, or an
 * actionable message on failure. Never logs or returns credentials.
 */
export function validateServerUrl(raw: unknown, opts: { env?: string } = {}): ServerUrlValidation {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: SERVER_URL_MESSAGES.invalid };
  }
  const value = raw.trim().replace(/\/+$/, '');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: SERVER_URL_MESSAGES.invalid };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: SERVER_URL_MESSAGES.scheme };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: SERVER_URL_MESSAGES.credentials };
  }

  if (parsed.protocol === 'http:') {
    if (serverUrlPolicy(opts.env).requireHttps) {
      return { ok: false, error: SERVER_URL_MESSAGES.productionHttp };
    }
    if (!isLoopbackHost(parsed.hostname)) {
      return { ok: false, error: SERVER_URL_MESSAGES.publicHttp };
    }
  }

  return { ok: true, value };
}
