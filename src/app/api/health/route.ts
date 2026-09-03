import { NextResponse } from 'next/server';
import { resolveStorageDriver } from '@/lib/storage';
import { db } from '@/lib/db';

// GET /api/health
// Public health check (Phase 6 — production readiness). Distinguishes:
//   - application alive            (this handler responded)
//   - database available           (SELECT 1 — connectivity only, no schema)
//   - storage configured           (driver resolution; no credentials exposed)
// Worker/realtime liveness are deliberately NOT part of this public probe:
// background jobs expose their own state via JobRun leases/lastRun and the
// realtime service answers socket pings — neither can be probed from the Next
// process without coupling (documented in docs/V1-PRODUCTION-READINESS.md).
//
// Does NOT expose database credentials, env vars, or internal secrets. A DB
// blip degrades (200 degraded / never 500s) so load balancers can still see
// the app is alive while monitors read the `database` field; a hard outage is
// additionally surfaced by /api/health/database (503 only on connectivity
// failure, safe body).
export async function GET() {
  // Check storage driver health without exposing credentials.
  let storageStatus: 'ok' | 'misconfigured' = 'ok';
  try {
    resolveStorageDriver();
  } catch {
    storageStatus = 'misconfigured';
  }

  // Lightweight DB reachability probe — connectivity only (SELECT 1). Never
  // throws: an unreachable store degrades the response instead of 500ing.
  let databaseStatus: 'ok' | 'unreachable' = 'ok';
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    databaseStatus = 'unreachable';
  }

  const healthy = storageStatus === 'ok' && databaseStatus === 'ok';

  return NextResponse.json({
    status: healthy ? 'ok' : 'degraded',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    // Only the Next.js version is exposed — nothing sensitive.
    version: process.env.npm_package_version || '0.0.0',
    database: databaseStatus,
    storage: storageStatus,
  });
}
