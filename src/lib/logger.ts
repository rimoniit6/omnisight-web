// ─── Structured logger ─────────────────────────────────────────────────────
// Emits single-line JSON logs for machines (pino-style ingestion) while
// staying dependency-free. Redacts sensitive fields by default so that
// passwords, JWTs, API keys and session cookies never reach the logs.
//
// Usage:
//   log.info('auth.login.success', { userId, orgId });
//   log.warn('auth.login.failed', { reason: 'bad_password', ip }, { req });
//   log.error('ai.provider.failed', { provider }, { err });

import { getClientIpFromHeaders, UNKNOWN_CLIENT_IP } from './client-ip';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Field names that must never be logged verbatim.
const SENSITIVE_FIELDS = new Set([
  'password',
  'pass',
  'pwd',
  'token',
  'jwt',
  'authorization',
  'apikey',
  'api_key',
  'apikeys',
  'secret',
  'secretkey',
  'cookie',
  'sessioncookie',
  'x-api-key',
]);

const SENSITIVE_VALUE_PATTERNS = [
  /^Bearer\s+.+$/i,
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT
];

function redactKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[-_]/g, '');
  for (const s of SENSITIVE_FIELDS) {
    if (k === s || k.includes(s)) return true;
  }
  return false;
}

function isSensitiveValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value));
}

function sanitize(input: unknown, depth = 0): unknown {
  if (input === null || typeof input === 'undefined') return input;
  if (typeof input === 'string') {
    return isSensitiveValue(input) ? '[REDACTED]' : input;
  }
  if (typeof input !== 'object') return input;
  if (depth > 4) return '[DEPTH_LIMIT]';

  if (input instanceof Error) {
    return {
      name: input.name,
      message: input.message,
      stack: input.stack?.split('\n').slice(0, 8).join('\n'),
    };
  }

  if (Array.isArray(input)) {
    return input.slice(0, 50).map((item) => sanitize(item, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (redactKey(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = sanitize(value, depth + 1);
    }
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Extract a request id / client ip for correlation without logging the token. */
export function requestContext(req?: { headers?: Headers | { get(name: string): string | null } }): {
  requestId?: string;
  ip?: string;
  userAgent?: string;
} {
  if (!req?.headers) return {};
  const headers = req.headers;
  const get = (name: string) =>
    typeof headers.get === 'function' ? headers.get(name) : null;

  const requestId =
    get('x-request-id') ||
    get('x-correlation-id') ||
    get('x-vercel-id') ||
    undefined;
  // Client IP via the CANONICAL spoof-resistant resolver (same right-most
  // XFF / x-real-ip trust model as rate limiting and audit logging) so log
  // correlation can never disagree with the security-relevant identity.
  const resolvedIp =
    typeof headers.get === 'function'
      ? getClientIpFromHeaders(headers as Headers)
      : undefined;
  const ip = resolvedIp && resolvedIp !== UNKNOWN_CLIENT_IP ? resolvedIp : undefined;
  const userAgent = get('user-agent');

  return {
    ...(requestId ? { requestId } : {}),
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent: userAgent.slice(0, 120) } : {}),
  };
}

export interface LogFields {
  [key: string]: unknown;
}

function write(level: LogLevel, event: string, fields?: LogFields, ctx?: LogFields): void {
  const entry: LogFields = {
    time: nowIso(),
    level,
    event,
    ...(ctx ?? {}),
    ...(sanitize(fields ?? {}) as LogFields),
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (event: string, fields?: LogFields, ctx?: LogFields) =>
    write('debug', event, fields, ctx),
  info: (event: string, fields?: LogFields, ctx?: LogFields) =>
    write('info', event, fields, ctx),
  warn: (event: string, fields?: LogFields, ctx?: LogFields) =>
    write('warn', event, fields, ctx),
  error: (event: string, fields?: LogFields, ctx?: LogFields) =>
    write('error', event, fields, ctx),
};
