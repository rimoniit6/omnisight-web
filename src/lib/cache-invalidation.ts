// OmniSight — Cross-process cache invalidation via pg_notify.
//
// When an infrastructure change (CUSTOMER_DB cutover, storage switch) completes
// in one process, ALL other processes (Next.js instances, live-updates service)
// must invalidate their local org-db and org-storage caches. This module uses
// PostgreSQL's LISTEN/NOTIFY to broadcast invalidation events.
//
// Channel: 'omnisight_cache_invalidation'
// Payload: JSON { orgId, cache: 'db' | 'storage' | 'all', ts }
//
// Design rules:
//   • Fire-and-forget: a NOTIFY that fails is non-fatal (the 5-min refresh
//     in live-updates is the safety net).
//   • LISTEN connection is lazily initialized and reconnects on error.
//   • The channel name is stable and shared across all OmniSight processes.

import 'server-only';

import { Client } from 'pg';

export const CACHE_INVALIDATION_CHANNEL = 'omnisight_cache_invalidation';

export interface CacheInvalidationMessage {
  orgId: string;
  cache: 'db' | 'storage' | 'all';
  ts: number;
}

type InvalidationHandler = (msg: CacheInvalidationMessage) => void;

let listenClient: Client | null = null;
let listenHandler: InvalidationHandler | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * Broadcast a cache invalidation event to all processes listening on the
 * cache invalidation channel. Non-fatal: if NOTIFY fails, the caller is
 * not blocked and the safety-net refresh will eventually catch up.
 */
export async function broadcastCacheInvalidation(
  orgId: string,
  cache: 'db' | 'storage' | 'all' = 'all',
): Promise<void> {
  try {
    const { db } = await import('@/lib/db');
    const payload = JSON.stringify({ orgId, cache, ts: Date.now() });
    await db.$executeRawUnsafe(`SELECT pg_notify($1, $2)`, CACHE_INVALIDATION_CHANNEL, payload);
  } catch {
    // Non-fatal: local cache is already invalidated by the caller;
    // other processes will catch up via periodic refresh.
  }
}

/**
 * Start listening for cache invalidation events on the platform database.
 * When an event arrives, calls the registered handler. The LISTEN connection
 * auto-reconnects on error after a 5-second backoff.
 *
 * Safe to call multiple times (idempotent — replaces the handler).
 */
export function startCacheInvalidationListener(handler: InvalidationHandler): void {
  listenHandler = handler;

  // LONG-LIVED PROCESSES ONLY. The LISTEN connection is a permanent socket
  // that keeps the event loop alive — required for the Next.js server, which
  // must receive cross-process invalidations while idle, but fatal for
  // short-lived processes (test runners, CLI scripts): `node --test` never
  // terminates because the socket never closes. Next.js sets NEXT_RUNTIME
  // only inside its server runtime, so that is the discriminator — outside
  // it, listeners are skipped; per-process caches there cannot go stale
  // within their lifetime, and local invalidation still applies.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // If already connected with a handler, just update the handler reference.
  if (listenClient) return;

  connectAndListen();
}

function connectAndListen(): void {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL;
  if (!url) {
    console.warn('[cache-invalidation] DATABASE_URL not set — cross-process invalidation disabled');
    return;
  }

  const client = new Client({ connectionString: url });

  client.on('notification', (msg) => {
    if (msg.channel !== CACHE_INVALIDATION_CHANNEL || !msg.payload) return;
    try {
      const parsed = JSON.parse(msg.payload) as CacheInvalidationMessage;
      if (parsed.orgId && parsed.cache) {
        listenHandler?.(parsed);
      }
    } catch {
      // Malformed payload — ignore
    }
  });

  client.on('error', (err) => {
    console.error('[cache-invalidation] LISTEN connection error:', err.message);
    listenClient = null;
    scheduleReconnect();
  });

  client.connect()
    .then(() => client.query(`LISTEN ${CACHE_INVALIDATION_CHANNEL}`))
    .then(() => {
      listenClient = client;
      reconnectAttempts = 0; // reset on success
      console.log(`[cache-invalidation] listening on pg_notify('${CACHE_INVALIDATION_CHANNEL}')`);
    })
    .catch((err) => {
      console.error('[cache-invalidation] failed to connect LISTEN:', err.message);
      listenClient = null;
      scheduleReconnect();
    });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.warn(`[cache-invalidation] gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts`);
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectAndListen();
  }, 5000);
}

/**
 * Stop listening and close the LISTEN connection. Called on process shutdown.
 */
export async function stopCacheInvalidationListener(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (listenClient) {
    try {
      await listenClient.end();
    } catch {
      /* ignore */
    }
    listenClient = null;
  }
  listenHandler = null;
}

/**
 * Reset all module state (for test teardown). Stops any active LISTEN
 * connection, clears the reconnect timer, and resets the handler. After
 * calling this, the next `startCacheInvalidationListener()` call creates a
 * fresh connection. Idempotent and safe to call multiple times.
 */
export async function resetCacheInvalidationState(): Promise<void> {
  await stopCacheInvalidationListener();
  reconnectAttempts = 0;
}
