// OmniSight — Global Device Routing Index (hardening area 1).
//
// Maps a device identity to the DATABASE that holds its authoritative Device
// row WITHOUT scanning every activated organization:
//
//     agentKey ─┐
//                ├─> DeviceRouting(platform) ─> organizationId + dbMode ─> getPrismaForOrg(orgId) ─> Device
//     deviceId ─┘
//
// The platform-owned DeviceRouting table is the single source of truth for
// routing; an in-process hot cache (TTL-bounded) makes the authenticated &
// discovery hot paths a local Map hit. Writes are WRITE-THROUGH:
//
//   • Device created (agent discover / admin create)  ── upsert + cache warm
//   • Database cutover flip (applyDatabaseSwitch)     ── bulk dbMode update
//   • Lookup miss in the index                        ── ONE bounded scan
//     (cold start / crash between device write & index upsert), then upsert
//     so the miss never repeats (cache-aside self-heal)
//   • Daily data-integrity backfill                   ── drains platform + org
//
// Cross-tenant safety: a lookup only ever returns the routing FOR ONE device;
// authorization/ownership checks that today run against the platform Device
// table row apply unchanged to the resolved org-DB Device row. No new cross-
// tenant reads exist — the bounded scan it replaces is preserved as the
// cold-start fallback, still capped (DEVICE_ROUTING_SCAN_LIMIT) and still
// only reachable when the index has no answer.
//
// Redis note: a Redis layer would slot behind the same interface
// (getDeviceRoutingByAgentKey/setDeviceRouting...) — this module already
// isolates every index I/O behind those functions, so swapping the storage
// back-end is a local change, not a call-site migration.

import 'server-only';

import { db } from '@/lib/db';
import { log } from '@/lib/logger';
import {
  DEVICE_ROUTING_SCAN_LIMIT,
  DEVICE_ROUTING_TTL_MS,
  DEVICE_ROUTING_BACKFILL_BATCH,
} from '@/config/constants';
import { getPrismaForOrg, findDeviceAcrossActivatedOrgDbs } from '@/lib/org-db';
import { startCacheInvalidationListener } from '@/lib/cache-invalidation';

/** Where the authoritative Device row lives. */
export type DeviceDbMode = 'cloud' | 'own';

export interface DeviceRoutingEntry {
  id: string;
  deviceId: string;
  agentKey: string | null;
  organizationId: string;
  dbMode: DeviceDbMode;
}

// ─── Hot cache ──────────────────────────────────────────────────────────────
// Positive resolutions are cached per process with a short TTL; write-through
// upserts warm the cache; a cross-process 'db'/'all' invalidation clears the
// org's entries. Misses are never cached (the write-through fallback re-runs
// and self-heals the index). Bounded: `Map` grows only with distinct devices
// seen; a 60s TTL keeps it proportional to hot traffic.
interface CachedEntry {
  via: 'agentKey' | 'deviceId';
  entry: DeviceRoutingEntry;
  expiresAt: number;
}

const routingCache = new Map<string, CachedEntry>();

const cacheAge = (c: CachedEntry) => c.expiresAt - Date.now();
const cacheKey = (kind: 'agentKey' | 'deviceId', value: string) => `${kind}:${value}`;

// Evict this org's routing entries on a cross-process cache invalidation so a
// dbMode flip in another instance is picked up within the same turnaround.
startCacheInvalidationListener((msg) => {
  if (msg.cache === 'db' || msg.cache === 'all') {
    for (const [key, c] of routingCache) {
      if (c.entry.organizationId === msg.orgId) routingCache.delete(key);
    }
  }
});

function cacheGet(kind: 'agentKey' | 'deviceId', value: string): DeviceRoutingEntry | null {
  const hit = routingCache.get(cacheKey(kind, value));
  if (!hit) return null;
  if (cacheAge(hit) <= 0) {
    routingCache.delete(cacheKey(kind, value));
    return null;
  }
  return hit.entry;
}

function cacheSet(kind: 'agentKey' | 'deviceId', value: string, entry: DeviceRoutingEntry): void {
  if (!value) return;
  routingCache.set(cacheKey(kind, value), { via: kind, entry, expiresAt: Date.now() + DEVICE_ROUTING_TTL_MS });
}

