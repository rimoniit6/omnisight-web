import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authenticateRequest, getSessionOrg } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { log, requestContext } from '@/lib/logger';
import {
  CONSENT_TYPES,
  isValidConsentType,
  nextPolicyVersion,
  defaultPolicyText,
} from '@/lib/consent';

// GET /api/consent/policies — list policy versions per consent type (org-scoped)
// Manager+ (S-01): policy text/versions reveal the org's consent program —
// same gate as every other consent read. Mutations remain admin+.
export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'manager')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    const policies = await db.consentPolicy.findMany({
      where: { organizationId: org.id },
      orderBy: [{ consentType: 'asc' }, { version: 'asc' }],
    });

    const byType = CONSENT_TYPES.map((type) => {
      const typePolicies = policies.filter((p) => p.consentType === type);
      const published = typePolicies.find((p) => p.status === 'published');
      return {
        type,
        label: defaultPolicyText(type).title,
        published: published ?? null,
        versions: typePolicies,
      };
    });

    return NextResponse.json({ data: byType });
  } catch (error) {
    log.error('api.consent.policies.', { error: String('Consent policies GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch consent policies' }, { status: 500 });
  }
}

// POST /api/consent/policies — create a draft policy (admin+)
export async function POST(req: NextRequest) {
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

    const body = await req.json();
    const { consentType, title, content } = body as {
      consentType: string;
      title?: string;
      content?: string;
    };

    if (!isValidConsentType(consentType)) {
      return NextResponse.json({ error: `Invalid consentType. Valid: ${CONSENT_TYPES.join(', ')}` }, { status: 400 });
    }
    if (!content || content.trim().length < 20) {
      return NextResponse.json({ error: 'Policy content is required (min 20 characters)' }, { status: 400 });
    }

    const existingVersions = await db.consentPolicy.findMany({
      where: { organizationId: org.id, consentType },
      select: { version: true },
    });

    const policy = await db.$transaction(async (tx) => {
      const created = await tx.consentPolicy.create({
        data: {
          organizationId: org.id,
          consentType,
          title: title?.trim() || defaultPolicyText(consentType).title,
          content: content.trim(),
          version: nextPolicyVersion(existingVersions.map((v) => v.version)),
          status: 'draft',
          createdBy: auth.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'policy',
          resourceId: created.id,
          description: `Consent policy ${created.version} created for ${consentType}`,
          userId: auth.userId,
          organizationId: org.id,
        },
      });
      return created;
    });

    return NextResponse.json(policy, { status: 201 });
  } catch (error) {
    log.error('api.consent.policies.', { error: String('Consent policies POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to create consent policy' }, { status: 500 });
  }
}
