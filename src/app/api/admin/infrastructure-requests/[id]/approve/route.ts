import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireDbVerifiedRole, apiError } from '@/lib/api';
import { decryptSecret } from '@/lib/crypto';
import { log, requestContext } from '@/lib/logger';
import { serializeChangeRequest, canTransition } from '@/lib/infrastructure';
import type { DbSpec, StorageSpec } from '@/lib/infrastructure';
import { validateDatabaseRollout, validateStorageRollout, applyDatabaseSwitch, applyStorageSwitch } from '@/lib/infra-connect';
import { queueMigrationForRequest } from '@/lib/migration/runner';

type ParsedSpec =
  | { kind: 'DATABASE'; enabled: boolean; spec: DbSpec }
  | { kind: 'STORAGE'; spec: StorageSpec }; // driver 'local' = back to platform pool

// POST /api/admin/infrastructure-requests/[id]/approve
// Super Admin approves a change request. Approval ≠ activation:
//   1. Re-probe the customer infrastructure with the decrypted secret (the
//      authoritative verification — never trusts client-provided test results).
//   2. Real infrastructure changes (dedicated DB / dedicated storage) are
//      marked 'approved' and a QUEUED InfrastructureMigration is created; a
//      background runner copies the org's data to the destination, verifies
//      it, and only then permits the explicit Super Admin activation.
//   3. Non-migrating changes (disabling a dedicated DB / returning to the
//      platform storage pool) switch atomically as before — no data to copy.
//   4. On verification failure, the request becomes 'approved' with an
//      errorMessage and the settings are NOT touched (fail closed); the SA can
//      retry the approval.
//
// Body: { note? } appended to the approval trail.
// SECURITY: DB-verified super_admin role; the decrypted secret is used only to
// open the customer connection and is never logged or returned.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
    if (!admin.ok) {
      return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);
    }

    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { note?: string };
    const note = typeof body.note === 'string' ? body.note.slice(0, 500) : undefined;

    const changeRequest = await db.infrastructureChangeRequest.findUnique({ where: { id } });
    if (!changeRequest) return apiError('Change request not found', 404);

    const isRetry = changeRequest.status === 'approved' && Boolean(changeRequest.errorMessage);
    if (!isRetry && !canTransition(changeRequest.status, 'approved')) {
      return apiError(`Change request #${changeRequest.requestNo} is '${changeRequest.status}' and cannot be approved`, 409);
    }

    // Decrypt the secret bound to this request (never logged / returned).
    const parsed = parseSpec(changeRequest);
    if (!parsed) return apiError('The change request snapshot is malformed', 422);

    // Disabling a dedicated DB / returning to platform storage needs no probe.
    const noProbeNeeded =
      (parsed.kind === 'DATABASE' && !parsed.enabled) ||
      (parsed.kind === 'STORAGE' && parsed.spec.driver === 'local');

    // ── Step 1: authoritative verification against the customer infrastructure ──
    const probe = noProbeNeeded
      ? { ok: true as const, message: parsed.kind === 'DATABASE' ? 'Dedicated analytics DB will be disabled' : 'Org storage will return to the platform pool', code: 'skip' }
      : parsed.kind === 'DATABASE'
        ? await validateDatabaseRollout(parsed.spec)
        : await validateStorageRollout(parsed.spec);

    if (!probe.ok) {
      await db.infrastructureChangeRequest.update({
        where: { id: changeRequest.id },
        data: {
          ...(changeRequest.status === 'submitted'
            ? {
                status: 'approved',
                approvedById: admin.userId,
                approvedByEmail: admin.email,
                approvedAt: new Date(),
                approvalNote: note ?? null,
              }
            : {}),
          errorMessage: probe.message,
        },
      });
      await db.auditLog.create({
        data: {
          action: 'infrastructure_request_verify_failed',
          resource: 'infrastructure-request',
          resourceId: changeRequest.id,
          description: `${admin.email} approved request #${changeRequest.requestNo} (${changeRequest.kind}) but migration verification FAILED: ${probe.message.slice(0, 300)}`,
          userId: admin.userId,
          organizationId: changeRequest.organizationId,
        },
      });
      log.warn('api.admin.infrastructure-requests.approve.verify_failed', {
        requestId: changeRequest.id,
        kind: changeRequest.kind,
        code: probe.code,
      }, requestContext(req));
      return apiError(probe.message, 502);
    }

    // ── Step 2: approval ──
    // Non-migrating changes (disable dedicated DB / return to platform storage)
    // switch atomically as before — there is no organization data to copy.
    if (noProbeNeeded) {
      const now = new Date();
      try {
        const activated = await db.$transaction(async (tx) => {
          await tx.infrastructureChangeRequest.update({
            where: { id: changeRequest.id },
            data: {
              status: 'applied',
              appliedAt: now,
              errorMessage: null,
              ...(changeRequest.status === 'submitted'
                ? {
                    approvedById: admin.userId,
                    approvedByEmail: admin.email,
                    approvedAt: now,
                    approvalNote: note ?? null,
                  }
                : {}),
            },
          });

          if (parsed.kind === 'DATABASE') {
            await applyDatabaseSwitch(tx, changeRequest.organizationId, parsed.spec);
          } else {
            await applyStorageSwitch(tx, changeRequest.organizationId, parsed.spec);
          }

          return tx.infrastructureChangeRequest.update({
            where: { id: changeRequest.id },
            data: { status: 'active', activatedAt: now },
          });
        });
        await db.auditLog.create({
          data: {
            action: 'infrastructure_request_activate',
            resource: 'infrastructure-request',
            resourceId: changeRequest.id,
            description: `${admin.email} approved and ${changeRequest.kind === 'DATABASE' ? 'disabled the dedicated analytics DB' : 'returned org storage to the platform pool'} (request #${changeRequest.requestNo}) — now active`,
            userId: admin.userId,
            organizationId: changeRequest.organizationId,
          },
        });
        return NextResponse.json({
          data: {
            request: serializeChangeRequest(activated),
            message: probe.message,
          },
        });
      } catch (error) {
        await db.infrastructureChangeRequest.update({
          where: { id: changeRequest.id },
          data: { errorMessage: `Switch failed: ${String((error as Error)?.message ?? error).slice(0, 300)}` },
        });
        await db.auditLog.create({
          data: {
            action: 'infrastructure_request_activate_failed',
            resource: 'infrastructure-request',
            resourceId: changeRequest.id,
            description: `${admin.email} approved request #${changeRequest.requestNo} but the switch FAILED — nothing was changed (retryable)`,
            userId: admin.userId,
            organizationId: changeRequest.organizationId,
          },
        });
        log.error('api.admin.infrastructure-requests.approve.switch_failed', { requestId: changeRequest.id, error: String(error) }, requestContext(req));
        return apiError('The switch failed — nothing was changed. The request stays approved and can be retried.', 502);
      }
    }

    // ── Step 3: real infrastructure change → approve + queue the DATA MIGRATION.
    // Activation is deferred until the migration has copied and verified the
    // organization's data (approve ≠ migrate ≠ activate).
    const now = new Date();
    const approvedRequest = await db.$transaction(async (tx) => {
      return tx.infrastructureChangeRequest.update({
        where: { id: changeRequest.id },
        data: {
          status: 'approved',
          approvedById: admin.userId,
          approvedByEmail: admin.email,
          approvedAt: now,
          approvalNote: note ?? null,
          errorMessage: null,
        },
      });
    });

    let migration: { id: string; created: boolean };
    try {
      migration = await queueMigrationForRequest(changeRequest.id);
    } catch (error) {
      await db.infrastructureChangeRequest.update({
        where: { id: changeRequest.id },
        data: { errorMessage: `Migration could not be queued: ${String((error as Error)?.message ?? error).slice(0, 240)}` },
      });
      log.error('api.admin.infrastructure-requests.approve.queue_failed', { requestId: changeRequest.id, error: String(error) }, requestContext(req));
      return apiError('The request is approved, but the data migration could not be queued. Retry the approval.', 502);
    }

    await db.auditLog.create({
      data: {
        action: 'infrastructure_request_approved',
        resource: 'infrastructure-request',
        resourceId: changeRequest.id,
        description: `${admin.email} approved request #${changeRequest.requestNo} (${changeRequest.kind}) — organization data migration ${migration.created ? 'queued' : 'already queued'} for migration ${migration.id}; activation follows verified migration`,
        userId: admin.userId,
        organizationId: changeRequest.organizationId,
      },
    });

    log.info('api.admin.infrastructure-requests.approve', {
      requestId: changeRequest.id,
      kind: changeRequest.kind,
      requestNo: changeRequest.requestNo,
      orgId: changeRequest.organizationId,
      migrationId: migration.id,
      admin: admin.email,
    }, requestContext(req));

    return NextResponse.json({
      data: {
        request: serializeChangeRequest(approvedRequest),
        migration: { id: migration.id, status: 'queued', queuedNow: migration.created },
        message: 'Request approved. The organization data migration has been queued — the new infrastructure activates only after the migration is verified.',
      },
    });
  } catch (error) {
    log.error('api.admin.infrastructure-requests.approve', { error: String(error) }, requestContext(req));
    return apiError('Failed to approve the change request', 500);
  }
}

