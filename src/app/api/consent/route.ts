import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionOrg, authenticateRequest, validatePagination } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { isValidConsentType, CONSENT_TYPES, MAX_CONSENT_NOTES_LENGTH, applyConsentTransition } from '@/lib/consent';
import type { ConsentStatus } from '@/lib/consent';

// GET /api/consent — List all consent records with filters
// Manager+ (S-01): the UI gates the Consent page to manager and the proxy
// rule matches; the handler enforces the same gate so a viewer can never read
// the org's consent-compliance dataset (never proxy-only).
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
    if (!org) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 });
    }

    const { searchParams } = new URL(req.url);
    const consentType = searchParams.get('type') || '';
    const status = searchParams.get('status') || '';
    const employeeId = searchParams.get('employeeId') || '';
    const search = searchParams.get('search') || '';

    const pagination = validatePagination(searchParams, { defaultPageSize: 50, maxPageSize: 200 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }
    const { page, pageSize, skip } = pagination;

    const where: Record<string, unknown> = { organizationId: org.id };
    if (consentType) where.consentType = consentType;
    if (status) where.status = status;
    if (employeeId) where.employeeId = employeeId;
    if (search) {
      where.OR = [
        { employee: { firstName: { contains: search } } },
        { employee: { lastName: { contains: search } } },
        { employee: { employeeId: { contains: search } } },
      ];
    }

    const [consents, total] = await Promise.all([
      db.consent.findMany({
        where,
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeId: true, avatar: true, designation: true, department: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      db.consent.count({ where }),
    ]);

    // Stats
    const allConsents = await db.consent.findMany({
      where: { organizationId: org.id },
      select: { status: true, consentType: true, employeeId: true },
    });
    const uniqueEmployees = new Set(allConsents.map(c => c.employeeId)).size;
    const stats = {
      total: allConsents.length,
      employees: uniqueEmployees,
      byStatus: {
        granted: allConsents.filter(c => c.status === 'granted').length,
        pending: allConsents.filter(c => c.status === 'pending').length,
        denied: allConsents.filter(c => c.status === 'denied').length,
        revoked: allConsents.filter(c => c.status === 'revoked').length,
        expired: allConsents.filter(c => c.status === 'expired').length,
      },
      byType: allConsents.reduce<Record<string, number>>((acc, c) => {
        acc[c.consentType] = (acc[c.consentType] || 0) + 1;
        return acc;
      }, {}),
    };

    return NextResponse.json({ data: consents, total, page, pageSize, totalPages: Math.ceil(total / pageSize), stats });
  } catch (error) {
    console.error('Consent GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch consents' }, { status: 500 });
  }
}

// POST /api/consent — Create consent record (admin creates or employee signs)
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
    const { employeeId, consentType, status, notes } = body as {
      employeeId: string;
      consentType: string;
      status?: string;
      notes?: string;
    };

    if (!employeeId || !consentType) {
      return NextResponse.json({ error: 'employeeId and consentType required' }, { status: 400 });
    }

    if (!isValidConsentType(consentType)) {
      return NextResponse.json({ error: `Invalid consentType. Valid: ${CONSENT_TYPES.join(', ')}` }, { status: 400 });
    }

    const org = await getSessionOrg(req);
    if (!org) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 });
    }

    // Tenant isolation: the employee must belong to the caller's organization.
    const employee = await db.employee.findFirst({
      where: { id: employeeId, organizationId: org.id },
      select: { id: true },
    });
    if (!employee) {
      return NextResponse.json({ error: 'Employee not found in your organization' }, { status: 404 });
    }

    // Check existing consent for same type (org-scoped via the verified employee)
    const existing = await db.consent.findFirst({
      where: { employeeId: employee.id, consentType },
    });
    if (existing && existing.status === 'granted') {
      return NextResponse.json({ error: 'Consent already granted for this type' }, { status: 409 });
    }

    const targetStatus: ConsentStatus = 'granted';
    if (status && status !== 'granted') {
      return NextResponse.json({ error: 'Only status "granted" is supported on create; use PUT to change state' }, { status: 400 });
    }
    if (notes && notes.length > MAX_CONSENT_NOTES_LENGTH) {
      return NextResponse.json(
        { error: `notes must be at most ${MAX_CONSENT_NOTES_LENGTH} characters` },
        { status: 400 }
      );
    }

    try {
      const consent = await db.$transaction(async (tx) => {
        if (existing) {
          return applyConsentTransition(
            tx,
            { id: existing.id, status: existing.status as ConsentStatus, consentType, organizationId: org.id },
            targetStatus,
            { performedBy: auth.email, userId: auth.userId, notes: notes || null, action: 'admin_granted' }
          );
        }

        // Create as 'pending' then transition — the shared state machine binds
        // the CURRENT published policy version and writes the ConsentLog entry.
        const created = await tx.consent.create({
          data: {
            employeeId,
            consentType,
            status: 'pending',
            notes: notes || null,
            organizationId: org.id,
          },
        });

        return applyConsentTransition(
          tx,
          { id: created.id, status: 'pending', consentType, organizationId: org.id },
          targetStatus,
          { performedBy: auth.email, userId: auth.userId, notes: notes || null, action: 'admin_granted' }
        );
      });

      // 201 only when a fresh record was created; a transition of an existing
      // record is an update and returns 200.
      return NextResponse.json(consent, { status: existing ? 200 : 201 });
    } catch (transitionError) {
      const message = transitionError instanceof Error ? transitionError.message : String(transitionError);
      if (message.startsWith('No published policy')) {
        return NextResponse.json(
          { error: 'Cannot grant consent: no published policy for this consent type. Publish one first.' },
          { status: 409 }
        );
      }
      if (message.startsWith('Invalid consent transition')) {
        return NextResponse.json({ error: message }, { status: 409 });
      }
      console.error('Consent POST error:', transitionError);
      return NextResponse.json({ error: 'Failed to create consent' }, { status: 500 });
    }
  } catch (error) {
    console.error('Consent POST error:', error);
    return NextResponse.json({ error: 'Failed to create consent' }, { status: 500 });
  }
}
