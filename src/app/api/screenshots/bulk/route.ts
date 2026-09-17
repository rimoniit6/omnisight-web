import { NextRequest, NextResponse } from 'next/server';
import { authError, requireAdminOrg, getPrismaForOrg } from '@/lib/api';
import { getClientIp } from '@/lib/agent/auth';
import { deleteScreenshot, isNotFound } from '@/lib/storage';
import { log, requestContext } from '@/lib/logger';

/**
 * Maximum batch size for one bulk-delete request. Deliberately bounded: bulk
 * deletion is destructive, and the UI only ever selects the screenshots
 * visible on the current page (pageSize <= 24). 100 is a generous ceiling
 * that still prevents a careless client from issuing unbounded deletes.
 */
const MAX_BULK_DELETE = 100;

// DELETE /api/screenshots/bulk — Delete multiple screenshots in one request.
// Mirrors the verified individual-delete semantics (src/app/api/screenshots/[id]/route.ts):
//   - admin-only mutation;
//   - organization identity + actor come ONLY from the verified session, never
//     the request body;
//   - org-scoped discover → validate → act: cross-org/unknown ids are never
//     deleted (they simply don't match the org-scoped lookup);
//   - storage artifacts (thumbnail first, then original) are removed BEFORE
//     any DB row; a real storage failure keeps the row and reports the id;
//   - DB deletion + one audit record per successfully deleted screenshot are
//     committed atomically through the org's data client.
export async function DELETE(req: NextRequest) {
  try {
    // Mutation: admin-or-above role + organization scope (never requireSessionOrg).
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);
    const orgId = admin.organizationId;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    // Strict input validation. Only a JSON object with a `screenshotIds`
    // array of non-empty strings is accepted — anything else is a 4xx, never
    // a silent no-op or a 500.
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
    }
    const screenshotIds = (body as { screenshotIds?: unknown }).screenshotIds;
    if (!Array.isArray(screenshotIds)) {
      return NextResponse.json({ error: 'screenshotIds is required and must be an array' }, { status: 400 });
    }
    if (screenshotIds.length === 0) {
      return NextResponse.json({ error: 'screenshotIds must not be empty' }, { status: 400 });
    }
    if (!screenshotIds.every((id) => typeof id === 'string' && id.trim().length > 0)) {
      return NextResponse.json({ error: 'screenshotIds must contain only non-empty strings' }, { status: 400 });
    }
    const ids = [...new Set(screenshotIds as string[])];
    if (ids.length > MAX_BULK_DELETE) {
      return NextResponse.json({ error: `Maximum ${MAX_BULK_DELETE} screenshots per bulk delete` }, { status: 400 });
    }

    // ORG DATA BOUNDARY: Screenshot is org-owned (copied to the org DB at
    // cutover) — always resolve through the org client. A misconfigured org
    // fails closed via OrgDbMisconfigurationError inside getPrismaForOrg.
    const orgData = (await getPrismaForOrg(orgId)).client;

    // Discover phase — the only place ids are trusted, and only together with
    // the authenticated organization. Cross-org and unknown ids simply do not
    // match here, so they can never be deleted, audited, or reported as gone.
    const matched = await orgData.screenshot.findMany({
      where: { id: { in: ids }, organizationId: orgId },
      select: { id: true, filePath: true, thumbnailPath: true },
    });

    if (matched.length === 0) {
      return NextResponse.json({ error: 'No screenshots found for the provided IDs' }, { status: 404 });
    }

    // Storage phase — delete artifacts FIRST (thumbnail, then original).
    // A missing object or an absent path counts as already deleted. Any real
    // storage failure keeps the DB row and reports the id in failedIds.
    const successIds: string[] = [];
    const failedIds: string[] = [];
    for (const shot of matched) {
      const artifacts = [shot.thumbnailPath, shot.filePath].filter(
        (p): p is string => Boolean(p)
      );
      let storageOk = true;
      for (const artifactPath of artifacts) {
        try {
          await deleteScreenshot(orgId, artifactPath);
        } catch (error) {
          if (!isNotFound(error)) {
            storageOk = false;
            log.warn('api.screenshots.bulk.delete.storage', { id: shot.id, error: String(error) }, requestContext(req));
            break;
          }
        }
      }
      if (storageOk) successIds.push(shot.id);
      else failedIds.push(shot.id);
    }

    // DB phase — delete only the rows whose artifacts are confirmed gone, and
    // write one audit record per successfully deleted screenshot, atomically.
    const ip = getClientIp(req);
    if (successIds.length > 0) {
      await orgData.$transaction(async (tx) => {
        // org-scoped deleteMany: re-asserts tenant isolation at deletion time.
        await tx.screenshot.deleteMany({
          where: { id: { in: successIds }, organizationId: orgId },
        });
        for (const id of successIds) {
          await tx.auditLog.create({
            data: {
              action: 'delete',
              resource: 'screenshot',
              resourceId: id,
              description: `Screenshot ${id} deleted`,
              userId: admin.userId,
              ipAddress: ip,
              organizationId: orgId,
            },
          });
        }
      });
    }

    return NextResponse.json({
      success: true,
      requested: ids.length,
      matched: matched.length,
      deleted: successIds.length,
      failed: failedIds.length,
      failedIds,
    });
  } catch (error) {
    log.error('api.screenshots.bulk.', { error: String('Screenshot bulk delete error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}