function parseSpec(changeRequest: {
  kind: string;
  configJson: string;
  dbPasswordEncrypted: string | null;
  storageKeyEncrypted: string | null;
}): ParsedSpec | null {
  try {
    const cfg = JSON.parse(changeRequest.configJson) as Record<string, unknown>;
    if (changeRequest.kind === 'DATABASE') {
      const enabled = cfg.useOwnDb !== false;
      if (!enabled) {
        return { kind: 'DATABASE', enabled: false, spec: { host: '', port: null, name: '', user: '', ssl: false, useOwnDb: false } };
      }
      const password = changeRequest.dbPasswordEncrypted ? decryptSecret(changeRequest.dbPasswordEncrypted) : undefined;
      return {
        kind: 'DATABASE',
        enabled: true,
        spec: {
          host: String(cfg.host ?? ''),
          port: typeof cfg.port === 'number' ? cfg.port : null,
          name: String(cfg.name ?? ''),
          user: String(cfg.user ?? ''),
          ssl: Boolean(cfg.ssl),
          useOwnDb: true,
          ...(password ? { password } : {}),
        } satisfies DbSpec,
      };
    }
    const key = changeRequest.storageKeyEncrypted ? decryptSecret(changeRequest.storageKeyEncrypted) : undefined;
    const driver = cfg.driver === 'supabase' ? 'supabase' : 'local';
    return {
      kind: 'STORAGE',
      spec: {
        driver,
        url: driver === 'supabase' ? String(cfg.url ?? '') : null,
        ...(driver === 'supabase' && key ? { key } : {}),
      } satisfies StorageSpec,
    };
  } catch {
    return null;
  }
}