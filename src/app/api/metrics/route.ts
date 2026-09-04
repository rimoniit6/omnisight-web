import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { log } from '@/lib/logger';

// GET /api/metrics
// Prometheus-compatible text exposition of lightweight operational metrics:
// process + DB availability, and platform counters (subscriptions, invoices,
// licenses). Does NOT expose per-organization or per-user data.
//
// SECURITY: guarded by an optional bearer token. Set METRICS_TOKEN in the
// environment and point your Prometheus scraper at it. When METRICS_TOKEN is
// not configured the endpoint is DISABLED (404) so data is never leaked by an
// open unauthenticated scrape.

const METRICS_TOKEN = process.env.METRICS_TOKEN;

function esc(value: unknown): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function GET(req: NextRequest) {
  if (!METRICS_TOKEN) {
    // Not configured — intentionally disabled (secure by default).
    return new Response('Metrics endpoint disabled (set METRICS_TOKEN)', { status: 404 });
  }

  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== METRICS_TOKEN) {
    return new Response('Unauthorized', { status: 401 });
  }

  const lines: string[] = [];

  // Process / runtime
  lines.push('# HELP omnisight_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE omnisight_uptime_seconds gauge');
  lines.push(`omnisight_uptime_seconds ${process.uptime()}`);
  const mem = process.memoryUsage();
  lines.push('# HELP omnisight_memory_heap_bytes Heap used in bytes');
  lines.push('# TYPE omnisight_memory_heap_bytes gauge');
  lines.push(`omnisight_memory_heap_bytes ${mem.heapUsed}`);

  try {
    // Platform counters (aggregate only — no per-org detail).
    const [activeSubs, trialOrgs, invoices, activeLicenses, revokedLicenses] = await Promise.all([
      db.subscription.count({ where: { status: 'ACTIVE' } }),
      db.organization.count({ where: { trialEndsAt: { gt: new Date() } } }),
      db.invoice.groupBy({ by: ['status'], _count: { _all: true } }),
      db.licenseKey.count({ where: { isRevoked: false, isActive: true } }),
      db.licenseKey.count({ where: { isRevoked: true } }),
    ]);

    lines.push('# HELP omnisight_subscriptions_active_total Active subscriptions');
    lines.push('# TYPE omnisight_subscriptions_active_total gauge');
    lines.push(`omnisight_subscriptions_active_total ${activeSubs}`);

    lines.push('# HELP omnisight_organizations_on_trial_total Organizations in trial');
    lines.push('# TYPE omnisight_organizations_on_trial_total gauge');
    lines.push(`omnisight_organizations_on_trial_total ${trialOrgs}`);

    lines.push('# HELP omnisight_invoices_by_status_total Invoices by status');
    lines.push('# TYPE omnisight_invoices_by_status_total gauge');
    for (const row of invoices) {
      lines.push(`omnisight_invoices_by_status_total{status="${esc(row.status)}"} ${row._count._all}`);
    }

    lines.push('# HELP omnisight_licenses_active_total Active (non-revoked) license keys');
    lines.push('# TYPE omnisight_licenses_active_total gauge');
    lines.push(`omnisight_licenses_active_total ${activeLicenses}`);
    lines.push('# HELP omnisight_licenses_revoked_total Revoked license keys');
    lines.push('# TYPE omnisight_licenses_revoked_total gauge');
    lines.push(`omnisight_licenses_revoked_total ${revokedLicenses}`);
  } catch (err) {
    log.error('api.metrics.db', { error: String(err) });
    lines.push('# HELP omnisight_database_up Database availability');
    lines.push('# TYPE omnisight_database_up gauge');
    lines.push('omnisight_database_up 0');
  }

  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
