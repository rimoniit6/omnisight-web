import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireOrgAdmin, apiSuccess, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { queueMigrationForRequest, retryMigration } from '@/lib/migration/runner';
import { userSafeError } from '@/lib/migration/db-migrate';

// POST /api/organizations/[orgId]/settings/infrastructure/migration/start
//
// Org Admin action for the "Transfer Organization Data" flow: starts (or
// resumes) the EXISTING backend data migration for the organization's change
// request of the given kind. This endpoint reuses the existing migration
// machinery only — queueMigrationForRequest / retryMigration — it implements
// no new migration logic.
//
// Request resolution (in order):
//   1. the OPEN request for this kind (submitted/approved) — the normal flow;
//   2. otherwise the LATEST request of this kind whose config matches the org's
//      CURRENTLY-ACTIVE settings (active request) — the legacy/catch-up state
//      where the org was switched under the old approve-only flow and its data
//      was never migrated. Both personalized connections must be validated
//      before a catch-up migration may run.
//
// Semantics (all idempotent):
//   • no open/active request, or connections not validated → 409/422
//   • request still 'submitted' (awaiting SA)              → 409 with guidance
//   • migration queued/running/ready/activated             → 200 alreadyQueued
//   • migration 'failed'                                   → retry (server-gated)
//   • migration 'cancelled' before start                   → re-queued
//
// SECURITY: requireOrgAdmin — an org admin can only ever touch their OWN
// organization's request/migration (all queries predicate on organizationId).
// No secrets are read or returned.
export async function POST(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const auth = await requireOrgAdmin(req, orgId);
  if (!auth.ok) return apiError('Insufficient permissions', auth.status);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const kind = body.kind === 'STORAGE' ? 'STORAGE' : body.kind === 'DATABASE' ? 'DATABASE' : null;
  if (!kind) return apiError('kind must be DATABASE or STORAGE', 422);

  try {
    // Both personalized connections must be validated before a transfer can
    // run — connection success is the entry gate to the migration.
    const settings = await db.organizationSettings.findUnique({ where: { organizationId: orgId } });
    if (!settings) return apiError('Organization settings not found', 404);
    const dbConnected = settings.useOwnDb === true && Boolean(settings.dbHost) && settings.dbTestStatus === 'success';
    const storageConnected = settings.storageDriver === 'supabase' && settings.storageTestStatus === 'success';
    if (!dbConnected || !storageConnected) {
      return apiError('Both the personalized database and storage connections must be successfully tested before transferring organization data.', 422);
    }

    // 1) The OPEN request for this kind (submitted or approved).
    let request = await db.infrastructureChangeRequest.findFirst({
      where: { organizationId: orgId, kind, status: { in: ['submitted', 'approved'] } },
      orderBy: { requestNo: 'desc' },
    });

    if (request?.status === 'submitted') {
      return apiError('This change request is awaiting Super Admin approval. The data transfer starts automatically once it is approved.', 409);
    }

    // 2) Legacy/catch-up: no open request, but the org is ALREADY RUNNING on
    //    this kind's custom infrastructure (an 'active' request) and its data
    //    was never migrated (no completed migration exists). Reuse that
    //    request's snapshot so the migration copies to the configured target.
    if (!request) {
      const completed = await db.infrastructureMigration.findFirst({
        where: { organizationId: orgId, kind, status: 'activated' },
      });
      if (!completed) {
        request = await db.infrastructureChangeRequest.findFirst({
          where: { organizationId: orgId, kind, status: 'active' },
          orderBy: { requestNo: 'desc' },
        });
      }
    }

    if (!request) {
      return apiError('There is no infrastructure change to transfer data for.', 409);
    }

    const existing = await db.infrastructureMigration.findUnique({ where: { requestId: request.id } });

    if (existing && ['queued', 'migrating', 'verifying', 'ready_to_activate', 'activated'].includes(existing.status)) {
      // Approval already queued it (or it progressed) — nothing to start.
      return apiSuccess({ migrationId: existing.id, status: existing.status, alreadyQueued: true });
    }

    if (existing && existing.status === 'failed') {
      const result = await retryMigration(existing.id, { id: auth.userId, email: auth.email });
      if (!result.ok) return apiError(result.error, result.status);
      log.info('api.organizations.settings.infrastructure.migration.start.retried', { orgId, migrationId: existing.id }, requestContext(req));
      return apiSuccess({ migrationId: existing.id, status: 'queued', retried: true });
    }

    // queued===false covers the cancelled-before-start case: re-queue it.
    const queued = await queueMigrationForRequest(request.id);
    log.info('api.organizations.settings.infrastructure.migration.start', { orgId, migrationId: queued.id, kind }, requestContext(req));
    return apiSuccess({ migrationId: queued.id, status: 'queued', alreadyQueued: !queued.created });
  } catch (error) {
    log.error('api.organizations.settings.infrastructure.migration.start', { orgId, error: String(error) }, requestContext(req));
    // Surface the REAL sanitized reason (never the raw URL/credentials). The
    // generic message alone made every failure indistinguishable — e.g. the
    // concurrent double-start race used to read exactly "Failed to start the
    // data transfer" while the underlying cause was a preventable second
    // create on the same requestId.
    return apiError(`Failed to start the data transfer: ${userSafeError(error)}`, 500);
  }
}
