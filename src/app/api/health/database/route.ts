import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/health/database
// Verifies the database is reachable and returns a simple latency measurement.
// Does NOT expose schema details, query results, credentials, or business data.
//
// IMPORTANT (go-live hardening): an org-less database is a LEGITIMATE bootstrap
// state — the Super Admin has not created the first Organization yet. That is
// NOT a database failure and must not make monitoring probes fail. Only a real
// connectivity failure returns 503.
//
//   reachable + org exists  -> { status:'ok', database:'reachable', bootstrap:'complete' }
//   reachable + no org      -> { status:'ok', database:'reachable', bootstrap:'pending' }
//   unreachable             -> 503 { status:'error', database:'unreachable' }
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

  return NextResponse.json({
    status: 'ok',
    database: 'reachable',
    bootstrap: hasOrg ? 'complete' : 'pending',
    latencyMs,
    timestamp: new Date().toISOString(),
  });
}
