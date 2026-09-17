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

  // LONG-LIVED PROCESSES ONLY. The listener is a permanent Postgres LISTEN
  // connection: it keeps the event loop alive, which is correct for the Next.js
  // server (it must receive cross-process invalidations while idle) but hangs
  // short-lived processes (test runners, CLI scripts) that would otherwise exit
  // after their work — node --test never terminates because the socket never
  // closes. Next.js sets NEXT_RUNTIME=nodejs only inside its server runtime,
  // so that is the discriminator: everywhere else (tests, scripts) the
  // listener is skipped entirely — those caches are per-process and their
  // lifetime is too short to go stale.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

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
