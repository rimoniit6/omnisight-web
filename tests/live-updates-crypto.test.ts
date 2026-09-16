/**
 * LIVE-UPDATES CRYPTO — standalone decryption parity with @/lib/crypto.
 *
 * Regression for: CUSTOMER_DB org-e2e-cust live-updates connection failing
 * with "Authentication failed ... for omnisight_user". The standalone
 * decryptor must decrypt the v1: envelope written by src/lib/crypto.ts
 * encryptSecret using the SAME key derivation:
 *
 *   LC-01  Dev round-trip  → .worklens/dev.key encrypt ↔ decrypt
 *   LC-02  Prod round-trip → ENCRYPTION_KEY encrypt ↔ decrypt (never JWT)
 *   LC-03  Legacy JWT_SECRET-derived envelope still decrypts (dev migration)
 *   LC-04  Tampered / malformed envelope fails closed to ''
 *   LC-05  Legacy plaintext passes through unchanged
 *   LC-06  Parity vs canonical decryptSecretWithMeta over sample values
 *
 * Run: npx tsx --test tests/live-updates-crypto.test.ts
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'crypto';
import { decryptSecret as standaloneDecrypt } from '../mini-services/live-updates/crypto';
import { decryptSecretWithMeta, encryptSecret } from '../src/lib/crypto';

const TEST_ENCRYPTION_KEY = 'omnisight-live-updates-test-key-0123456789';
const TEST_JWT_SECRET = 'omnisight-live-updates-test-jwt-9876543210';

const ORIGINAL = {
  nodeEnv: process.env.NODE_ENV,
  encryptionKey: process.env.ENCRYPTION_KEY,
  jwtSecret: process.env.JWT_SECRET,
};

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.NODE_ENV = 'development';
});

after(() => {
  if (ORIGINAL.nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL.nodeEnv;
  if (ORIGINAL.encryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL.encryptionKey;
  if (ORIGINAL.jwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL.jwtSecret;
});

function buildLegacyJwtEnvelope(plaintext: string): string {
  const key = createHash('sha256').update(TEST_JWT_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

test('LC-01: dev round-trip — canonical encrypt ↔ standalone decrypt via .worklens/dev.key', () => {
  const plain = 'S3cure!CustDbPassDevRoundTrip';
  const envelope = encryptSecret(plain);
  assert.ok(envelope.startsWith('v1:'), 'envelope uses v1: prefix');
  assert.equal(standaloneDecrypt(envelope), plain);
});

test('LC-02: production round-trip — ENCRYPTION_KEY encrypt ↔ decrypt, JWT_SECRET ignored', () => {
  process.env.NODE_ENV = 'production';
  const plain = 'S3cure!CustDbPassProdRoundTrip';
  const envelope = encryptSecret(plain);
  assert.equal(standaloneDecrypt(envelope), plain);

  // A JWT_SECRET-derived key must NOT decrypt it (never JWT fallback in prod).
  const jwtKeyEnvelope = buildLegacyJwtEnvelope(plain);
  assert.equal(standaloneDecrypt(jwtKeyEnvelope), '', 'JWT-derived envelope must fail closed in production');
});

test('LC-03: legacy JWT_SECRET-derived envelope still decrypts in development', () => {
  const plain = 'S3cure!LegacyJwtDerivedValue';
  const envelope = buildLegacyJwtEnvelope(plain);
  assert.equal(standaloneDecrypt(envelope), plain);
});

test('LC-04: tampered / malformed envelopes fail closed to empty string', () => {
  const plain = 'S3cure!TamperResistant';
  const envelope = encryptSecret(plain);
  const tampered = envelope.slice(0, -4) + 'AAAA';
  assert.equal(standaloneDecrypt(tampered), '');
  assert.equal(standaloneDecrypt('v1:not-a-valid-envelope'), '');
  assert.equal(standaloneDecrypt(''), '');
});

test('LC-05: legacy plaintext values pass through unchanged', () => {
  assert.equal(standaloneDecrypt('plaintext-legacy-password'), 'plaintext-legacy-password');
});

test('LC-06: parity with canonical decryptSecretWithMeta over sample values', () => {
  const samples = ['S3cure!Alpha', 'S3cure!Beta 123', 'dfqO87#2!!zkMnq9'];
  for (const plain of samples) {
    const envelope = encryptSecret(plain);
    const canonical = decryptSecretWithMeta(envelope).plaintext;
    assert.equal(canonical, plain, 'canonical decrypts its own envelope');
    assert.equal(standaloneDecrypt(envelope), canonical, 'standalone matches canonical');
  }
});