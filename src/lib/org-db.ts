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

/**
 * Thrown when an organization has ENABLED its own database (useOwnDb) but its
 * connection config is incomplete. Resolution FAILS CLOSED on purpose: silently
 * re-routing to the platform DB would read/write the wrong dataset after a
 * cutover, and would mask infrastructure damage behind working-looking data.
 */
export class OrgDbMisconfigurationError extends Error {
  constructor(public readonly orgId: string) {
    super(`Organization ${orgId} has useOwnDb enabled but its database configuration is incomplete`);
    this.name = 'OrgDbMisconfigurationError';
  }
}

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

  // An org that has NOT opted into its own database uses the platform
  // cloud DB (and one with no settings row at all is still platform).
  if (!settings?.useOwnDb) {
    return { mode: 'cloud', client: db };
  }

  // The org DID opt in (useOwnDb=true) — its config must be complete. NEVER
  // silently fall back to the platform DB from here: after a cutover that would
  // read/write the wrong dataset, and before a cutover it would mask a broken
  // pre-flight. Fail closed; the caller can surface or retry the classified
  // misconfiguration.
  if (!settings.dbHost || !settings.dbName || !settings.dbUser) {
    throw new OrgDbMisconfigurationError(orgId);
  }

  const cached = orgDbClients.get(orgId);
  if (cached) {
    return { mode: 'own', client: cached, orgId };
  }

  const host = settings.dbHost;
  const port = settings.dbPort ?? 5432;
  const name = settings.dbName;
  const user = settings.dbUser;
  const password = decryptSecret(settings.dbPassword ?? '');
  const sslParams = settings.dbSsl ? '?sslmode=require' : '';

  const connectionString = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}${sslParams}`;

  const client = new PrismaClient({
    datasources: { db: { url: connectionString } },
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

  orgDbClients.set(orgId, client);
  pruneCache();

  return { mode: 'own', client, orgId };
}

/**
 * RARE-path lookup: find a device by its agent key across organizations that
 * have ACTIVATED their own database (useOwnDb). The platform Device table is the
 * authoritative home only until the org cut over — devices first discovered
 * afterwards exist solely in the org DB, so an anonymous re-discover (no login
 * session slide) cannot see them on the platform table.
 *
 * Bounded by design: the scan is capped at `limit` activated orgs and each org
 * client is cached, so the hot authenticated path never touches this. Returns
 * null when not found (the caller keeps its fail-closed 422).
 */
export async function findDeviceAcrossActivatedOrgDbs(
  agentKey: string,
  limit = 25
): Promise<{ id: string; organizationId: string; employeeId: string | null } | null> {
  const activated = await db.organizationSettings.findMany({
    where: { useOwnDb: true },
    select: { organizationId: true },
    take: limit,
  });
  for (const s of activated) {
    let client: PrismaClient;
    try {
      client = (await getPrismaForOrg(s.organizationId)).client;
    } catch {
      continue; // misconfigured org — skip; its own requests fail closed
    }
    try {
      const device = await client.device.findFirst({
        where: { agentKey },
        select: { id: true, organizationId: true, employeeId: true },
      });
      if (device) return device;
    } catch {
      continue;
    }
  }
  return null;
}
