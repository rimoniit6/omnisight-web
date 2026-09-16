// OmniSight — Live Updates: standalone AES-256-GCM secret decryption.
//
// The live-updates service is a standalone Bun process and cannot import the
// main app's crypto module (@/lib/crypto uses the @/ alias and @/lib/auth).
// This module reimplements EXACTLY the envelope format and key derivation so
// that OrganizationSettings.dbPassword (encrypted by the app) decrypts here.
//
//   envelope:  v1:<iv-b64>:<tag-b64>:<ciphertext-b64>   (src/lib/crypto.ts)
//
//   key:       production  -> sha256(ENCRYPTION_KEY)     (never JWT_SECRET)
//              development -> sha256 content of .worklens/dev.key
//                             (per-workspace file, cwd/project-root relative)
//              legacy dev  -> sha256(JWT_SECRET) only as a migration fallback
//                             for pre-Phase-4 envelopes (mirrors crypto.ts)
//
// SECURITY: fails closed — wrong, tampered, or malformed values decrypt to ''.
// Credentials are never logged.

import { createHash, createDecipheriv } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_PREFIX = 'v1:';

/**
 * Resolve the repository root (the directory containing prisma/schema.prisma).
 * The dev key file lives at <root>/.worklens/dev.key; it is also where the
 * standalone service must resolve "file:" datasource URLs relative to.
 */
export function resolveProjectRoot(startDir = process.cwd()): string {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'prisma', 'schema.prisma'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

function sha256Key(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

// Production: dedicated ENCRYPTION_KEY only (mirrors crypto.ts getEncryptionKey).
function productionKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || raw.length < 16) return null;
  return sha256Key(raw);
}

// Development: per-workspace key persisted in .worklens/dev.key (mirrors
// crypto.ts getDevKey). The key is NEVER derived from JWT_SECRET for new
// encryptions.
function devKey(): Buffer | null {
  try {
    const keyFile = path.join(resolveProjectRoot(), '.worklens', 'dev.key');
    if (existsSync(keyFile)) {
      const stored = readFileSync(keyFile, 'utf8').trim();
      if (stored.length >= 16) return sha256Key(stored);
    }
  } catch {
    // fall through to fail-closed
  }
  return null;
}

function activeKey(): Buffer | null {
  return process.env.NODE_ENV === 'production' ? productionKey() : devKey();
}

// Migration fallback (development only): pre-Phase-4 envelopes were encrypted
// under JWT_SECRET. Mirrors crypto.ts decryptSecretWithMeta's legacy path.
function legacyJwtKey(): Buffer | null {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 16) return null;
  return sha256Key(raw);
}

function tryDecryptEnvelope(envelope: string, key: Buffer): string | null {
  try {
    const payload = envelope.slice(ENVELOPE_PREFIX.length);
    const [ivB64, tagB64, dataB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !dataB64) return null;
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return plaintext.toString('utf-8');
  } catch {
    return null; // wrong key / tampered value
  }
}

/**
 * Decrypt a value previously encrypted by src/lib/crypto.ts encryptSecret.
 * Legacy plaintext values (never encrypted) pass through unchanged; corrupted
 * or wrong-key values fail closed to ''.
 */
export function decryptSecret(encrypted: string): string {
  if (!encrypted) return '';
  if (!encrypted.startsWith(ENVELOPE_PREFIX)) return encrypted; // legacy plaintext

  const active = activeKey();
  if (active) {
    const plain = tryDecryptEnvelope(encrypted, active);
    if (plain !== null) return plain;
  }

  // Migration path for pre-Phase-4 JWT_SECRET-derived envelopes (dev only).
  if (process.env.NODE_ENV !== 'production') {
    const legacy = legacyJwtKey();
    if (legacy) {
      const plain = tryDecryptEnvelope(encrypted, legacy);
      if (plain !== null) return plain;
    }
  }

  return '';
}