import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';

// GET /api/health/database
// Verifies the database is reachable and returns a simple latency measurement.
// Does NOT expose schema details, query results, credentials, or business data.
//
// IMPORTANT (go-live hardening): an org-less database is a LEGITIMATE bootstrap
// state — the Super Admin has not created the first Organization yet. That is
// NOT a database failure and must not make monitoring probes fail. Only a real
// connectivity failure returns 503.
//
// Beyond the platform DB, a BOUNDED sample (max 5) of organizations that
// activated their own analytics database (BYODB / useOwnDb) is probed with
// SELECT 1. Per-org connectivity failures are reported in the `orgDatabases`
// block but NEVER 503 — they do not take the platform instance down. Only the
// platform DB outage returns 503.
//
//   reachable + org exists            -> { status:'ok', database:'reachable', bootstrap:'complete', orgDatabases }
//   reachable + no org                -> { status:'ok', database:'reachable', bootstrap:'pending',   orgDatabases }
//   unreachable                       -> 503 { status:'error', database:'unreachable' }
export async function GET() {
  const start = Date.now();
  let reachable = false;
  let hasOrg = false;
  try {
    // Minimal query — validates the connection, not the data.
    const org = await db.organization.findFirst({ select: { id: true } });
    reachable = true;
    hasOrg = Boolean(org);
  } catch {
    reachable = false;
  }
  const latencyMs = Date.now() - start;

  if (!reachable) {
    return NextResponse.json(
      {
        status: 'error',
        database: 'unreachable',
        latencyMs,
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }

  // Sample activated org analytics DBs (bounded, never throws). Reuses the
  // getPrismaForOrg cache so a hot probe does not create a connection per hit.
  const orgDatabases: {
    checked: number;
    reachable: number;
    unreachable: number;
    orgs: Array<{ organizationId: string; reachable: boolean }>;
  } = { checked: 0, reachable: 0, unreachable: 0, orgs: [] };
  try {
    const activated = await db.organizationSettings.findMany({
      where: { useOwnDb: true },
      select: { organizationId: true },
      take: 5,
    });
    for (const s of activated) {
      let orgReachable = false;
      try {
        const { client } = await getPrismaForOrg(s.organizationId);
        await client.$queryRaw`SELECT 1`;
        orgReachable = true;
      } catch {
        // Per-org outage — reported, never fatal for the platform instance.
        orgReachable = false;
      }
      orgDatabases.checked += 1;
      if (orgReachable) orgDatabases.reachable += 1;
      else orgDatabases.unreachable += 1;
      orgDatabases.orgs.push({ organizationId: s.organizationId, reachable: orgReachable });
    }
  } catch {
    // Sampling the activated list failed — leave orgDatabases at checked: 0.
  }

  return NextResponse.json({
    status: 'ok',
    database: 'reachable',
    bootstrap: hasOrg ? 'complete' : 'pending',
    latencyMs,
    orgDatabases,
    timestamp: new Date().toISOString(),
  });
}