function cacheClear(orgId?: string): void {
  if (orgId) {
    for (const [key, c] of routingCache) {
      if (c.entry.organizationId === orgId) routingCache.delete(key);
    }
    return;
  }
  routingCache.clear();
}

// ─── Reads ──────────────────────────────────────────────────────────────────

type RoutingRow = {
  id: string;
  deviceId: string;
  agentKey: string | null;
  organizationId: string;
  dbMode: string;
};

/** Map the platform row's raw string dbMode onto the union type (fail-safe to
 * 'cloud' — the org-client resolver is the actual authority). */
const toRoutingEntry = (row: RoutingRow): DeviceRoutingEntry => ({
  id: row.id,
  deviceId: row.deviceId,
  agentKey: row.agentKey,
  organizationId: row.organizationId,
  dbMode: row.dbMode === 'own' ? 'own' : 'cloud',
});

/** Resolve the routing for a device by its platform id (hot cache first). */
export async function getDeviceRoutingByAgentKey(
  agentKey: string
): Promise<DeviceRoutingEntry | null> {
  const hot = cacheGet('agentKey', agentKey);
  if (hot) return hot;

  const row = await db.deviceRouting.findUnique({
    where: { agentKey },
    select: { id: true, deviceId: true, agentKey: true, organizationId: true, dbMode: true },
  });
  if (!row) return null;
  const entry = toRoutingEntry(row);
  if (entry.deviceId) cacheSet('deviceId', entry.deviceId, entry);
  cacheSet('agentKey', agentKey, entry);
  return entry;
}

/** Resolve the routing for a device by its platform id (hot cache first). */
export async function getDeviceRoutingByDeviceId(
  deviceId: string
): Promise<DeviceRoutingEntry | null> {
  const hot = cacheGet('deviceId', deviceId);
  if (hot) return hot;

  const row = await db.deviceRouting.findUnique({
    where: { deviceId },
    select: { id: true, deviceId: true, agentKey: true, organizationId: true, dbMode: true },
  });
  if (!row) return null;
  const entry = toRoutingEntry(row);
  if (entry.agentKey) cacheSet('agentKey', entry.agentKey, entry);
  cacheSet('deviceId', deviceId, entry);
  return entry;
}

// ─── Writes ─────────────────────────────────────────────────────────────────

export interface UpsertDeviceRoutingInput {
  deviceId: string;
  organizationId: string;
  agentKey?: string | null;
  /** When omitted, resolved from OrganizationSettings.useOwnDb. */
  dbMode?: DeviceDbMode;
}

/**
 * Resolve the current routing mode for an org ('own' when the org has cut
 * over / is mid-cutover, 'cloud' otherwise). Never throws — a settings read
 * failure fails open to 'cloud' because getPrismaForOrg is the actual
 * authority; the index is routing intent, not enforcement.
 */
async function resolveDbMode(orgId: string, explicit?: DeviceDbMode): Promise<DeviceDbMode> {
  if (explicit) return explicit;
  try {
    const row = await db.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { useOwnDb: true },
    });
    return row?.useOwnDb ? 'own' : 'cloud';
  } catch {
    return 'cloud';
  }
}

/**
 * Write-through upsert of the routing row for one device. Idempotent and
 * cheap: ONE indexed platform upsert. Warms both cache directions.
 */
export async function upsertDeviceRouting(
  input: UpsertDeviceRoutingInput
): Promise<DeviceRoutingEntry> {
  const dbMode = await resolveDbMode(input.organizationId, input.dbMode);
  const row = await db.deviceRouting.upsert({
    where: { deviceId: input.deviceId },
    create: {
      deviceId: input.deviceId,
      agentKey: input.agentKey ?? null,
      organizationId: input.organizationId,
      dbMode,
      lastSeenAt: new Date(),
    },
    update: {
      agentKey: input.agentKey ?? null,
      organizationId: input.organizationId,
      dbMode,
      lastSeenAt: new Date(),
    },
    select: { id: true, deviceId: true, agentKey: true, organizationId: true, dbMode: true },
  });

  const entry = toRoutingEntry(row);
  if (entry.agentKey) cacheSet('agentKey', entry.agentKey, entry);
  cacheSet('deviceId', entry.deviceId, entry);
  return entry;
}

