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

  // Verify the config was tested before allowing submission.
  const submittedFingerprint = typeof body.configFingerprint === 'string' ? body.configFingerprint : null;
  const expectedFingerprint = await configFingerprint(storageConfigFingerprintInput(config));
  if (submittedFingerprint && submittedFingerprint !== expectedFingerprint) {
    return apiError('The configuration has changed since the last connection test. Please test the connection again before submitting.', 422);
  }

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

  const { request } = await submitChangeRequest({
    organizationId: orgId,
    kind: 'STORAGE',
    actor: { id: auth.userId, email: auth.email },
    configJson: JSON.stringify({ driver: 'supabase', url: config.url }),
    storageKey: effectiveKey,
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