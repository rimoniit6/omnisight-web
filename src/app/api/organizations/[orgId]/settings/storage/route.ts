import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireOrgAdmin, apiSuccess, apiError } from '@/lib/api';
import { getOrgSettings } from '@/lib/org-settings';
import { decryptSecret, isEncryptedSecret } from '@/lib/crypto';
import { log, requestContext } from '@/lib/logger';
import {
  validateStorageConfig,
  submitChangeRequest,
  serializeChangeRequest,
  findOpenChangeRequest,
  isKeepMarker,
  configFingerprint,
  storageConfigFingerprintInput,
} from '@/lib/infrastructure';
import { testStorageConnection, sanitizeProbeErrorForLog } from '@/lib/infra-connect';
import { buildRequestTestEvidence } from '@/lib/infrastructure-state';
import { loadPendingTestEvidence, selectBindablePendingEvidence } from '@/lib/infrastructure-pending-test';

// PUT /api/organizations/[orgId]/settings/storage
//
// Org Admin requesting org-scoped STORAGE infrastructure changes (dedicated
// Supabase project for screenshot artifacts). NEVER writes active settings
// directly — submits a Part 18 change request (kind STORAGE) requiring Super
// Admin approval before the org-scoped switch.
//
// Body: { storageDriver: "local" | "supabase", storageUrl?, storageKey? }.
//   • driver "supabase": https URL + service-role key required (a "••••••"
//     key carries the active key only when the URL matches the active one).
//   • driver "local": clears the org override back to the platform pool.
//
// Returns the serialized change request (service-role key masked).
export async function PUT(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;

  const auth = await requireOrgAdmin(req, orgId);
  if (!auth.ok) return apiError('Insufficient permissions', auth.status);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid request body', 400);
  }

  const validation = validateStorageConfig(body);
  if (!validation.ok) return apiError(validation.error, 422);
  const { config } = validation;

  // (Phase 2, R-3) The submitted destination must have passed the server-side
  // live probe (bucket + scratch write/verify/delete) at submission time, and
  // (Hardening 1) the request must carry the fingerprint of the exact config
  // being submitted. UI state is never trusted — the probe is authoritative.

  const submittingLocal = config.driver === 'local';
  if (submittingLocal) {
    const conflict = await ensureNoOpen();
    if (conflict) return conflict;
    const { request } = await submitChangeRequest({
      organizationId: orgId,
      kind: 'STORAGE',
      actor: { id: auth.userId, email: auth.email },
      configJson: JSON.stringify({ driver: 'local', url: null }),
    });
    await audit(userId(auth), auth.email, orgId, request.id, 'local', request.requestNo);
    log.info('api.organizations.settings.storage.submit', { orgId, action: 'local', requestNo: request.requestNo }, requestContext(req));
    return apiSuccess({ request: serializeChangeRequest(request), message: 'Change request submitted — awaiting Super Admin approval' }, 201);
  }

  // Supabase driver.
  const settings = await getOrgSettings(orgId);
  const sameAsActive = settings.storageDriver === 'supabase' && (settings.storageUrl ?? null) === config.url;
  if (sameAsActive && settings.storageKey) {
    return apiSuccess({ request: null, unchanged: true, message: 'The org storage is already pointed at this Supabase project — no change request needed' });
  }

  // (Hardening 1) Supabase adoption requests MUST present the configFingerprint
  // of the exact destination being submitted — the same value the Test
  // endpoint returns for this config. Missing/mismatched → 422 BEFORE the
  // probe; the live probe below remains the authoritative evidence (bucket
  // existence + scratch write/verify/delete). The local/platform path above
  // intentionally requires no destination test/fingerprint. The secret key is
  // never part of the fingerprint.
  //
  // (RC-1) A successful Test Connection that ran BEFORE this request existed is
  // persisted as org-scoped PENDING evidence (see infrastructure-pending-test).
  // When the client cannot supply the fingerprint (e.g. the page was reloaded
  // between Test and Submit), that server-side evidence stands in for it — but
  // only if it is a SUCCESS for THIS exact config and still fresh. The live
  // probe below still runs and must succeed; nothing here bypasses it.
  const submittedFingerprint = typeof body.configFingerprint === 'string' ? body.configFingerprint : '';
  const expectedFingerprint = await configFingerprint(storageConfigFingerprintInput(config));
  const boundPending = submittedFingerprint
    ? null
    : selectBindablePendingEvidence(await loadPendingTestEvidence(orgId, 'STORAGE'), expectedFingerprint);
  if (!submittedFingerprint && !boundPending) {
    return apiError('Test the destination storage connection first — the fingerprint from a successful test is required before submitting a transfer request.', 422);
  }
  if (submittedFingerprint && submittedFingerprint !== expectedFingerprint) {
    return apiError('The configuration has changed since the last connection test. Please test the connection again before submitting.', 422);
  }

  let effectiveKey: string | undefined;
  const sentKey = typeof body.storageKey === 'string' ? body.storageKey : undefined;
  if (sentKey && !isKeepMarker(sentKey)) {
    effectiveKey = sentKey;
  } else if (sameAsActive && settings.storageKey && isEncryptedSecret(settings.storageKey)) {
    effectiveKey = decryptSecret(settings.storageKey);
  } else {
    return apiError('Enter the Supabase service-role key (or leave it unchanged when the project URL is already active)', 422);
  }

  const conflict = await ensureNoOpen();
  if (conflict) return conflict;

  // (Phase 2, R-3) Server-side test at SUBMIT time with the key the admin
  // just provided — the SAME authoritative probe as the Test button (bucket
  // existence + scratch write/verify/delete). The new request is born with
  // fingerprint-bound, fresh evidence; a broken destination is rejected 422.
  let testEvidence: Awaited<ReturnType<typeof buildRequestTestEvidence>>;
  try {
    const probe = await testStorageConnection({ driver: 'supabase', url: config.url, key: effectiveKey });
    testEvidence = await buildRequestTestEvidence(probe, { kind: 'STORAGE', driver: 'supabase', url: config.url });
  } catch (err) {
    log.error('api.organizations.settings.storage.submit.probe', { error: sanitizeProbeErrorForLog(err) }, requestContext(req));
    return apiError('The connection test could not be completed. Please test the connection and try again.', 422);
  }
  if (testEvidence.lastTestStatus !== 'success') {
    return apiError(`The connection test for the submitted configuration failed: ${testEvidence.lastTestMessage ?? 'connection test failed'}. Test the connection and submit a working configuration.`, 422);
  }

  const { request } = await submitChangeRequest({
    organizationId: orgId,
    kind: 'STORAGE',
    actor: { id: auth.userId, email: auth.email },
    configJson: JSON.stringify({ driver: 'supabase', url: config.url }),
    storageKey: effectiveKey,
    // When a bound pending test authorized this submit, carry ITS fingerprint
    // and timestamp (the evidence that was actually verified); otherwise the
    // fresh submit-time probe evidence.
    testStatus: 'success',
    testMessage: boundPending ? boundPending.lastTestMessage : testEvidence.lastTestMessage,
    testFingerprint: boundPending ? boundPending.lastTestConfigFingerprint : testEvidence.lastTestConfigFingerprint,
    testedAt: boundPending?.lastTestedAt ? new Date(boundPending.lastTestedAt) : null,
  });

  await audit(userId(auth), auth.email, orgId, request.id, 'supabase', request.requestNo);
  log.info(
    'api.organizations.settings.storage.submit',
    { orgId, action: 'supabase', requestNo: request.requestNo, url: config.url, keyLast4: effectiveKey?.slice(-4) ?? null },
    requestContext(req)
  );

  return apiSuccess({ request: serializeChangeRequest(request), message: 'Change request submitted — awaiting Super Admin approval' }, 201);

  async function ensureNoOpen() {
    // Hard block only while the Super Admin has NOT acted yet. An
    // approved-with-error request is superseded by a newer submission.
    const open = await findOpenChangeRequest(orgId, 'STORAGE');
    if (open && open.status === 'submitted') {
      return apiError(`A STORAGE change request is already pending (request #${open.requestNo}). Cancel it or wait for the Super Admin to act on it first.`, 409);
    }
    return null;
  }
}

function userId(auth: { ok: true; userId: string; email: string }): string {
  return auth.userId;
}

async function audit(userId: string, email: string, organizationId: string, resourceId: string, driver: 'local' | 'supabase', requestNo: number) {
  await db.auditLog.create({
    data: {
      action: 'infrastructure_request_submit',
      resource: 'infrastructure-request',
      resourceId,
      description: `${email} submitted a STORAGE change request to ${driver === 'supabase' ? `point org storage at a dedicated Supabase project (request #${requestNo})` : `return org storage to the platform pool (request #${requestNo})`}`,
      userId,
      organizationId,
    },
  });
}