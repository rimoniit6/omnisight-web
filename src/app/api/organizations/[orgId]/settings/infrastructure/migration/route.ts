import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireOrgAdmin, apiSuccess, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { countOrganizationData } from '@/lib/migration/db-migrate';
import { reconcileMigrationCounters } from '@/lib/migration/reconcile';
import { collectOrgStorageRefs } from '@/lib/migration/storage-migrate';

// GET /api/organizations/[orgId]/settings/infrastructure/migration
// The organization's migration status for its infrastructure change request.
//
// Org Admin / Owner only (requireOrgAdmin). Exposes the migration's REAL
// progress (records/objects/bytes done vs total, per-table snapshot, current
// table, sanitized failure reason) — never credentials, never the destination
// connection details beyond what serializeChangeRequest already masks.
export async function GET(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const auth = await requireOrgAdmin(req, orgId);
  if (!auth.ok) return apiError('Insufficient permissions', auth.status);

  try {
    const migrations = await db.infrastructureMigration.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        request: { select: { id: true, requestNo: true, kind: true, status: true } },
      },
    });

    const active = migrations[0] ?? null;

    // ── Self-heal a stale ready_to_activate row ──
    // A migration written BEFORE the counter fix can persist ready_to_activate
    // with recordsDone < recordsTotal (e.g. 1,481 / 1,491). Reconciliation
    // recalculates the counters from the ACTUAL verified destination rows and
    // either corrects them to the truthful 100% or — if rows are genuinely
    // missing — revokes ready state so the normal Retry Transfer flow takes
    // over. No manual production-DB edits, no fabricated percentages, and the
    // row's own recordsTotal (the snapshot denominator) is never rewritten.
    // The cheap no-op path inside the reconciler makes repeat reads harmless.
    if (
      active &&
      active.status === 'ready_to_activate' &&
      active.kind === 'DATABASE' &&
      active.recordsDone !== active.recordsTotal
    ) {
      try {
        const reconciled = await reconcileMigrationCounters(active.id);
        if (reconciled.ok) {
          const freshened = await db.infrastructureMigration.findUnique({
            where: { id: active.id },
            include: { request: { select: { id: true, requestNo: true, kind: true, status: true } } },
          });
          if (freshened) migrations[0] = freshened;
          log.info('api.organizations.settings.infrastructure.migration.reconciled', { orgId, migrationId: active.id, outcome: reconciled.status });
        }
      } catch (err) {
        // Reconcile is best-effort — never fail the status read because of it.
        log.error('api.organizations.settings.infrastructure.migration.reconcile', { orgId, error: String(err) }, requestContext(req));
      }
    }

    const view = (m: (typeof migrations)[number]) => {
      let tableProgress: Record<string, { done: number; total: number }> | null = null;
      if (m.tableProgress) {
        try { tableProgress = JSON.parse(m.tableProgress) as Record<string, { done: number; total: number }>; } catch { tableProgress = null; }
      }
      const recordsPct = m.recordsTotal > 0 ? Math.min(100, Math.round((m.recordsDone / m.recordsTotal) * 100)) : null;
      const objectsPct = m.objectsTotal > 0 ? Math.min(100, Math.round((m.objectsDone / m.objectsTotal) * 100)) : null;
      return {
        id: m.id,
        kind: m.kind,
        status: m.status,
        request: m.request,
        recordsDone: m.recordsDone,
        recordsTotal: m.recordsTotal,
        recordsPct,
        objectsDone: m.objectsDone,
        objectsTotal: m.objectsTotal,
        objectsPct,
        bytesDone: m.bytesDone.toString(),
        bytesTotal: m.bytesTotal.toString(),
        currentTable: m.currentTable,
        tableProgress,
        verifiedCount: m.verifiedCount,
        errorStage: m.errorStage,
        errorMessage: m.errorMessage,
        startedAt: m.startedAt,
        verifiedAt: m.verifiedAt,
        activatedAt: m.activatedAt,
        finishedAt: m.finishedAt,
        createdAt: m.createdAt,
      };
    };

    // ── Pre-migration totals: the CURRENT organization's real data volume. ──
    // Pure reads (source platform DB + source storage sizes) — no writes. The
    // UI shows this before "Transfer Data" so the user knows exactly what
    // will be copied. Every count is scoped to this organization.
    let preMigration = null;
    try {
      const tableCounts = await countOrganizationData(orgId);
      const recordsTotal = tableCounts.reduce((sum, t) => sum + t.count, 0);
      const refs = await collectOrgStorageRefs(orgId);
      preMigration = {
        tablesTotal: tableCounts.length,
        recordsTotal,
        tableCounts,
        objectsTotal: refs.length,
      };
    } catch (err) {
      // Totals are informational — never fail the status endpoint.
      log.error('api.organizations.settings.infrastructure.migration.totals', { orgId, error: String(err) }, requestContext(req));
    }

    return apiSuccess({
      migration: active ? view(active) : null,
      history: migrations.slice(1).map(view),
      preMigration,
    });
  } catch (error) {
    log.error('api.organizations.settings.infrastructure.migration', { orgId, error: String(error) }, requestContext(req));
    return apiError('Failed to load migration status', 500);
  }
}
