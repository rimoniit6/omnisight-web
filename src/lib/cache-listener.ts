// OmniSight — Next.js app-level cache invalidation listener.
//
// This module is imported lazily by API routes that use org-db or org-storage
// caches. On first import, it starts listening for cross-process cache
// invalidation events (from infra-connect.ts apply/revert functions) and
// invalidates the local caches accordingly.
//
// Idempotent: multiple imports are safe — the listener starts only once.

import {
  startCacheInvalidationListener,
  resetCacheInvalidationState,
  type CacheInvalidationMessage,
} from '@/lib/cache-invalidation';

let initialized = false;

export function ensureCacheInvalidationListener(): void {
  if (initialized) return;
  initialized = true;

  startCacheInvalidationListener(async (msg: CacheInvalidationMessage) => {
    const { invalidateOrgDbCache } = await import('@/lib/org-db');
    const { invalidateOrgStorageCache } = await import('@/lib/org-storage');

    if (msg.cache === 'db' || msg.cache === 'all') {
      await invalidateOrgDbCache(msg.orgId);
    }
    if (msg.cache === 'storage' || msg.cache === 'all') {
      invalidateOrgStorageCache(msg.orgId);
    }
  });
}

/**
 * Reset listener state (for test teardown). Stops the LISTEN connection and
 * allows `ensureCacheInvalidationListener()` to re-initialize on next call.
 */
export async function resetCacheInvalidationListener(): Promise<void> {
  initialized = false;
  await resetCacheInvalidationState();
}
