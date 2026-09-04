// OmniSight — per-organization customization (AI provider + analytics DB).
//
// OrganizationSettings stores per-tenant configuration that an Org Admin can
// customize. Sensitive fields (aiApiKey, dbPassword) are encrypted at rest via
// src/lib/crypto.ts and are NEVER returned in plaintext by any API.
//
// This module centralizes the fetch/serialize/upsert logic shared by the
// /api/organizations/[orgId]/settings/* routes.

import { db } from '@/lib/db';
import { encryptSecret, decryptSecretWithMeta, isEncryptedSecret } from '@/lib/crypto';

export type AiProvider = 'openai' | 'anthropic' | 'groq' | 'google' | 'mistral' | 'custom' | 'ollama';

export const AI_PROVIDERS: AiProvider[] = [
  'openai',
  'anthropic',
  'groq',
  'google',
  'mistral',
  'ollama',
  'custom',
];

export interface OrgSettingsSerialized {
  id: string | null;
  organizationId: string;
  // AI provider
  aiProvider: string | null;
  hasAiKey: boolean;
  aiApiKeyLast4: string | null;
  aiBaseUrl: string | null;
  aiModel: string | null;
  // Analytics DB
  useOwnDb: boolean;
  dbHost: string | null;
  dbPort: number | null;
  dbName: string | null;
  dbUser: string | null;
  hasDbPassword: boolean;
  dbSsl: boolean;
  // Test status
  aiTestedAt: string | null;
  aiTestStatus: string | null;
  dbTestedAt: string | null;
  dbTestStatus: string | null;
}

/**
 * Read (or lazily create) the OrganizationSettings row for an org.
 */
export async function getOrgSettings(orgId: string) {
  return db.organizationSettings.upsert({
    where: { organizationId: orgId },
    update: {},
    create: { organizationId: orgId },
  });
}

/**
 * Produce a SAFE serializable view. aiApiKey / dbPassword are replaced with a
 * boolean "has <secret>" flag — the plaintext (and the encrypted envelope) is
 * never returned to the client. The API key last-4 is included so the UI can
 * show which key is configured without exposing it.
 */
export function serializeOrgSettings(s: {
  id: string;
  organizationId: string;
  aiProvider: string | null;
  aiApiKey: string | null;
  aiBaseUrl: string | null;
  aiModel: string | null;
  useOwnDb: boolean;
  dbHost: string | null;
  dbPort: number | null;
  dbName: string | null;
  dbUser: string | null;
  dbPassword: string | null;
  dbSsl: boolean;
  aiTestedAt: Date | null;
  aiTestStatus: string | null;
  dbTestedAt: Date | null;
  dbTestStatus: string | null;
}): OrgSettingsSerialized {
  return {
    id: s.id,
    organizationId: s.organizationId,
    aiProvider: s.aiProvider,
    hasAiKey: Boolean(s.aiApiKey && isEncryptedSecret(s.aiApiKey) ? true : s.aiApiKey),
    aiApiKeyLast4: s.aiApiKey ? decryptSecretWithMeta(s.aiApiKey).plaintext.slice(-4) : null,
    aiBaseUrl: s.aiBaseUrl,
    aiModel: s.aiModel,
    useOwnDb: s.useOwnDb,
    dbHost: s.dbHost,
    dbPort: s.dbPort,
    dbName: s.dbName,
    dbUser: s.dbUser,
    hasDbPassword: Boolean(s.dbPassword),
    dbSsl: s.dbSsl,
    aiTestedAt: s.aiTestedAt ? s.aiTestedAt.toISOString() : null,
    aiTestStatus: s.aiTestStatus,
    dbTestedAt: s.dbTestedAt ? s.dbTestedAt.toISOString() : null,
    dbTestStatus: s.dbTestStatus,
  };
}

/**
 * Encrypt a plaintext secret ONLY if it changed (a client sending a
 * placeholder marker back must not re-encrypt the stored value). Returns the
 * value to persist, or undefined when nothing changed.
 */
export function maybeEncryptSecret(
  incoming: string | undefined,
  currentlyStored: string | null
): string | undefined {
  if (incoming === undefined) return undefined;
  if (incoming === '') {
    // Clearing the secret.
    return null as unknown as string;
  }
  // Client must send the literal marker to mean "unchanged".
  if (incoming === '••••••' || incoming === 'keep' || incoming === 'unchanged') {
    return currentlyStored ?? undefined;
  }
  return encryptSecret(incoming);
}
