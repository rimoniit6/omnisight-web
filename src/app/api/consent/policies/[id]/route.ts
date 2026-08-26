import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authenticateRequest, getSessionOrg } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { log, requestContext } from '@/lib/logger';

// PATCH /api/consent/policies/[id] — publish / archive / redraft (admin+)
// Publishing a new version auto-archives the previously published one and
// makes every existing consent for that type require re-consent.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    const { id } = await params;
    const body = await req.json();
    const { action, title, content } = body as { action: string; title?: string; content?: string };

    if (!['publish', 'archive', 'redraft', 'edit'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    // Tenant isolation: policy must belong to the caller's organization.
    const policy = await db.consentPolicy.findUnique({ where: { id } });
    if (!policy || policy.organizationId !== org.id) {
      return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
    }

    const updated = await db.$transaction(async (tx) => {
      let next = policy;

      if (action === 'publish') {
        if (policy.status === 'published') {
          throw new Error('Policy is already published');
        }
        // Archive any currently published version of this type.
        await tx.consentPolicy.updateMany({
          where: { organizationId: org.id, consentType: policy.consentType, status: 'published' },
          data: { status: 'archived' },
        });
        next = await tx.consentPolicy.update({
          where: { id },
          data: { status: 'published', publishedAt: new Date(), effectiveAt: new Date(), publishedBy: auth.userId },
        });
      } else if (action === 'archive') {
        if (policy.status === 'draft') {
          throw new Error('Draft policies are deleted, not archived');
        }
        next = await tx.consentPolicy.update({ where: { id }, data: { status: 'archived' } });
      } else if (action === 'redraft') {
        if (policy.status !== 'archived') {
          throw new Error('Only archived policies can be redrafted');
        }
        next = await tx.consentPolicy.update({ where: { id }, data: { status: 'draft' } });
      } else {
        // edit — only drafts are editable
        if (policy.status !== 'draft') {
          throw new Error('Only draft policies can be edited');
        }
        next = await tx.consentPolicy.update({
          where: { id },
          data: { title: title ?? policy.title, content: content ?? policy.content },
        });
      }

      await tx.auditLog.create({
        data: {
          action: action === 'publish' ? 'configure' : 'update',
          resource: 'policy',
          resourceId: id,
          description: `Consent policy ${policy.version} for ${policy.consentType} ${action === 'publish' ? 'published' : action === 'archive' ? 'archived' : action === 'redraft' ? 'redrafted' : 'edited'} by ${auth.email}`,
          userId: auth.userId,
          organizationId: org.id,
        },
      });
      return next;
    });

    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update policy';
    // State-machine violations are client errors (400); everything else is 500.
    const isStateRule =
      message.startsWith('Policy is ') ||
      message.startsWith('Draft policies ') ||
      message.startsWith('Only ') ||
      message.includes('cannot be archived');
    if (!isStateRule) log.error('api.consent.policies.id.', { error: String('Consent policy PATCH error:') }, requestContext(req));
    return NextResponse.json({ error: message }, { status: isStateRule ? 400 : 500 });
  }
}

// DELETE /api/consent/policies/[id] — delete a draft (admin+). Published and
// archived policies are never hard-deleted: they anchor the audit trail.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    const { id } = await params;
    const policy = await db.consentPolicy.findUnique({ where: { id } });
    if (!policy || policy.organizationId !== org.id) {
      return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
    }
    if (policy.status !== 'draft') {
      return NextResponse.json({ error: 'Only draft policies can be deleted' }, { status: 400 });
    }

    await db.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          action: 'delete',
          resource: 'policy',
          resourceId: id,
          description: `Consent policy ${policy.version} for ${policy.consentType} deleted by ${auth.email}`,
          userId: auth.userId,
          organizationId: org.id,
        },
      });
      await tx.consentPolicy.delete({ where: { id } });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('api.consent.policies.id.', { error: String('Consent policy DELETE error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to delete policy' }, { status: 500 });
  }
}
