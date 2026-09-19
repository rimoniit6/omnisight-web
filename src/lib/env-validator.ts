// OmniSight — Canonical environment variable validation (production-grade)
//
// Central, validated access to process.env. `validateEnv()` fails fast with a
// clear message on startup when a required variable is missing, so a
// misconfigured deployment surfaces immediately instead of failing sideways at
// request time.
//
// The original `src/lib/env.ts` is now a thin re-export of this module so every
// existing `@/lib/env` import keeps working unchanged. Always prefer importing
// from `@/lib/env-validator` for new code.
//
// It is deliberately NOT invoked at import time: modules are loaded in many
// contexts (tests set env before importing), so validation is an explicit
// startup step (see src/instrumentation.ts register()) plus a standalone CLI.
//
// Strictness policy:
//   • REQUIRED — the app cannot boot without these (DATABASE_URL, JWT_SECRET).
//   • PRODUCTION — extra hard requirements when NODE_ENV=production
//     (ENCRYPTION_KEY) plus placeholder/weak-secret rejection for every secret.
//   • OPTIONAL-BUT-VALIDATED — optional service keys/URLs (storage, email, AI,
//     Slack) that degrade gracefully when absent. If one IS set it must be
//     well-formed (valid URL / expected prefix / sane length); a malformed or
//     truncated value is treated as a startup error because it signals a
//     copy/paste or editing bug, not a disabled integration.

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

// Optional URL/DTO validators applied ONLY when the variable is non-empty.
const httpUrl = z.string().url('must be a valid http(s) URL');
const httpsUrl = z.string().url('must be a valid https URL').refine((v) => v.startsWith('https://'), {
  message: 'must use https://',
});
const resendApiKey = z.string().refine((v) => v.startsWith('re_'), {
  message: 'must be a Resend API key starting with re_',
});
const slackWebhook = z.string().refine((v) => v.startsWith('https://hooks.slack.com/'), {
  message: 'must be a Slack incoming webhook URL (https://hooks.slack.com/...)',
});
const serviceUrl = z.preprocess((v) => (v === '' ? undefined : v), httpUrl.optional());
const positiveInt = z.coerce.number().int().positive();

// ─── Result type ────────────────────────────────────────────────────────────

export interface EnvValidationResult {
  ok: boolean;
  errors: string[];
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function optionalValidated(
  env: Record<string, string | undefined>,
  name: string,
  schema: z.ZodType,
  errors: string[],
): void {
  const raw = env[name];
  if (raw === undefined || raw === '') return;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`${name} ${issue.message}`);
    }
  }
}

function optionalBoolean(env: Record<string, string | undefined>, name: string, errors: string[]): void {
  const raw = env[name];
  if (raw === undefined || raw === '') return;
  if (!/^(true|false|1|0)$/i.test(raw)) {
    errors.push(`${name} must be true/false/1/0 when set (got: "${raw}")`);
  }
}

