/**
 * P0 Secret-Hygiene Guard — regression tests.
 *
 * Covers the P0 remediation contract:
 *   1. placeholder / weak production secrets are rejected by assertProductionSecret
 *   2. the tracked env TEMPLATES contain only placeholders (never real secrets)
 *   3. validateSuperAdminEnv rejects weak/default Super Admin credentials
 *      (including the previously-bundled Rimon0000000 pattern)
 *   4. legitimate production-shaped secrets (random hex/base64, CI-style) pass
 *   5. validateEnv fails fast on placeholder secrets in production
 *
 * Run: npx tsx --test tests/secret-guard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assertProductionSecret } from '../src/lib/auth';
import { validateSuperAdminEnv } from '../src/lib/super-admin';

// ─── assertProductionSecret: rejection cases ────────────────────────────────

test('PG-01: missing and too-short secrets are rejected', () => {
  assert.throws(() => assertProductionSecret('', 'JWT_SECRET', 16), /must be set in the environment/);
  assert.throws(() => assertProductionSecret('short', 'JWT_SECRET', 16), /at least 16 characters/);
});

test('PG-02: tracked template placeholders are rejected', () => {
  assert.throws(
    () => assertProductionSecret('CHANGE_ME_GENERATE_A_64_CHAR_RANDOM_SECRET', 'JWT_SECRET', 16),
    /placeholder/i
  );
  assert.throws(
    () => assertProductionSecret('CHANGE_ME_GENERATE_A_32_BYTE_KEY_HEX', 'ENCRYPTION_KEY', 16),
    /placeholder/i
  );
  assert.throws(
    () => assertProductionSecret('CHANGE_ME_USE_A_STRONG_UNIQUE_PASSWORD', 'SUPER_ADMIN_PASSWORD', 12),
    /placeholder/i
  );
});

test('PG-03: obvious placeholder and default patterns are rejected', () => {
  for (const value of [
    'your-honest-to-goodness-placeholder',
    'example-secret-that-is-16chars',
    'password-1234567890',
    'superadmin-tier-secret',
    'secret-placeholder-value',
    'localhost-local-credential',
    'replace-with-a-random-value',
  ]) {
    assert.throws(() => assertProductionSecret(value, 'JWT_SECRET', 16), /placeholder|weak|low-entropy/i, value);
  }
});

test('PG-04: low-entropy and numeric-only secrets are rejected', () => {
  const zeros = '0'.repeat(64);
  assert.throws(() => assertProductionSecret(zeros, 'ENCRYPTION_KEY', 16), /low-entropy/i);
  assert.throws(() => assertProductionSecret('a'.repeat(32), 'JWT_SECRET', 16), /low-entropy/i);
  assert.throws(() => assertProductionSecret('1234567890123456', 'JWT_SECRET', 16), /low-entropy|numeric/i);
});

// ─── assertProductionSecret: acceptance cases ───────────────────────────────

test('PG-05: legitimate production-shaped secrets are accepted', () => {
  // 64-char random hex (the shape the docs instruct operators to generate).
  const hex64 = 'c3a7f14e9b2d48a07e51f6c9d3a2b8e4f1c6d90a3b7e5d8f2c4a6b9e0d1f7a3b5';
  assert.doesNotThrow(() => assertProductionSecret(hex64, 'ENCRYPTION_KEY', 16));
  // openssl rand -base64 48 shaped value (48 chars, base64 alphabet).
  const b64 = 'HyS7mNq2vXw8Kp1RzT4uQeA6cF0dG5jL9oIbWn3sHrTaB';
  assert.doesNotThrow(() => assertProductionSecret(b64, 'JWT_SECRET', 16));
  const b64withPadding = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYxMjM0NTY3ODk=';
  assert.doesNotThrow(() => assertProductionSecret(b64withPadding, 'JWT_SECRET', 16));
  // CI-style prefixed secret (validateEnv / test flows must keep passing).
  assert.doesNotThrow(
    () => assertProductionSecret('ci-jwt-secret-0123456789abcdef-0123456789abcdef', 'JWT_SECRET', 16)
  );
});

// ─── Tracked templates must contain placeholders only ───────────────────────

test('PG-06: tracked env templates contain placeholders, never real secrets', () => {
  for (const file of ['.env.example', '.env.production.example']) {
    const content = readFileSync(join(process.cwd(), file), 'utf8');
    const line = (key: string) =>
      content.split('\n').find((l) => l.startsWith(`${key}=`)) ?? '';

    const jwt = line('JWT_SECRET');
    const key = line('ENCRYPTION_KEY');
    const pw = line('SUPER_ADMIN_PASSWORD');
    const email = line('SUPER_ADMIN_EMAIL');

    // Real production-shaped 64-hex secrets must never appear in templates.
    assert.doesNotMatch(content, /^(JWT_SECRET|ENCRYPTION_KEY)=[0-9a-fA-F]{64}$/m, file);
    // Each secret slot must be an unmistakable placeholder.
    assert.match(jwt, /^JWT_SECRET=CHANGE_ME_/i, file);
    assert.match(key, /^ENCRYPTION_KEY=CHANGE_ME_/i, file);
    assert.match(pw, /^SUPER_ADMIN_PASSWORD=CHANGE_ME_/i, file);
    assert.match(email, /^SUPER_ADMIN_EMAIL=CHANGE_ME_/i, file);
  }
});

// ─── validateSuperAdminEnv: weak Super Admin credentials ────────────────────

test('PG-07: the previously-bundled weak Super Admin credential is rejected', () => {
  assert.throws(
    () =>
      validateSuperAdminEnv({
        SUPER_ADMIN_EMAIL: 'super-admin@example.invalid',
        SUPER_ADMIN_PASSWORD: 'Rimon0000000',
      }),
    /placeholder|weak/i
  );
});

test('PG-08: placeholder and patterned-weak Super Admin credentials are rejected', () => {
  for (const password of [
    'CHANGE_ME_USE_A_STRONG_UNIQUE_PASSWORD',
    'Password12345678',
    'ExampleSecret123',
    'admin1234567890',
    'password1234567890',
  ]) {
    assert.throws(
      () =>
        validateSuperAdminEnv({
          SUPER_ADMIN_EMAIL: 'super-admin@example.invalid',
          SUPER_ADMIN_PASSWORD: password,
        }),
      /placeholder|weak|low-entropy/i,
      password
    );
  }
});

test('PG-09: placeholder Super Admin emails are rejected', () => {
  for (const email of ['CHANGE_ME@example.invalid', 'admin@example.com', 'yourname@example.com']) {
    assert.throws(
      () => validateSuperAdminEnv({ SUPER_ADMIN_EMAIL: email, SUPER_ADMIN_PASSWORD: '9F#kL2!mQ8$vR5tW1' }),
      /placeholder/i,
      email
    );
  }
});

test('PG-10: legitimate strong Super Admin credentials are accepted', () => {
  for (const [email, password] of [
    ['ops@example.com', 'Test-Password-123'],
    ['ops@example.com', 'S3cure!Pass1x'],
    ['ops@example.com', 'Tr0ub4dur!xCorrect'],
    ['ops@example.com', '9F#kL2!mQ8$vR5tW1&xY6'],
    ['ci@omnisight.test', 'CiSuperAdmin-Test-1234'],
  ]) {
    const parsed = validateSuperAdminEnv({ SUPER_ADMIN_EMAIL: email, SUPER_ADMIN_PASSWORD: password });
    assert.equal(parsed.email, email);
    assert.equal(parsed.password, password);
  }
});

// ─── validateEnv fail-fast on placeholders ──────────────────────────────────

test('PG-11: validateEnv fails fast on placeholder secrets in production', async () => {
  const prevEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db?schema=public';
  process.env.JWT_SECRET = 'CHANGE_ME_GENERATE_A_64_CHAR_RANDOM_SECRET';
  process.env.ENCRYPTION_KEY = 'CHANGE_ME_GENERATE_A_32_BYTE_KEY_HEX';
  try {
    const envModule = await import('../src/lib/env');
    assert.throws(() => envModule.validateEnv(), /placeholder/i);
  } finally {
    const keys = Object.keys(process.env);
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, prevEnv);
  }
});