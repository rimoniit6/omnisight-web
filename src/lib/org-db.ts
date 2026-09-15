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
import { startCacheInvalidationListener } from '@/lib/cache-invalidation';

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
// Each entry tracks the generation at creation time for stale detection.
const orgDbClients = new Map<string, { client: PrismaClient; generation: number }>();

// Bounded cache: evict stale clients periodically / when too large.
const MAX_CACHED_CLIENTS = 100;

// Global generation counter — incremented on cache invalidation events.
let cacheGeneration = 0;

// Start listening for cross-process cache invalidation events.
startCacheInvalidationListener((msg) => {
  cacheGeneration++;
  if (msg.cache === 'db' || msg.cache === 'all') {
    const entry = orgDbClients.get(msg.orgId);
    if (entry) {
      try { entry.client.$disconnect(); } catch { /* ignore */ }
      orgDbClients.delete(msg.orgId);
    }
  }
});

function pruneCache() {
  if (orgDbClients.size > MAX_CACHED_CLIENTS) {
    // Evict the oldest entries (Map preserves insertion order).
    const excess = orgDbClients.size - MAX_CACHED_CLIENTS;
    const keys = [...orgDbClients.keys()];
    for (let i = 0; i < excess; i++) {
      const k = keys[i];
      const entry = orgDbClients.get(k);
      // Best-effort disconnect; ignore errors.
      try {
        entry?.client.$disconnect();
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
  const entry = orgDbClients.get(orgId);
  if (entry) {
    try {
      await entry.client.$disconnect();
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
    // Validate the cached entry is not stale (generation mismatch = another
    // process invalidated this org's cache while we were using it).
    if (cached.generation === cacheGeneration) {
      return { mode: 'own', client: cached.client, orgId };
    }
    // Stale entry — disconnect and recreate.
    try { cached.client.$disconnect(); } catch { /* ignore */ }
    orgDbClients.delete(orgId);
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

  orgDbClients.set(orgId, { client, generation: cacheGeneration });
  pruneCache();

  return { mode: 'own', client, orgId };
}

/**
 * Check whether a CUSTOMER_DB organization is actually ready to run on its own
 * database. Returns { ready: true } when ALL of the following hold:
 *   1. OrganizationSettings.useOwnDb = true
 *   2. Database config is complete (host, name, user all present)
 *   3. dbTestStatus = 'success' (connection test passed)
 *
 * Returns { ready: false, reason } otherwise. This is the authoritative gate
 * for purchase activation and subscription activation of CUSTOMER_DB orgs.
 *
 * SECURITY: fails closed — a misconfigured org is never considered ready.
 */
export async function isCustomerDbReady(
  orgId: string,
): Promise<{ ready: true } | { ready: false; reason: string }> {
  const settings = await db.organizationSettings.findUnique({
    where: { organizationId: orgId },
    select: {
      useOwnDb: true,
      dbHost: true,
      dbPort: true,
      dbName: true,
      dbUser: true,
      dbTestStatus: true,
    },
  });

  if (!settings) {
    return { ready: false, reason: 'Organization settings not found — infrastructure not configured' };
  }
  if (!settings.useOwnDb) {
    return { ready: false, reason: 'Customer database not enabled (useOwnDb=false) — infrastructure setup required' };
  }
  if (!settings.dbHost || !settings.dbName || !settings.dbUser) {
    return { ready: false, reason: 'Database configuration incomplete (host, name, or user missing)' };
  }
  if (settings.dbTestStatus !== 'success') {
    return { ready: false, reason: `Database connection test not passing (status: ${settings.dbTestStatus ?? 'not-run'})` };
  }

  return { ready: true };
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
