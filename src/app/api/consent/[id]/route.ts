import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authenticateRequest, getSessionOrg } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { applyConsentTransition, isValidConsentStatus } from '@/lib/consent';
import type { ConsentStatus } from '@/lib/consent';
import { endWebcamSessionsOnRevoke } from '@/lib/webcam-session-cleanup';

// PUT /api/consent/[id] — update consent (revoke, renew, grant, deny)
// Manager+ role; the consent must belong to the caller's organization.
// All transitions go through the shared state machine which binds the
// current published policy on every grant.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id } = await params;
    const body = await req.json();
    const { status, notes } = body as { status: string; notes?: string };

    if (!status || !isValidConsentStatus(status)) {
      return NextResponse.json({ error: 'Valid status required' }, { status: 400 });
    }

    // Tenant isolation: the consent must belong to the caller's organization.
    const consent = await db.consent.findUnique({ where: { id, organizationId: org.id } });
    if (!consent) {
      return NextResponse.json({ error: 'Consent not found' }, { status: 404 });
    }

    try {
      const updated = await db.$transaction(async (tx) =>
        applyConsentTransition(
          tx,
          { id: consent.id, status: consent.status as ConsentStatus, consentType: consent.consentType, organizationId: consent.organizationId },
          status as ConsentStatus,
          {
            // AUDIT ATTRIBUTION: always the authenticated actor. The client
            // may never claim to be "system" or someone else.
            performedBy: auth.email,
            ipAddress: null,
            userId: auth.userId,
            notes: notes ?? null,
            // This route is manager+; a revoke from here is always an admin
            // action performed on another employee's consent.
            action: status === 'revoked' ? 'admin_revoked' : undefined,
          }
        )
      );

      // S-06: revoking webcam_access consent ends every active webcam session
      // for that employee and drops buffered relay frames IMMEDIATELY — frame
      // flow must not continue until the agent's next (≤5s) gate re-check.
      if (status === 'revoked' && consent.consentType === 'webcam_access') {
        await endWebcamSessionsOnRevoke(consent.employeeId);
      }

      return NextResponse.json(updated);
    } catch (transitionError) {
      const message = transitionError instanceof Error ? transitionError.message : 'Invalid transition';
      if (message.startsWith('Invalid consent transition')) {
        return NextResponse.json({ error: message }, { status: 409 });
      }
      if (message.startsWith('No published policy')) {
        return NextResponse.json(
          { error: 'No published consent policy is available. Publish the policy before granting.' },
          { status: 409 }
        );
      }
      throw transitionError;
    }
  } catch (error) {
    console.error('Consent PUT error:', error);
    return NextResponse.json({ error: 'Failed to update consent' }, { status: 500 });
  }
}

// DELETE /api/consent/[id] — Erase a consent record (admin only)
//
// AUDIT TRAIL POLICY: consent/audit history is IMMUTABLE. A consent that owns
// ConsentLog entries can never be hard-deleted — the FK is RESTRICT and this
// route returns 409. Only consent records with zero history (e.g. an empty
// pending row created by mistake) may be erased. Where GDPR/data-erasure
// requires removing personal information, use the retention processor's
// anonymization path (ConsentLog.performedBy/ipAddress scrubbed) instead of
// destroying the audit event structure.
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

    // Tenant isolation: the consent must belong to the caller's organization.
    const consent = await db.consent.findUnique({ where: { id, organizationId: org.id } });
    if (!consent) {
      return NextResponse.json({ error: 'Consent not found' }, { status: 404 });
    }

    // Immutable history: refuse to destroy a consent that produced audit logs.
    const logCount = await db.consentLog.count({ where: { consentId: id } });
    if (logCount > 0) {
      return NextResponse.json(
        {
          error:
            'Consent history is immutable. This consent has audit log entries; erase the personal data via anonymization instead of deleting the record.',
        },
        { status: 409 }
      );
    }

    await db.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          action: 'delete',
          resource: 'consent',
          resourceId: id,
          description: `Consent ${consent.consentType} for employee ${consent.employeeId} deleted by ${auth.email}`,
          userId: auth.userId,
          organizationId: consent.organizationId,
        },
      });
      await tx.consent.delete({ where: { id } });
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    // FK RESTRICT backstop: a log inserted between the count check and the
    // delete surfaces as a Prisma P2003 — map it to the same 409 as the guard.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'P2003'
    ) {
      return NextResponse.json(
        { error: 'Consent history is immutable. This consent has audit log entries and cannot be deleted.' },
        { status: 409 }
      );
    }
    console.error('Consent DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete consent' }, { status: 500 });
  }
}
