import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getScopedEmployee } from '@/lib/self-guard';
import { authenticateRequest } from '@/lib/api';
import { applyConsentTransition, isValidConsentType } from '@/lib/consent';
import type { ConsentStatus, ConsentType } from '@/lib/consent';
import { log, requestContext } from '@/lib/logger';

// PUT /api/self/consents/[id]
// Manager+ role (enforced by middleware); employee scoped to caller's org.
// Employee-side consent actions: accept (grant), deny, revoke. Every change
// goes through the shared state machine and binds the current published
// policy version on grant.
//
// CREATE-ON-GRANT (P1 fix): the GET route synthesizes `pending:{type}` rows
// in memory for consent types that have no DB record yet (so the UI renders
// all 8 types). A grant on such a row must CREATE the record first (the same
// behavior as POST /api/consent) — previously the PUT 404'd on the synthetic
// id and a pending type could never be granted from the portal.
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { employeeId, status, notes, consentType } = body as {
      employeeId: string;
      status: 'granted' | 'denied' | 'revoked';
      notes?: string;
      consentType?: string;
    };

    if (!employeeId) {
      return NextResponse.json({ error: 'employeeId is required' }, { status: 400 });
    }

    if (!status || !['granted', 'denied', 'revoked'].includes(status)) {
      return NextResponse.json(
        { error: 'status must be "granted", "denied" or "revoked"' },
        { status: 400 }
      );
    }

    // Tenant-scoped lookup: employee must belong to the caller's org
    const { employee: scoped, error: scopeError } = await getScopedEmployee(req, employeeId);
    if (scopeError || !scoped) {
      return NextResponse.json({ error: scopeError || 'Employee not found' }, { status: 404 });
    }

    // Full employee record (name for the audit trail)
    const employee = await db.employee.findUnique({
      where: { id: scoped.id },
      select: { id: true, firstName: true, lastName: true, organizationId: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    }

    // AUDIT ATTRIBUTION: the authenticated actor is the principal. A manager
    // acting on Employee A is recorded as the manager; the employee is the
    // target (subject), never the actor, unless the employee acted themselves.
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    const actorLabel = auth.email;

    // Resolve the target consent. Two id forms:
    //   - a real consent id (from a DB row the UI received from GET), or
    //   - a synthetic `pending:{type}` id for a consent type with NO record
    //     yet — resolved by type; a grant/deny/revoke CREATES the record.
    const pendingPrefix = 'pending:';
    const syntheticType = id.startsWith(pendingPrefix)
      ? id.slice(pendingPrefix.length)
      : consentType && isValidConsentType(consentType)
        ? consentType
        : null;

    let consent: {
      id: string;
      status: ConsentStatus;
      consentType: string;
      organizationId: string;
      employeeId: string;
    } | null = null;
    let created = false;

    if (syntheticType) {
      // Find-or-create for a consent type that has no row yet. The type is
      // validated against CONSENT_TYPES so an arbitrary id can never resolve.
      const existing = await db.consent.findFirst({
        where: { employeeId: employee.id, consentType: syntheticType },
        select: { id: true, status: true, consentType: true, organizationId: true, employeeId: true },
      });
      if (existing) {
        consent = {
          id: existing.id,
          status: existing.status as ConsentStatus,
          consentType: existing.consentType,
          organizationId: existing.organizationId,
          employeeId: existing.employeeId,
        };
      } else {
        // Non-grant transitions on a missing record are impossible (there is
        // nothing to deny/revoke) — only a grant materializes the row.
        if (status !== 'granted') {
          return NextResponse.json(
            { error: 'Consent record does not exist for this type' },
            { status: 404 }
          );
        }
        const createdRow = await db.consent.create({
          data: {
            employeeId: employee.id,
            consentType: syntheticType,
            status: 'pending',
            organizationId: employee.organizationId,
          },
          select: { id: true, status: true, consentType: true, organizationId: true, employeeId: true },
        });
        consent = {
          id: createdRow.id,
          status: createdRow.status as ConsentStatus,
          consentType: createdRow.consentType,
          organizationId: createdRow.organizationId,
          employeeId: createdRow.employeeId,
        };
        created = true;
      }
    } else {
      const found = await db.consent.findUnique({ where: { id } });
      if (!found) {
        return NextResponse.json({ error: 'Consent not found' }, { status: 404 });
      }
      consent = {
        id: found.id,
        status: found.status as ConsentStatus,
        consentType: found.consentType,
        organizationId: found.organizationId,
        employeeId: found.employeeId,
      };
    }

    // Ensure this consent belongs to the employee (consent is guaranteed
    // non-null here — every branch above assigns it or returned an error).
    if (!consent || consent.employeeId !== employee.id) {
      return NextResponse.json(
        { error: 'You can only update your own consents' },
        { status: 403 }
      );
    }

    try {
      const updated = await db.$transaction(async (tx) =>
        applyConsentTransition(
          tx,
          consent!,
          status as ConsentStatus,
          {
            performedBy: actorLabel,
            ipAddress: null,
            userId: auth.userId,
            notes: notes ?? null,
            // Manager-initiated revoke through the portal is recorded as a
            // plain revoke (audit log carries the actor email); the admin
            // consent route uses 'admin_revoked' — the actor attribution is
            // what matters for the trail.
            action: status === 'revoked' ? 'revoked' : undefined,
          }
        )
      );

      // 201 only when a fresh record was materialized; otherwise 200 (update).
      return NextResponse.json({ data: updated }, { status: created ? 201 : 200 });
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
    log.error('api.self.consents.id.', { error: String('Self Consent PUT error:') }, requestContext(req));
    return NextResponse.json(
      { error: 'Failed to update consent' },
      { status: 500 }
    );
  }
}
