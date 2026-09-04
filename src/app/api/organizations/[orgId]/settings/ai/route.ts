import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireOrgAdmin, apiSuccess, apiError } from '@/lib/api';
import { getOrgSettings, serializeOrgSettings, maybeEncryptSecret, AI_PROVIDERS } from '@/lib/org-settings';
import { decryptSecretWithMeta } from '@/lib/crypto';
import { log, requestContext } from '@/lib/logger';

// PUT /api/organizations/[orgId]/settings/ai
// Update the org's AI provider configuration. The API key, when provided as a
// NEW plaintext value, is encrypted at rest. A client may send the sentinel
// value "••••••" (or "keep") to leave the stored key unchanged.
// Org Admin / Owner only.
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

  const aiProvider = typeof body.aiProvider === 'string' ? body.aiProvider : null;
  if (aiProvider && !AI_PROVIDERS.includes(aiProvider as never)) {
    return apiError('Unsupported AI provider', 422);
  }

  const aiBaseUrl = typeof body.aiBaseUrl === 'string' ? body.aiBaseUrl.trim() : null;
  if (aiBaseUrl === '') return apiError('Base URL cannot be empty', 422);
  const aiModel = typeof body.aiModel === 'string' ? body.aiModel.trim() : null;
  const aiApiKeyIn =
    typeof body.aiApiKey === 'string' ? body.aiApiKey : undefined;

  const settings = await getOrgSettings(orgId);

  // Encrypt the new key only if it actually changed.
  const newKey = maybeEncryptSecret(aiApiKeyIn ?? undefined, settings.aiApiKey);

  const updated = await db.organizationSettings.update({
    where: { id: settings.id },
    data: {
      ...(aiProvider !== null ? { aiProvider } : {}),
      ...(aiBaseUrl !== null ? { aiBaseUrl } : {}),
      ...(aiModel !== null ? { aiModel } : {}),
      ...(newKey !== undefined ? { aiApiKey: newKey } : {}),
    },
  });

  await db.auditLog.create({
    data: {
      action: 'update',
      resource: 'settings',
      resourceId: settings.id,
      description: `AI provider settings updated (${aiProvider ?? 'unchanged'}) by ${auth.email}`,
      userId: auth.userId,
      organizationId: orgId,
    },
  });

  const last4 = updated.aiApiKey ? decryptSecretWithMeta(updated.aiApiKey).plaintext.slice(-4) : null;
  log.info(
    'api.organizations.settings.ai',
    { orgId, provider: aiProvider ?? 'unchanged', keyLast4: last4 },
    requestContext(req)
  );

  return apiSuccess(serializeOrgSettings(updated));
}
