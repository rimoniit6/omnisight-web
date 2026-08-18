// AI Insights — provider failure classification.
//
// Normalizes the raw (already-safe) provider error codes from
// callAIProvider into a small set of internal reason codes that the API
// exposes to the frontend. NEVER exposes API keys, raw provider payloads, or
// secrets — the UI may receive { code: "PROVIDER_QUOTA_EXCEEDED" } but never
// the API key or the raw provider body.

export type FallbackReason =
  | 'PROVIDER_DISABLED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROVIDER_UNKNOWN_ERROR';

/** Reason code attached when the ai_insights_enabled toggle is off. */
export const REASON_DISABLED: FallbackReason = 'PROVIDER_DISABLED';

/**
 * Map a raw provider error code (or a missing/unknown one) to a safe
 * internal FallbackReason. The mapping is lossy on purpose: the UI only needs
 * the category, never provider internals.
 */
export function normalizeFallbackReason(rawError: string | undefined | null): FallbackReason {
  switch (rawError) {
    case 'AI_PROVIDER_NOT_CONFIGURED':
    case 'AI_INVALID_BASE_URL':
    case 'AI_MODEL_MISSING':
    case 'AI_UNKNOWN_PROVIDER':
    case 'AI_CONFIG_INCOMPATIBLE':
      return 'PROVIDER_NOT_CONFIGURED';
    case 'AI_KEY_MISSING':
    case 'AI_KEY_DECRYPT_FAILED':
      return 'PROVIDER_NOT_CONFIGURED';
    case 'AI_HTTP_401':
    case 'AI_HTTP_403':
      return 'PROVIDER_AUTH_FAILED';
    case 'AI_HTTP_404':
      return 'PROVIDER_NOT_FOUND';
    case 'AI_HTTP_429':
      return 'PROVIDER_RATE_LIMITED';
    case 'AI_HTTP_500':
    case 'AI_HTTP_502':
    case 'AI_HTTP_503':
      return 'PROVIDER_UNAVAILABLE';
    case 'AI_REQUEST_FAILED':
      return 'PROVIDER_TIMEOUT';
    case 'AI_RESPONSE_INVALID':
      return 'PROVIDER_INVALID_RESPONSE';
    default:
      return 'PROVIDER_UNKNOWN_ERROR';
  }
}