function optionalInt(env: Record<string, string | undefined>, name: string, errors: string[]): void {
  const raw = env[name];
  if (raw === undefined || raw === '') return;
  const parsed = positiveInt.safeParse(raw);
  if (!parsed.success) {
    errors.push(`${name} must be a positive integer when set (got: "${raw}")`);
  }
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

// ─── Public validation API ──────────────────────────────────────────────────

/**
 * Validate the current process.env. Returns a structured result; also throws a
 * clear aggregate error when a required variable is missing (fail-fast).
 *
 * Reads the raw process.env fresh on every call so tests that set variables
 * between imports are still validated correctly.
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

  if (isProduction) {
    assertSecretError(env.SUPER_ADMIN_PASSWORD, 'SUPER_ADMIN_PASSWORD', 12, errors);
  }

  // ── Optional-but-validated surface ────────────────────────────────────
  // Storage driver consistency.
  const storageDriver = env.STORAGE_DRIVER;
  if (storageDriver !== undefined && storageDriver !== '' && !['local', 'supabase'].includes(storageDriver)) {
    errors.push(`STORAGE_DRIVER must be 'local' or 'supabase' when set (got: "${storageDriver}")`);
  }
  if (storageDriver === 'supabase') {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      errors.push('STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    }
    if (env.SUPABASE_URL) optionalValidated(env, 'SUPABASE_URL', httpsUrl, errors);
  } else {
    optionalValidated(env, 'SUPABASE_URL', httpsUrl, errors);
    optionalValidated(env, 'SUPABASE_SERVICE_ROLE_KEY', z.string().min(16), errors);
  }
  optionalBoolean(env, 'OMNISIGHT_ALLOW_INSECURE_STORAGE_URLS', errors);

  // Email / branding.
  optionalValidated(env, 'RESEND_API_KEY', resendApiKey, errors);
  optionalValidated(env, 'EMAIL_FROM_ADDRESS', z.string().email().trim(), errors);
  optionalValidated(env, 'APP_URL', httpUrl, errors);
  optionalValidated(env, 'NEXT_PUBLIC_APP_URL', httpUrl, errors);
  optionalValidated(env, 'NEXT_PUBLIC_LIVE_UPDATES_URL', httpUrl, errors);

  // AI / transcription.
  optionalValidated(env, 'TRANSCRIPTION_SERVICE_URL', httpUrl, errors);
  optionalValidated(env, 'TRANSCRIPTION_API_KEY', z.string().min(8), errors);

  // Notifications / observability.
  optionalValidated(env, 'SLACK_WEBHOOK_URL', slackWebhook, errors);
  optionalValidated(env, 'METRICS_TOKEN', z.string().min(8), errors);

  // Sessions / auth.
  optionalValidated(env, 'SESSION_COOKIE_NAME', z.string().min(1), errors);
  optionalValidated(env, 'JWT_EXPIRES_IN', z.string().min(1), errors);

  // Demo / seed — fake/test values are FINE for these (never real keys).
  optionalValidated(env, 'DEMO_USER_EMAIL', z.string().email().trim(), errors);
  optionalValidated(env, 'DEMO_USER_NAME', z.string().min(1), errors);
  optionalBoolean(env, 'SEED_ALLOWED', errors);

  // SSRF guard.
  optionalBoolean(env, 'OMNISIGHT_ALLOW_PRIVATE_TARGETS', errors);

  // Presence.
  optionalInt(env, 'PRESENCE_ONLINE_THRESHOLD_MS', errors);

  // Job scheduler intervals.
  optionalInt(env, 'JOBS_INTERVAL_SECONDS', errors);
  optionalInt(env, 'PROJECT_TIME_SYNC_INTERVAL_SECONDS', errors);
  optionalInt(env, 'SCREENSHOT_PROCESSING_INTERVAL_SECONDS', errors);
  optionalInt(env, 'SYNC_DEVICE_COUNT_INTERVAL_SECONDS', errors);
  optionalInt(env, 'INFRA_MIGRATION_INTERVAL_SECONDS', errors);

  const result: EnvValidationResult = { ok: errors.length === 0, errors };
  if (!result.ok) {
    throw new Error(
      `Environment validation failed:\n- ${errors.join('\n- ')}\n\n` +
        'Fix the missing/incorrect variables (see .env.production.example) and restart.'
    );
  }
  return result;
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

// ─── Interval helper (shared with instrumentation/job schedulers) ───────────

/**
 * Read a job-scheduler interval from an env var with a floor and a default:
 *   readIntervalSeconds('JOBS_INTERVAL_SECONDS', 3600, 60)
 * A missing/invalid value falls back to `defaultSeconds`; anything below the
 * floor is clamped up to the floor. Used by every scheduler so the cadence
 * parsing lives in exactly one place.
 */
export function readIntervalSeconds(name: string, defaultSeconds: number, minSeconds: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  const value = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSeconds;
  return Math.max(value, minSeconds);
}

// ─── Convenience booleans (read-only, no validation side-effects) ──────────

export const isProd = process.env.NODE_ENV === 'production';