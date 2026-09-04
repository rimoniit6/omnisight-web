// OmniSight — Self-hosted / license configuration
//
// Reads deployment mode + license key from environment variables. License keys
// are secret: this module is the ONLY place that reads LICENSE_KEY, and callers
// must never log or serialize the returned value.

// True when this instance is deployed as a self-hosted/on-prem build.
// Cloud (default): license checks are bypassed entirely.
export const isSelfHosted = process.env.SELF_HOSTED === 'true';

// Returns the configured license key, or null when not set / cloud mode.
// NOTE: treat the result as secret — never log it or expose it in responses.
export function getLicenseKey(): string | null {
  if (!isSelfHosted) return null;
  const key = process.env.LICENSE_KEY?.trim();
  return key && key.length > 0 ? key : null;
}
