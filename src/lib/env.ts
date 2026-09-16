// OmniSight — Type-safe environment variable validation
//
// Central, validated access to process.env. `validateEnv()` fails fast with a
// clear message on startup when a required variable is missing, so a
// misconfigured deployment surfaces immediately instead of failing sideways at
// request time.
//
// It is deliberately NOT invoked at import time: modules are loaded in many
// contexts (tests set env before importing), so validation is an explicit
// startup step (see src/instrumentation.ts register()) plus a standalone CLI:

import { z } from 'zod';
import { assertProductionSecret } from '@/lib/auth';

// ─── Schemas ───────────────────────────────────────────────────────────────

// Required in EVERY environment (dev, test, prod, self-hosted). A working
// app cannot boot without these.
const alwaysRequired = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (PostgreSQL connection string)'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
});

// Additional hard requirements for a production (deployed) build.
const productionRequired = z.object({
  ENCRYPTION_KEY: z
    .string()
    .min(1, 'ENCRYPTION_KEY is required in production (32-byte random, hex)'),
});

// NOTE: the self-hosted / license requirement block (SELF_HOSTED, LICENSE_KEY,
// SELF_HOSTED_REQUIRE_LICENSE) was REMOVED with the LicenseKey architecture.
// Self-Hosted is not a V1 service model, so there is nothing to
// license-check at startup.

// ─── Parsers ───────────────────────────────────────────────────────────────

export interface EnvValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate the current process.env. Returns a structured result; also throws a
 * clear aggregate error when a required variable is missing (fail-fast).
 */
export function validateEnv(): EnvValidationResult {
  const env = process.env as Record<string, string | undefined>;
  const errors: string[] = [];

  const always = alwaysRequired.safeParse({ DATABASE_URL: env.DATABASE_URL, JWT_SECRET: env.JWT_SECRET });
  if (!always.success) {
    errors.push(...always.error.issues.map((i) => i.message));
  }

  // Reject known placeholder / weak-default secrets at startup (fail-fast),
  // not just lazily on first sign/encrypt call.
  assertSecretError(env.JWT_SECRET, 'JWT_SECRET', 16, errors);

  const isProduction = env.NODE_ENV === 'production';

  if (isProduction) {
    const prod = productionRequired.safeParse({ ENCRYPTION_KEY: env.ENCRYPTION_KEY });
    if (!prod.success) errors.push(...prod.error.issues.map((i) => i.message));
    assertSecretError(env.ENCRYPTION_KEY, 'ENCRYPTION_KEY', 16, errors);
  }

  const result: EnvValidationResult = { ok: errors.length === 0, errors };
  if (!result.ok) {
    throw new Error(
      `Environment validation failed:\n- ${errors.join('\n- ')}\n\n` +
        'Fix the missing/incorrect variables (see .env.production.example) and restart.'
    );
  }
  return result;
}

/** Push a precise placeholder/weak-secret error for a secret env var if invalid. */
function assertSecretError(
  raw: string | undefined,
  name: string,
  minLength: number,
  errors: string[],
): void {
  try {
    assertProductionSecret(raw || '', name, minLength);
  } catch (err) {
    errors.push(String((err as Error).message));
  }
}

/**
 * Non-throwing variant — returns the validation result only. Useful for UI /
 * diagnostics where a thrown error would be awkward.
 */
export function checkEnv(): EnvValidationResult {
  try {
    return validateEnv();
  } catch (err) {
    return { ok: false, errors: [String((err as Error).message)] };
  }
}

// ─── Convenience booleans (read-only, no validation side-effects) ──────────

export const isProd = process.env.NODE_ENV === 'production';
