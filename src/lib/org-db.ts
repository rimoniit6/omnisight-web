// OmniSight — Optional per-organization ANALYTICS database switching.
//
// The PLATFORM database (organizations, users, subscriptions, plans, licenses,
// settings — via `db` from @/lib/db) is ALWAYS the cloud database. This module
// lets an organization OPTIONALLY point its high-volume analytics data
// (screenshots, activity logs, locations, workday summaries) at a dedicated
// database they manage (self-hosted / BYODB).
//
// Design rules:
//   • We NEVER switch the main `db` client. A separate PrismaClient is created
//     per organization and cached in a Map to avoid recreating clients on every
//     request (and to avoid exhausting connection pools).
//   • The connection string is built from the DECRYPTED dbPassword at the
//     moment the client is created; client instances never re-read env.
//   • Clients are evicted on settings update (invalidateOrgDbCache) and on a
//     periodic sweep to bound the cache size.
//
// NOTE: As of Prompt 6, the analytics read/write paths still use the shared
// cloud schema. getPrismaForOrg is the OPT-IN entry point for routes that opt
// into a per-org analytics DB. Call it from routes that read/write analytics
// data when the org has enabled useOwnDb.

import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';

// Result of resolving which client a request should use.
export type OrgDbClient =
  | { mode: 'cloud'; client: PrismaClient }
  | { mode: 'own'; client: PrismaClient; orgId: string };

// Cache of dedicated analytics clients keyed by organizationId.
const orgDbClients = new Map<string, PrismaClient>();

// Bounded cache: evict stale clients periodically / when too large.
const MAX_CACHED_CLIENTS = 100;

function pruneCache() {
  if (orgDbClients.size > MAX_CACHED_CLIENTS) {
    // Evict the oldest entries (Map preserves insertion order).
    const excess = orgDbClients.size - MAX_CACHED_CLIENTS;
    const keys = [...orgDbClients.keys()];
    for (let i = 0; i < excess; i++) {
      const k = keys[i];
      const client = orgDbClients.get(k);
      // Best-effort disconnect; ignore errors.
      try {
        client?.$disconnect();
      } catch {
        /* ignore */
      }
      orgDbClients.delete(k);
    }
  }
}

/**
 * Invalidate the cached analytics client for an organization (call after the
 * org updates its database settings so the next getPrismaForOrg recreates it).
 */
export async function invalidateOrgDbCache(orgId: string): Promise<void> {
  const client = orgDbClients.get(orgId);
  if (client) {
    try {
      await client.$disconnect();
    } catch {
      /* ignore */
    }
    orgDbClients.delete(orgId);
  }
}

/**
 * Resolve the database client for an organization's ANALYTICS data.
 *
 * - If the org has enabled its own database (useOwnDb && dbHost), returns a
 *   cached dedicated PrismaClient pointed at that database.
 * - Otherwise returns the shared cloud client.
 *
 * Passing `settings` avoids an extra query when the caller already loaded them.
 * SECURITY: uses only the DECRYPTED password to build the DSN; the encrypted
 * value is never logged.
 */
export async function getPrismaForOrg(
  orgId: string,
  options: { settings?: { useOwnDb: boolean; dbHost: string | null; dbPort: number | null; dbName: string | null; dbUser: string | null; dbPassword: string | null; dbSsl: boolean } | null } = {}
): Promise<OrgDbClient> {
  let settings = options.settings;

  if (!settings) {
    const row = await db.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: {
        useOwnDb: true,
        dbHost: true,
        dbPort: true,
        dbName: true,
        dbUser: true,
        dbPassword: true,
        dbSsl: true,
      },
    });
    settings = row ?? null;
  }

  const canUseOwn = Boolean(settings?.useOwnDb && settings.dbHost && settings.dbName && settings.dbUser);

  if (!canUseOwn) {
    return { mode: 'cloud', client: db };
  }

  const cached = orgDbClients.get(orgId);
  if (cached) {
    return { mode: 'own', client: cached, orgId };
  }

  const host = settings!.dbHost!;
  const port = settings!.dbPort ?? 5432;
  const name = settings!.dbName!;
  const user = settings!.dbUser!;
  const password = decryptSecret(settings!.dbPassword ?? '');
  const sslParams = settings!.dbSsl ? '?sslmode=require' : '';

  const connectionString = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}${sslParams}`;

  const client = new PrismaClient({
    datasources: { db: { url: connectionString } },
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

  orgDbClients.set(orgId, client);
  pruneCache();

  return { mode: 'own', client, orgId };
}
