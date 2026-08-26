import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';
import { getConsentState, applyConsentTransition } from '@/lib/consent';
import type { ConsentStatus } from '@/lib/consent';
import { log, requestContext } from '@/lib/logger';

// GET /api/agent/consent — Agent checks if employee has granted consent for specific types
// Version-aware: uses the same enforcement semantics as the upload endpoints
// (getConsentState mirrors hasActiveConsent), so a consent bound to an outdated
// policy version reports as NOT granted (re-consent required) and the agent
// stops the corresponding capture. Fails closed.
//
// PERFORMANCE: the consent state for ALL requested types is evaluated with a
// bounded pattern — 1 query for the employee's consent rows + 1 query for the
// org's current published policies — instead of up to ~16 per-poll lookups.
// The response contract is unchanged: { employeeId, allGranted, consents, missing }.
export async function GET(req: NextRequest) {
  try {
    const auth = await validateAgentToken(req);
    if (!auth.valid || !auth.employee) {
      return NextResponse.json({ error: auth.error || 'Authentication failed' }, { status: 401 });
    }
    // Capture after the guard so TS narrowing survives the async closure below.
    const employee = auth.employee;

    const { searchParams } = new URL(req.url);
    const typesParam = searchParams.get('types') || 'monitoring,screenshot,activity_tracking';
    const types = [...new Set(typesParam.split(',').map((t) => t.trim()).filter(Boolean))];

    // Only ever query a bounded set of known consent types.
    const validTypes = ['monitoring', 'screenshot', 'activity_tracking', 'keystroke', 'usb_monitoring', 'webcam_access', 'location', 'email_monitoring'];
    const requested = types.filter((t) => validTypes.includes(t));
    if (requested.length === 0) {
      return NextResponse.json({ error: 'No valid consent types requested' }, { status: 400 });
    }

    const consents = await getConsentState(employee.id, employee.organizationId, requested);
    const allGranted = requested.every((t) => consents[t]);

    return NextResponse.json({
      employeeId: employee.id,
      allGranted,
      consents,
      missing: requested.filter((t) => !consents[t]),
    });
  } catch (error) {
    log.error('api.agent.consent.', { error: String('Agent consent check error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to check consent' }, { status: 500 });
  }
}

// POST /api/agent/consent — Employee signs/revokes consent from agent
// Goes through the shared audited state machine (applyConsentTransition) so
// grants bind the CURRENT published policy version, every change is logged to
// ConsentLog, and the state machine rejects illegal transitions server-side.
export async function POST(req: NextRequest) {
  try {
    const auth = await validateAgentToken(req);
    if (!auth.valid || !auth.employee) {
      return NextResponse.json({ error: auth.error || 'Authentication failed' }, { status: 401 });
    }
    // Capture after the guard so TS narrowing survives the async closure below.
    const employee = auth.employee;

    const body = await req.json();
    const { consentType, action } = body as { consentType: string; action: 'grant' | 'revoke' };

    if (!consentType || !action) {
      return NextResponse.json({ error: 'consentType and action required' }, { status: 400 });
    }
    if (!['grant', 'revoke'].includes(action)) {
      return NextResponse.json({ error: 'action must be "grant" or "revoke"' }, { status: 400 });
    }

    const validTypes = ['monitoring', 'screenshot', 'activity_tracking', 'keystroke', 'usb_monitoring', 'webcam_access', 'location', 'email_monitoring'];
    if (!validTypes.includes(consentType)) {
      return NextResponse.json({ error: 'Invalid consentType' }, { status: 400 });
    }

    // Tenant isolation: the organization is derived from the authenticated
    // agent token's employee — never a findFirst() across tenants.
    const orgId = employee.organizationId;
    if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 404 });

    const target: ConsentStatus = action === 'grant' ? 'granted' : 'revoked';

    try {
      await db.$transaction(async (tx) => {
        const existing = await tx.consent.findFirst({
          where: { employeeId: employee.id, consentType },
        });

        if (existing) {
          await applyConsentTransition(
            tx,
            {
              id: existing.id,
              status: existing.status as ConsentStatus,
              consentType,
              organizationId: orgId,
            },
            target,
            {
              performedBy: `${employee.firstName} ${employee.lastName}`,
              ipAddress: null,
              action: action === 'grant' ? 'renewed' : 'revoked',
            }
          );
        } else {
          const created = await tx.consent.create({
            data: { employeeId: employee.id, consentType, status: 'pending', organizationId: orgId },
          });
          await applyConsentTransition(
            tx,
            { id: created.id, status: 'pending', consentType, organizationId: orgId },
            target,
            {
              performedBy: `${employee.firstName} ${employee.lastName}`,
              ipAddress: null,
              action: action === 'grant' ? 'granted' : 'revoked',
            }
          );
        }
      });
    } catch (transitionError) {
      const message = transitionError instanceof Error ? transitionError.message : String(transitionError);
      // Granting requires a current published policy — fail closed.
      if (message.startsWith('No published policy')) {
        return NextResponse.json(
          { error: 'Cannot grant consent: no published policy for this consent type. An administrator must publish one first.' },
          { status: 409 }
        );
      }
      if (message.startsWith('Invalid consent transition')) {
        return NextResponse.json({ error: message }, { status: 409 });
      }
      throw transitionError;
    }

    return NextResponse.json({ success: true, action, consentType });
  } catch (error) {
    log.error('api.agent.consent.', { error: String('Agent consent POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update consent' }, { status: 500 });
  }
}
