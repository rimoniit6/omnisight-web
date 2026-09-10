import { NextRequest } from 'next/server';
import { db as prisma } from '@/lib/db';
import { requireSuperAdmin, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';
import { sanitizeLandingDoc, emptyLandingDoc, type LandingContentDoc } from '@/lib/landing-content';
import { log, requestContext } from '@/lib/logger';

const KEY = 'site';

/**
 * Landing page content.
 *
 * GET  — PUBLIC. Returns the Super Admin-managed copy overrides. The landing
 *        page merges these over its built-in defaults; with no row saved the
 *        result is an empty document (page renders defaults). Never returns
 *        credentials or internal data.
 *
 * PUT  — Super Admin only. Replaces the whole document (additive edits from
 *        the editor send the full doc). Validated + length-capped; audited.
 */
export async function GET() {
  const row = await prisma.landingContent.findUnique({ where: { key: KEY } });
  const content = (row?.value ?? emptyLandingDoc()) as LandingContentDoc;
  return apiSuccess({ content });
}

export async function PUT(req: NextRequest) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
    return apiError('Invalid request body', 400);
  }

  const cleaned = sanitizeLandingDoc(body.content);
  if (!cleaned.ok) return apiError(cleaned.error, 422);

  const value = cleaned.value as object;
  let row: { updatedAt: Date; value: unknown };
  try {
    row = await prisma.$transaction(async (tx) => {
      const saved = await tx.landingContent.upsert({
        where: { key: KEY },
        create: { key: KEY, value, updatedBy: admin.userId },
        update: { value, updatedBy: admin.userId },
      });
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'landing_content',
          resourceId: KEY,
          description: `Super admin (${admin.email}) updated landing page content`,
          userId: admin.userId,
          organizationId: null,
        },
      });
      return saved;
    });
  } catch (err) {
    // Operational visibility without leaking internals to the client: the
    // real reason (DB schema drift, connection errors, …) stays in server
    // logs; the browser gets a stable, sanitized 500.
    log.error('api.landing.update_failed', { reason: err instanceof Error ? err.message : String(err) }, requestContext(req));
    return apiError('Unable to save landing page content', 500);
  }

  log.info('api.landing.update', { saved: row.updatedAt.toISOString() }, requestContext(req));
  return apiSuccess({ content: row.value as LandingContentDoc });
}
