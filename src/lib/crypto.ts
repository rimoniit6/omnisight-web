// OmniSight — Encryption-at-rest for stored secrets (e.g. AI provider API keys)
// AES-256-GCM with a 12-byte random IV per encryption and a 16-byte auth tag.
// The key is derived (SHA-256) from the ENCRYPTION_KEY environment variable so
// any sufficiently strong random string works; rotate by changing the key and
// re-encrypting values.
//
// ENCRYPTION_KEY is INDEPENDENT from JWT_SECRET by design:
//  • Production requires a dedicated ENCRYPTION_KEY — rotating JWT_SECRET must
//    never invalidate stored secrets, and a missing key fails fast instead of
//    silently weakening encryption.
//  • Development: if ENCRYPTION_KEY is absent, a derived dev key is generated
//    once and persisted for the working directory (see getEncryptionKey). This
//    keeps local workflows friction-free while never falling back to JWT_SECRET.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { assertProductionSecret } from '@/lib/auth';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const PREFIX = 'v1:';

// Production: a dedicated ENCRYPTION_KEY is mandatory. Fails fast so a
// misconfiguration is caught at startup rather than at first secret use.
function requireProductionKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  // C-3: Reject known placeholder values; enforce minimum length + no placeholder patterns.
  assertProductionSecret(raw || '', 'ENCRYPTION_KEY', 16);
  return createHash('sha256').update(raw!).digest();
}

// Development: derive a stable per-machine key persisted in .worklens/dev.key
// (gitignored) so encrypted values survive restarts without any env config.
// NEVER falls back to JWT_SECRET — keeping the two secrets independent in dev
// too means a JWT_SECRET rotation can never silently corrupt stored secrets.
function getDevKey(): Buffer {
  const keyFile = path.join(process.cwd(), '.worklens', 'dev.key');
  try {
    if (existsSync(keyFile)) {
      const stored = readFileSync(keyFile, 'utf8').trim();
      if (stored.length >= 16) return createHash('sha256').update(stored).digest();
    }
  } catch {
    // fall through to (re)generate
  }
  const generated = randomBytes(32).toString('hex');
  try {
    mkdirSync(path.dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, generated, { mode: 0o600 });
    // Keep it out of git even if .gitignore is missing an entry.
    if (existsSync(path.join(process.cwd(), '.gitignore'))) {
      const gi = readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');
      if (!gi.includes('.worklens')) {
        writeFileSync(path.join(process.cwd(), '.gitignore'), gi + '\n.worklens/\n');
      }
    }
  } catch {
    // If we cannot persist, derive an ephemeral key so dev still works; the
    // trade-off (values not decryptable after restart) is limited to dev.
    console.warn('[crypto] Could not persist a dev ENCRYPTION_KEY; using an ephemeral key. Set ENCRYPTION_KEY in .env to keep dev secrets stable across restarts.');
    return createHash('sha256').update(generated).digest();
  }
  console.warn('[crypto] Generated a per-workspace dev ENCRYPTION_KEY at .worklens/dev.key. For production set ENCRYPTION_KEY in .env.');
  return createHash('sha256').update(generated).digest();
}

function getEncryptionKey(): Buffer {
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd) return requireProductionKey();
  return getDevKey();
}

/** True if the stored value is an encrypted envelope (v1:...). */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext secret. Format: v1:<iv-b64>:<tag-b64>:<ciphertext-b64>
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const key = getEncryptionKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

// Legacy key derivation used ONLY to migrate envelopes that were encrypted by
// Phase 3 builds which derived the key from JWT_SECRET. After a successful
// migration the value is re-encrypted under ENCRYPTION_KEY; the fallback is
// never used for new encryptions.
function legacyJwtDerivedKey(): Buffer | null {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 16) return null;
  return createHash('sha256').update(raw).digest();
}

function tryDecryptEnvelope(value: string, key: Buffer): string | null {
  try {
    const payload = value.slice(PREFIX.length);
    const [ivB64, tagB64, dataB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch {
    return null; // wrong key / tampered value
  }
}

/**
 * Decrypt a stored secret. Legacy plaintext values (stored before encryption
 * was introduced) are returned as-is so existing installations keep working;
 * callers should persist them back through encryptSecret when convenient.
 *
 * Returns `{ plaintext, migrated }` — `migrated` is true when the value was a
 * legacy JWT_SECRET-derived envelope that callers should persist back under
 * the current key via encryptSecret.
 */
export function decryptSecretWithMeta(value: string): { plaintext: string; migrated: boolean } {
  if (!value) return { plaintext: '', migrated: false };
  if (!isEncryptedSecret(value)) {
    return { plaintext: value, migrated: false }; // legacy plaintext
  }
  const active = tryDecryptEnvelope(value, getEncryptionKey());
  if (active !== null) return { plaintext: active, migrated: false };

  // Migration path for pre-Phase-4 envelopes encrypted under JWT_SECRET.
  if (process.env.NODE_ENV !== 'production') {
    const legacy = legacyJwtDerivedKey();
    if (legacy) {
      const legacyPlain = tryDecryptEnvelope(value, legacy);
      if (legacyPlain !== null) {
        return { plaintext: legacyPlain, migrated: true };
      }
    }
  }
  // Wrong key / tampered value — never fail open with a partial decode.
  return { plaintext: '', migrated: false };
}

/** Backwards-compatible single-string API. */
export function decryptSecret(value: string): string {
  return decryptSecretWithMeta(value).plaintext;
}

/** Mask a secret for logs: first 4 + last 4 chars, e.g. sk-1234…wxyz */
export function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 10) return '***';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
