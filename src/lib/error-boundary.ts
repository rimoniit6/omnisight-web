// OmniSight — response-error boundary (hardening area 5).
//
// Single choke point for "what error string may leave the server". Routes
// commonly did `error.message` / `String(err)` straight into a JSON response
// (or a per-item failure payload) — which leaks Prisma internals, connection
// strings, query shapes or provider stack traces to clients.
//
// Policy, enforced here once:
//   - Developer-authored domain errors (thrown deliberately WITH a
//     client-facing message, e.g. validation) pass through unchanged.
//   - Anything from a database/prov iterator/unknown origin is collapsed to a
//     stable fallback — no verbatim internal detail, no stack traces, no
//     secrets (the regex is a second net for common sensitive fragments).
//   - Non-Error throws are always collapsed.
//
// Use it at every place a catch block feeds an error string back to the
// caller. Logging stays verbatim (log.error with String(err)) so operators
// keep full detail; only the RESPONSE body is sanitized.

/** Error names whose messages are DB/engine internals — never client-safe. */
const INTERNAL_ERROR_NAMES = new Set([
  'PrismaClientKnownRequestError',
  'PrismaClientValidationError',
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
  'PrismaClientUnknownRequestError',
  'NotFoundError', // Prisma required-record guard
  'MongoServerError',
  'MongooseError',
  'ConnectionError',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
]);

/** Common sensitive fragments that must never appear in a client response. */
const SENSITIVE_FRAGMENTS = /(password|secret|token|postgres|sqlserver|connectionstring|DATABASE_URL|api[_-]?key|bearer\s|private\s+key)/i;

export function toClientMessage(error: unknown, fallback = 'Internal server error'): string {
  if (error instanceof Error) {
    if (INTERNAL_ERROR_NAMES.has(error.name)) return fallback;
    if (typeof error.message === 'string' && error.message.trim() !== '' && !SENSITIVE_FRAGMENTS.test(error.message)) {
      return error.message;
    }
  }
  return fallback;
}

/** Error type guard for routes that branch on known client-safe error classes. */
export function isClientSafeError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    !INTERNAL_ERROR_NAMES.has(error.name) &&
    typeof error.message === 'string' &&
    error.message.trim() !== '' &&
    !SENSITIVE_FRAGMENTS.test(error.message)
  );
}