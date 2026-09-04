import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireOrgAdmin, apiSuccess, apiError } from '@/lib/api';
import { getOrgSettings, serializeOrgSettings, maybeEncryptSecret } from '@/lib/org-settings';
import { decryptSecretWithMeta } from '@/lib/crypto';
import { log, requestContext } from '@/lib/logger';

// PUT /api/organizations/[orgId]/settings/database
// Update the org's OPTIONAL dedicated analytics database config. Because the
// DB is used at runtime to read analytics (opt-in infrastructure), this stores
// connection parameters. The password, when provided as a NEW plaintext value,
// is encrypted at rest. "••••••" keeps the stored value.
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

  const settings = await getOrgSettings(orgId);

  const useOwnDb = typeof body.useOwnDb === 'boolean' ? body.useOwnDb : settings.useOwnDb;
  const dbHost = typeof body.dbHost === 'string' ? body.dbHost.trim() : null;
  const dbPort = body.dbPort === null || body.dbPort === undefined ? null : Number(body.dbPort);
  const dbName = typeof body.dbName === 'string' ? body.dbName.trim() : null;
  const dbUser = typeof body.dbUser === 'string' ? body.dbUser.trim() : null;
  const dbSsl = typeof body.dbSsl === 'boolean' ? body.dbSsl : settings.dbSsl;
  const dbPasswordIn = typeof body.dbPassword === 'string' ? body.dbPassword : undefined;

  if (useOwnDb && (!dbHost || !dbName || !dbUser)) {
    return apiError('Host, database name and user are required when using your own DB', 422);
  }
  if (dbPort !== null && (Number.isNaN(dbPort) || dbPort < 1 || dbPort > 65535)) {
    return apiError('Invalid port', 422);
  }

  const newPassword = maybeEncryptSecret(dbPasswordIn ?? undefined, settings.dbPassword);

  const updated = await db.organizationSettings.update({
    where: { id: settings.id },
    data: {
      useOwnDb,
      ...(dbHost !== null ? { dbHost } : {}),
      ...(dbPort !== null ? { dbPort } : {}),
      ...(dbName !== null ? { dbName } : {}),
      ...(dbUser !== null ? { dbUser } : {}),
      dbSsl,
      ...(newPassword !== undefined ? { dbPassword: newPassword } : {}),
      // Setting new credentials invalidates any prior successful test.
      dbTestedAt: null,
      dbTestStatus: null,
    },
  });

  await db.auditLog.create({
    data: {
      action: 'update',
      resource: 'settings',
      resourceId: settings.id,
      description: `Analytics DB settings updated (useOwnDb=${useOwnDb}) by ${auth.email}`,
      userId: auth.userId,
      organizationId: orgId,
    },
  });

  const dbLast4 = updated.dbPassword ? decryptSecretWithMeta(updated.dbPassword).plaintext.slice(-4) : null;
  log.info(
    'api.organizations.settings.database',
    { orgId, useOwnDb, host: updated.dbHost, passwordLast4: dbLast4 },
    requestContext(req)
  );

  return apiSuccess(serializeOrgSettings(updated));
}