/**
 * Bulk flip the routing mode for EVERY device of an org — called INSIDE the
 * same transaction that flips OrganizationSettings.useOwnDb (applyDatabaseSwitch /
 * revertDatabaseSwitch) and passed that transaction's client so the index flip
 * is atomic with the routing decision; they can never disagree. Cross-process
 * caches are flushed by the caller's broadcastCacheInvalidation('db').
 */
export async function setRoutingDbModeForOrg(
  client: Pick<typeof db, 'deviceRouting'>,
  orgId: string,
  dbMode: DeviceDbMode
): Promise<number> {
  const res = await client.deviceRouting.updateMany({
    where: { organizationId: orgId },
    data: { dbMode },
  });
  cacheClear(orgId);
  return res.count;
}

// ─── Self-heal ──────────────────────────────────────────────────────────────

/**
 * Backfill the global index (daily integrity job + lazy cold-start fallback).
 *
 * 1. Drain the platform Device table (authoritative home of non-cut-over orgs).
 * 2. Drain every activated org's OWN Device table (devices first seen after a
 *    cutover live only there) and mark them dbMode='own'.
 *
 * Idempotent; bounded per batch. Never deletes — stale rows are corrected by
 * the caller's lookup fallback when a device genuinely vanished.
 */
export async function backfillDeviceRoutingIndex(): Promise<{
  scannedPlatform: number;
  upsertedPlatform: number;
  scannedOrgDbs: number;
  upsertedOrgDbs: number;
  errors: string[];
}> {
  const result = {
    scannedPlatform: 0,
    upsertedPlatform: 0,
    scannedOrgDbs: 0,
    upsertedOrgDbs: 0,
    errors: [] as string[],
  };

  // 1) Platform Device rows → dbMode resolved per org (own orgs still have a
  //    platform copy that is stale-by-design; the org drain below overwrites
  //    it to 'own').
  try {
    const platformOrgs = await db.organizationSettings.findMany({
      where: { useOwnDb: true },
      select: { organizationId: true },
    });
    const ownDbOrgSet = new Set(platformOrgs.map((o) => o.organizationId));

    let skip = 0;
    for (;;) {
      const rows = await db.device.findMany({
        select: { id: true, agentKey: true, organizationId: true },
        skip,
        take: DEVICE_ROUTING_BACKFILL_BATCH,
      });
      for (const r of rows) {
        await upsertDeviceRouting({
          deviceId: r.id,
          agentKey: r.agentKey,
          organizationId: r.organizationId,
          dbMode: ownDbOrgSet.has(r.organizationId) ? 'own' : 'cloud',
        });
        result.upsertedPlatform += 1;
      }
      result.scannedPlatform += rows.length;
      if (rows.length < DEVICE_ROUTING_BACKFILL_BATCH) break;
      skip += DEVICE_ROUTING_BACKFILL_BATCH;
    }
  } catch (error) {
    result.errors.push(`platform drain: ${String((error as Error)?.message ?? error)}`);
  }

  // 2) Org-owned Device rows (post-cutover-only devices).
  const activated = await db.organizationSettings.findMany({
    where: { useOwnDb: true },
    select: { organizationId: true },
  });
  for (const s of activated) {
    try {
      const orgData = (await getPrismaForOrg(s.organizationId)).client;
      let orgSkip = 0;
      for (;;) {
        const rows = await orgData.device.findMany({
          select: { id: true, agentKey: true, organizationId: true },
          skip: orgSkip,
          take: DEVICE_ROUTING_BACKFILL_BATCH,
        });
        for (const r of rows) {
          await upsertDeviceRouting({
            deviceId: r.id,
            agentKey: r.agentKey,
            organizationId: s.organizationId,
            dbMode: 'own',
          });
          result.upsertedOrgDbs += 1;
        }
        result.scannedOrgDbs += rows.length;
        if (rows.length < DEVICE_ROUTING_BACKFILL_BATCH) break;
        orgSkip += DEVICE_ROUTING_BACKFILL_BATCH;
      }
    } catch (error) {
      result.errors.push(`org ${s.organizationId} drain: ${String((error as Error)?.message ?? error)}`);
    }
  }

  return result;
}

