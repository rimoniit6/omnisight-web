import { NextResponse } from 'next/server';
import { resolveStorageDriver } from '@/lib/storage';
import { db } from '@/lib/db';

// GET /api/health/ready
// Readiness probe (Phase 5): can this instance SAFELY serve traffic?
// Unlike /api/health (liveness — degrades to 200) this endpoint returns 503
// when a critical dependency is unavailable, so load balancers / orchestrators
// can take the instance out of rotation. Checks:
//   - database       (SELECT 1 — connectivity only)
//   - deviceRouting  (Device Index table reachable — platform migration applied)
//   - jobs           (JobRun lease table reachable — scheduler/cron can run)
//   - storage        (driver resolution — no credentials exposed)
//   - config         (presence of the runtime-critical secrets; booleans only —
//                     values are NEVER exposed)
// The body never contains secrets, env values, or stack traces. A database
// outage returns 503; storage misconfiguration returns 503 in production
// (fail-closed driver) and is reported as a warning field otherwise.
const REQUIRED_CONFIG_KEYS = ['JWT_SECRET', 'ENCRYPTION_KEY', 'DATABASE_URL'] as const;

export async function GET() {
  // Database reachability (connectivity only — never throws past this block).
  let database: 'ok' | 'unreachable' = 'ok';
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    database = 'unreachable';
  }

  // Device Routing engine reachability: the DeviceRouting table backs the
  // global Device Index (src/lib/device-index.ts). Presence is our migration-
  // applied proxy — a missing table means the platform migration did not run.
  let deviceRouting: 'ok' | 'unreachable' = 'ok';
  try {
    await db.deviceRouting.findFirst({ select: { id: true } });
  } catch {
    deviceRouting = 'unreachable';
  }

  // Background-job tracker reachability: the JobRun lease table is what makes
  // the scheduler / `npm run jobs` / instrumentation loops crash-safe. A
  // missing table means jobs cannot make progress.
  let jobs: 'ok' | 'unreachable' = 'ok';
  try {
    await db.jobRun.findFirst({ select: { id: true } });
  } catch {
    jobs = 'unreachable';
  }

  // Storage driver resolution. resolveStorageDriver throws on placeholder or
  // (in production) missing supabase credentials — fail closed.
  let storage: 'ok' | 'misconfigured' | 'unconfigured' = 'ok';
  try {
    resolveStorageDriver();
  } catch {
    storage = process.env.NODE_ENV === 'production' ? 'misconfigured' : 'unconfigured';
  }

  // Runtime-critical configuration presence. Booleans only — never values.
  const config = REQUIRED_CONFIG_KEYS.map((key) => ({
    key,
    present: Boolean(process.env[key] && process.env[key] !== ''),
  }));

  const ready =
    database === 'ok' &&
    deviceRouting === 'ok' &&
    jobs === 'ok' &&
    storage === 'ok' &&
    config.every((c) => c.present);

  return NextResponse.json(
    {
      status: ready ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        database,
        deviceRouting,
        jobs,
        storage,
        config: config.map((c) => ({ key: c.key, present: c.present })),
      },
    },
    { status: ready ? 200 : 503 }
  );
}
