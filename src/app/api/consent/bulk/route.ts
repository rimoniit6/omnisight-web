import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionOrg, authenticateRequest } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { CONSENT_TYPES, applyConsentTransition } from '@/lib/consent';
import type { ConsentStatus, ConsentType } from '@/lib/consent';
import { endWebcamSessionsOnRevoke } from '@/lib/webcam-session-cleanup';
import { log, requestContext } from '@/lib/logger';

// POST /api/consent/bulk — Bulk grant or revoke consents for an employee (admin only)
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const body = await req.json();
    const { employeeId, action, consentTypes } = body as {
      employeeId: string;
      action: 'grant_all' | 'revoke_all' | 'grant_types' | 'revoke_types';
      consentTypes?: string[];
    };

    if (!employeeId || !action) {
      return NextResponse.json({ error: 'employeeId and action required' }, { status: 400 });
    }

    if (consentTypes !== undefined && !Array.isArray(consentTypes)) {
      return NextResponse.json({ error: 'consentTypes must be an array of consent types' }, { status: 400 });
    }

    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    // Tenant isolation: the employee must belong to the caller's organization.
    const emp = await db.employee.findFirst({
      where: { id: employeeId, organizationId: org.id },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!emp) return NextResponse.json({ error: 'Employee not found in your organization' }, { status: 404 });

    const allTypes = [...CONSENT_TYPES];
    const types = action === 'grant_all' || action === 'revoke_all' ? allTypes : (consentTypes || []);

    // Whitelist: reject unknown consent types before any write.
    const validTypes = new Set<string>(allTypes);
    const invalidTypes = types.filter((t) => !validTypes.has(t));
    if (invalidTypes.length > 0) {
      return NextResponse.json(
        { error: `Invalid consentType(s): ${invalidTypes.join(', ')}. Valid: ${allTypes.join(', ')}` },
        { status: 400 }
      );
    }
    if (types.length === 0) {
      return NextResponse.json({ error: 'No consent types selected' }, { status: 400 });
    }

    // After the whitelist check, every remaining entry is a known consent type.
    const typedTypes = types as ConsentType[];

    const newStatus: ConsentStatus = action.startsWith('grant') ? 'granted' : 'revoked';

    const updated = await db.$transaction(async (tx) => {
      let count = 0;

      for (const type of typedTypes) {
        const existing = await tx.consent.findFirst({ where: { employeeId, consentType: type } });

        if (existing) {
          await applyConsentTransition(
            tx,
            { id: existing.id, status: existing.status as ConsentStatus, consentType: type, organizationId: org.id },
            newStatus,
            { performedBy: auth.email, userId: auth.userId, writeAuditLog: false }
          );
        } else {
          // Create as 'pending' then transition — binds the CURRENT published
          // policy version and writes the ConsentLog entry via the state machine.
          const consent = await tx.consent.create({
            data: {
              employeeId,
              consentType: type,
              status: 'pending',
              organizationId: org.id,
            },
          });
          await applyConsentTransition(
            tx,
            { id: consent.id, status: 'pending', consentType: type, organizationId: org.id },
            newStatus,
            { performedBy: auth.email, userId: auth.userId, writeAuditLog: false }
          );
        }
        count++;
      }

      // Audit log
      await tx.auditLog.create({
        data: {
          action: 'update',
          resource: 'consent',
          description: `Bulk ${newStatus} ${count} consents for ${emp.firstName} ${emp.lastName}`,
          userId: auth.userId,
          organizationId: org.id,
        },
      });

      return count;
    });

    // S-06: a bulk revoke that touches webcam_access consent ends the
    // employee's active webcam sessions and drops buffered frames immediately.
    if (newStatus === 'revoked' && typedTypes.includes('webcam_access')) {
      await endWebcamSessionsOnRevoke(emp.id);
    }

    return NextResponse.json({ success: true, updated, action: newStatus, types: types.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('No published policy')) {
      return NextResponse.json(
        { error: 'Cannot grant: no published policy for one of the requested consent types. Publish the policy first.' },
        { status: 409 }
      );
    }
    if (message.startsWith('Invalid consent transition')) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    log.error('api.consent.bulk.', { error: String('Consent bulk error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to bulk update consents' }, { status: 500 });
  }
}