// ─── Cross-org resolver (replaces the raw bounded scan call sites) ─────────

export interface ResolvedDeviceRouting {
  id: string;
  organizationId: string;
  employeeId: string | null;
}

/**
 * Resolve a device by agentKey across activated org databases.
 *
 * Fast path: the global index answers with ONE platform lookup; the client
 * then reads the authoritative copy from the org's data DB (chosen by
 * OrganizationSettings, exactly like every other org-DB read). Cold-start
 * fallback: the legacy bounded scan (findDeviceAcrossActivatedOrgDbs) runs at
 * most once; a hit writes the index through so the scan can never repeat for
 * that device.
 */
export async function resolveDeviceByAgentKeyAcrossOrgDbs(
  agentKey: string
): Promise<ResolvedDeviceRouting | null> {
  const routed = await getDeviceRoutingByAgentKey(agentKey);
  if (routed) {
    const found = await readDeviceFromOrgData(routed.organizationId, { agentKey });
    if (found) return found;
    // Index points at a stale organization (device moved/deleted post-cutover)
    // — drop it and fall through to the scan so the authoritative state is
    // re-established instead of returning a dead routing.
    try {
      await db.deviceRouting.deleteMany({ where: { deviceId: routed.deviceId } });
      cacheClear(routed.organizationId);
    } catch {
      /* non-fatal — the scan fallback below re-verifies */
    }
  }

  const scanned = await findDeviceAcrossActivatedOrgDbs(agentKey);
  if (scanned) {
    try {
      await upsertDeviceRouting({
        deviceId: scanned.id,
        agentKey,
        organizationId: scanned.organizationId,
      });
    } catch (error) {
      log.warn('device-index.upsert_after_scan_failed', { error: String((error as Error)?.message ?? error) });
    }
  }
  return scanned;
}

/**
 * Device-id variant of the same resolver, used when a credential-authenticated
 * request arrives with a deviceId the platform index hasn't seen.
 */
export async function resolveDeviceByIdAcrossOrgDbs(
  deviceId: string
): Promise<{ organizationId: string } | null> {
  const routed = await getDeviceRoutingByDeviceId(deviceId);
  if (routed) {
    const found = await readDeviceFromOrgData(routed.organizationId, { id: deviceId });
    if (found) return { organizationId: found.organizationId };
    try {
      await db.deviceRouting.deleteMany({ where: { deviceId } });
      cacheClear(routed.organizationId);
    } catch {
      /* non-fatal — scan fallback */
    }
  }

  const scanned = await findDeviceByIdViaBoundedScan(deviceId);
  if (scanned) {
    try {
      await upsertDeviceRouting({ deviceId, organizationId: scanned.organizationId });
    } catch (error) {
      log.warn('device-index.upsert_after_scan_failed', { error: String((error as Error)?.message ?? error) });
    }
  }
  return scanned;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

async function readDeviceFromOrgData(
  organizationId: string,
  where: { agentKey: string } | { id: string }
): Promise<ResolvedDeviceRouting | null> {
  try {
    const orgData = (await getPrismaForOrg(organizationId)).client;
    const device = await orgData.device.findFirst({
      where,
      select: { id: true, organizationId: true, employeeId: true },
    });
    if (!device) return null;
    return { id: device.id, organizationId: device.organizationId, employeeId: device.employeeId };
  } catch {
    return null; // misconfigured org — skip; its own requests fail closed
  }
}

async function findDeviceByIdViaBoundedScan(
  deviceId: string
): Promise<{ id: string; organizationId: string; employeeId: string | null } | null> {
  const activated = await db.organizationSettings.findMany({
    where: { useOwnDb: true },
    select: { organizationId: true },
    take: DEVICE_ROUTING_SCAN_LIMIT,
  });
  for (const s of activated) {
    const found = await readDeviceFromOrgData(s.organizationId, { id: deviceId });
    if (found) return found;
  }
  return null;
}