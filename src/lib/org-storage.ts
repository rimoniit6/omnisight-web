// OmniSight — Optional per-organization STORAGE switching.
//
// The PLATFORM storage (avatars, platform branding) always uses the global
// driver from src/lib/storage (env-configured local|supabase). An organization
// that receives an APPROVED InfrastructureChangeRequest of kind STORAGE can
// point its high-volume artifacts (screenshots) at a dedicated Supabase
// project it controls.
//
// org-scoped screenshot I/O therefore resolves the driver PER ORGANIZATION:
//   • storageDriver === 'supabase'  → a dedicated SupabaseStorageDriver built
//     from the DECRYPTED storageKey (never logged, never returned).
//   • otherwise                     → the platform's global storage() driver.
//
// Dedicated drivers are cached per org and evicted on settings change via
// invalidateOrgStorageCache() — mirroring src/lib/org-db.ts.

import { db } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';
import { StorageDriver } from '@/lib/storage/types';
import { SupabaseStorageDriver } from '@/lib/storage/supabase';

export type OrgStorageResolution = { mode: 'platform' } | { mode: 'org'; orgId: string; driver: StorageDriver };

const orgStorageDrivers = new Map<string, SupabaseStorageDriver>();
const MAX_CACHED = 100;

function prune() {
  if (orgStorageDrivers.size > MAX_CACHED) {
    const excess = orgStorageDrivers.size - MAX_CACHED;
    for (const k of [...orgStorageDrivers.keys()].slice(0, excess)) {
      orgStorageDrivers.delete(k);
    }
  }
}

/**
 * Invalidate the cached dedicated storage driver for an organization (call
 * after the org's storage change-request becomes active).
 */
export function invalidateOrgStorageCache(_orgId: string): void {
  // SupabaseStorageDriver is stateless (per-request signed URLs), so a cache
  // eviction is just a delete. Keyed removal keeps the map bounded.
  orgStorageDrivers.delete(_orgId);
}

export function invalidateAllOrgStorageCache(): void {
  orgStorageDrivers.clear();
}

function buildDriver(url: string, encryptedKey: string): SupabaseStorageDriver {
  const projectUrl = url.replace(/\/+$/, '');
  const key = decryptSecret(encryptedKey);
  return new SupabaseStorageDriver(projectUrl, key);
}

/**
 * Resolve the storage driver for an organization's screenshot artifacts.
 *
 * - If the org has an ACTIVE dedicated storage config (storageDriver ===
 *   'supabase' with a URL + encrypted key), returns a cached dedicated driver.
 * - Otherwise returns the platform driver (mode 'platform').
 *
 * Passing `settings` avoids an extra query when the caller already loaded them.
 * SECURITY: only the DECRYPTED key is passed to the driver; the encrypted
 * envelope is never logged.
 */
export async function getOrgStorage(
  orgId: string,
  options: {
    settings?: {
      storageDriver: string | null;
      storageUrl: string | null;
      storageKey: string | null;
    } | null;
  } = {}
): Promise<OrgStorageResolution> {
  let settings = options.settings;

  if (!settings) {
    const row = await db.organizationSettings.findUnique({
      where: { organizationId: orgId },
      select: { storageDriver: true, storageUrl: true, storageKey: true },
    });
    settings = row ?? null;
  }

  const canUseOrg = Boolean(
    settings?.storageDriver === 'supabase' && settings.storageUrl && settings.storageKey
  );

  if (!canUseOrg) {
    return { mode: 'platform' };
  }

  const cached = orgStorageDrivers.get(orgId);
  if (cached) return { mode: 'org', orgId, driver: cached };

  const driver = buildDriver(settings!.storageUrl!, settings!.storageKey!);
  orgStorageDrivers.set(orgId, driver);
  prune();

  return { mode: 'org', orgId, driver };
}