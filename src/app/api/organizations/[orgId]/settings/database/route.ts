import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireOrgAdmin, apiSuccess, apiError } from '@/lib/api';
import { getOrgSettings } from '@/lib/org-settings';
import { decryptSecret, isEncryptedSecret } from '@/lib/crypto';
import { log, requestContext } from '@/lib/logger';
import {
  validateDbConfig,
  submitChangeRequest,
  serializeChangeRequest,
  findOpenChangeRequest,
  isKeepMarker,
  configFingerprint,
  dbConfigFingerprintInput,
} from '@/lib/infrastructure';
import { testDbConnection, sanitizeProbeErrorForLog } from '@/lib/infra-connect';
import { buildRequestTestEvidence } from '@/lib/infrastructure-state';
import { loadPendingTestEvidence, selectBindablePendingEvidence } from '@/lib/infrastructure-pending-test';

/** buildRequestTestEvidence returns failed evidence too — a submit may only proceed on success. */
function probeStatus(evidence: { lastTestStatus: string | null }): boolean {
  return evidence.lastTestStatus === 'success';
}

// PUT /api/organizations/[orgId]/settings/database
//
// Org Admin requesting analytics-database infrastructure changes. This endpoint
// NEVER writes the active settings directly — it submits a Part 18 change
// request (InfrastructureChangeRequest, kind DATABASE) that requires Super
// Admin approval before the org-scoped switch happens.
//
// Body: { useOwnDb, dbHost, dbPort, dbName, dbUser, dbSsl, dbPassword? }.
//   • dbPassword blank/"••••••": carry the current active password ONLY when
//     the requested config matches the active one; otherwise return 422.
//   • A request already pending (submitted / approved-with-error) → 409.
//
// Returns the serialized change request (secrets masked; never plaintext).
export async function PUT(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;

  const auth = await requireOrgAdmin(req, orgId);
  if (!auth.ok) {
    return apiError('Insufficient permissions', auth.status);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid request body', 400);
  }

  const settings = await getOrgSettings(orgId);
  const validation = validateDbConfig(body);
  if (!validation.ok) {
    return apiError(validation.error, 422);
  }
  const { config } = validation;

  const disabling = !config.host && !config.name && !config.user;
  if (disabling) {
    const conflict = await ensureNoOpen();
    if (conflict) return conflict;
    const { request } = await submitChangeRequest({
      organizationId: orgId,
      kind: 'DATABASE',
      actor: { id: auth.userId, email: auth.email },
      configJson: JSON.stringify({ useOwnDb: false, host: null, port: null, name: null, user: null, ssl: false }),
    });
    await auditSubmit(auth.userId, auth.email, orgId, request.id, 'disable', null);
    log.info('api.organizations.settings.database.submit', { orgId, kind: 'DATABASE', action: 'disable', requestNo: request.requestNo }, requestContext(req));
    return apiSuccess({ request: serializeChangeRequest(request), message: 'Change request submitted — awaiting Super Admin approval' }, 201);
  }

  // Idempotency: identical request is already the ACTIVE config → no change.
  const sameAsActive =
    settings.useOwnDb &&
    settings.dbHost === config.host &&
    (settings.dbPort ?? null) === (config.port ?? null) &&
    settings.dbName === config.name &&
    settings.dbUser === config.user &&
    Boolean(settings.dbSsl) === config.ssl;
  if (sameAsActive) {
    return apiSuccess({ request: null, unchanged: true, message: 'The dedicated analytics DB is already configured exactly like this — no change request needed' });
  }

  // (Hardening 1) Enable requests MUST present the configFingerprint of the
  // exact non-secret configuration being submitted — the same value the Test
  // endpoint returns for this config. Missing/mismatched → 422 BEFORE the
  // probe; the live probe below remains the authoritative evidence (which
  // also re-runs the SSRF gate and the DDL capability check), so a client can
  // never assert an untested success. The disable path above intentionally
  // requires no destination test/fingerprint.
  //
  // (RC-1) A successful Test Connection that ran BEFORE this request existed is
  // persisted as org-scoped PENDING evidence (see infrastructure-pending-test).
  // When the client cannot supply the fingerprint (e.g. the page was reloaded
  // between Test and Submit), that server-side evidence stands in for it — but
  // only if it is a SUCCESS for THIS exact config and still fresh. The live
  // probe below still runs and must succeed; nothing here bypasses it.
  const submittedFingerprint = typeof body.configFingerprint === 'string' ? body.configFingerprint : '';
  const expectedFingerprint = await configFingerprint(dbConfigFingerprintInput(config));
  const boundPending = submittedFingerprint
    ? null
    : selectBindablePendingEvidence(await loadPendingTestEvidence(orgId, 'DATABASE'), expectedFingerprint);
  if (!submittedFingerprint && !boundPending) {
    return apiError('Test the destination database connection first — the fingerprint from a successful test is required before submitting a transfer request.', 422);
  }
  if (submittedFingerprint && submittedFingerprint !== expectedFingerprint) {
    return apiError('The configuration has changed since the last connection test. Please test the connection again before submitting.', 422);
  }

  // Secret handling for the requested config.
  let effectivePassword: string | undefined;
  const sentPassword = typeof body.dbPassword === 'string' ? body.dbPassword : undefined;
  if (sentPassword && !isKeepMarker(sentPassword)) {
    effectivePassword = sentPassword;
  } else if (settings.useOwnDb && settings.dbPassword && isEncryptedSecret(settings.dbPassword) && sameAsActive) {
    // "keep" marker on the already-active config — carry the decrypted active password.
    effectivePassword = decryptSecret(settings.dbPassword);
  } else {
    // Enabled dedicated DB requires a password (new or matching active).
    return apiError('Enter the analytics database password (or leave it unchanged when the rest of the config is already active)', 422);
  }

  const conflict = await ensureNoOpen();
  if (conflict) return conflict;

  // (Phase 2, R-1) Server-side test at SUBMIT time: probe the exact config
  // being submitted (with the password the admin just provided) so the new
  // request is born with fingerprint-bound, fresh test evidence. The probe is
  // the SAME authoritative test the Test button uses (SSRF gate + DDL probe
  // included). A submission whose destination fails is rejected 422 — the
  // request never enters the SA queue untested.
  let testEvidence: Awaited<ReturnType<typeof buildRequestTestEvidence>>;
  try {
    const probe = await testDbConnection({ ...config, password: effectivePassword });
    testEvidence = await buildRequestTestEvidence(probe, {
      kind: 'DATABASE', host: config.host, port: config.port, name: config.name, user: config.user, ssl: config.ssl, useOwnDb: true,
    });
  } catch (err) {
    log.error('api.organizations.settings.database.submit.probe', { error: sanitizeProbeErrorForLog(err) }, requestContext(req));
    return apiError('The connection test could not be completed. Please test the connection and try again.', 422);
  }
  if (!probeStatus(testEvidence)) {
    return apiError(`The connection test for the submitted configuration failed: ${testEvidence.lastTestMessage ?? 'connection test failed'}. Test the connection and submit a working configuration.`, 422);
  }

  const { request } = await submitChangeRequest({
    organizationId: orgId,
    kind: 'DATABASE',
    actor: { id: auth.userId, email: auth.email },
    configJson: JSON.stringify({ useOwnDb: true, host: config.host, port: config.port, name: config.name, user: config.user, ssl: config.ssl }),
    password: effectivePassword,
    // When a bound pending test authorized this submit, carry ITS fingerprint
    // and timestamp (the evidence that was actually verified); otherwise the
    // fresh submit-time probe evidence.
    testStatus: 'success',
    testMessage: boundPending ? boundPending.lastTestMessage : testEvidence.lastTestMessage,
    testFingerprint: boundPending ? boundPending.lastTestConfigFingerprint : testEvidence.lastTestConfigFingerprint,
    testedAt: boundPending?.lastTestedAt ? new Date(boundPending.lastTestedAt) : null,
  });

  await auditSubmit(auth.userId, auth.email, orgId, request.id, 'enable', request.requestNo);
  log.info(
    'api.organizations.settings.database.submit',
    { orgId, kind: 'DATABASE', action: 'enable', requestNo: request.requestNo, host: config.host, passwordLast4: effectivePassword?.slice(-4) ?? null },
    requestContext(req)
  );

  return apiSuccess({ request: serializeChangeRequest(request), message: 'Change request submitted — awaiting Super Admin approval' }, 201);

  async function ensureNoOpen() {
    // Hard block only while the Super Admin has NOT acted yet. An
    // approved-with-error request is superseded by a newer submission (the org
    // abandons the failed one and resubmits a corrected config).
    const open = await findOpenChangeRequest(orgId, 'DATABASE');
    if (open && open.status === 'submitted') {
      return apiError(`A DATABASE change request is already pending (request #${open.requestNo}). Cancel it or wait for the Super Admin to act on it first.`, 409);
    }
    return null;
  }
}

async function auditSubmit(
  userId: string,
  email: string,
  organizationId: string,
  resourceId: string,
  action: 'enable' | 'disable',
  requestNo: number | null
) {
  await db.auditLog.create({
    data: {
      action: 'infrastructure_request_submit',
      resource: 'infrastructure-request',
      resourceId,
      description: `${email} submitted a DATABASE change request to ${action === 'enable' ? `configure a dedicated analytics DB (request #${requestNo})` : 'disable the dedicated analytics DB'}`,
      userId,
      organizationId,
    },
  });
}