import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionOrg, authenticateRequest } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { CONSENT_TYPES } from '@/lib/consent';
import { log, requestContext } from '@/lib/logger';

// GET /api/consent/summary — Get consent compliance summary
//
// Employee coverage: EVERY ACTIVE employee of the caller's organization is
// listed, including employees with ZERO consent records (consents: []). An
// admin must be able to grant consent to a brand-new employee — the page's
// employee list is driven by this endpoint, so omitting zero-consent rows
// made those employees unreachable. Inactive employees that still hold
// consent history remain visible so compliance reporting never loses them.
// Tenant isolation is preserved: both queries are organization-scoped.
export async function GET(req: NextRequest) {
  try {
    // Manager+ (S-01): the summary is the org's full consent-compliance dataset
    // (employee names, statuses, revocations, policy versions) — the same gate
    // as the list route and the UI page, enforced server-side.
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'manager')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    // Shared employee shape used by the consent rows and the active-employee
    // query so the response contract stays identical.
    const EMPLOYEE_SELECT = {
      id: true,
      firstName: true,
      lastName: true,
      employeeId: true,
      avatar: true,
      designation: true,
      status: true,
    } as const;

    // Single source of truth for the supported consent types (8 today):
    // monitoring, screenshot, activity_tracking, keystroke, usb_monitoring,
    // webcam_access, location, email_monitoring.
    const consentTypes = [...CONSENT_TYPES];

    const typeLabels: Record<string, string> = {
      monitoring: 'General Monitoring',
      screenshot: 'Screenshot Capture',
      activity_tracking: 'Activity Tracking',
      keystroke: 'Keystroke Logging',
      usb_monitoring: 'USB Monitoring',
      webcam_access: 'Webcam Access',
      location: 'Location Tracking',
      email_monitoring: 'Email Monitoring',
    };

    // Three parallel org-scoped queries — no N+1 regardless of employee count.
    const [allConsents, activeEmployees, publishedPolicies] = await Promise.all([
      db.consent.findMany({
        where: { organizationId: org.id },
        include: { employee: { select: EMPLOYEE_SELECT } },
      }),
      db.employee.findMany({
        where: { organizationId: org.id, status: 'active' },
        select: EMPLOYEE_SELECT,
      }),
      db.consentPolicy.findMany({
        where: { organizationId: org.id, status: 'published' },
        select: { consentType: true, version: true, id: true },
      }),
    ]);
    const policyByType = new Map(publishedPolicies.map((p) => [p.consentType, p]));

    // Seed with EVERY active employee (consents: []) — zero-consent employees
    // appear in the admin consent list. Consent rows are then merged in;
    // employees who went inactive but still hold consent history are kept.
    type EmployeeInfo = (typeof activeEmployees)[number];
    type ConsentRow = (typeof allConsents)[number];
    const employeeMap = new Map<string, { employee: EmployeeInfo; consents: ConsentRow[] }>();
    for (const e of activeEmployees) {
      employeeMap.set(e.id, { employee: e, consents: [] });
    }
    for (const c of allConsents) {
      if (!employeeMap.has(c.employeeId)) {
        employeeMap.set(c.employeeId, { employee: c.employee, consents: [] });
      }
      employeeMap.get(c.employeeId)!.consents.push(c);
    }

    const employees = Array.from(employeeMap.values()).map(({ employee, consents }) => {
      const granted = consents.filter(c => c.status === 'granted').length;
      const total = consentTypes.length;
      const pct = Math.round((granted / total) * 100);
      // NOT vacuous: an employee with zero consents must NOT be fully compliant.
      const allGranted = consents.length > 0 && consents.every(c => c.status === 'granted');
      const hasPending = consents.some(c => c.status === 'pending');
      const hasRevoked = consents.some(c => c.status === 'revoked');
      const hasDenied = consents.some(c => c.status === 'denied');

      return {
        employee,
        total,
        granted,
        pending: consents.filter(c => c.status === 'pending').length,
        denied: consents.filter(c => c.status === 'denied').length,
        revoked: consents.filter(c => c.status === 'revoked').length,
        expired: consents.filter(c => c.status === 'expired').length,
        pct,
        allGranted,
        hasPending,
        hasRevoked,
        hasDenied,
        complianceStatus: allGranted ? 'fully_compliant' : pct >= 60 ? 'partial' : 'non_compliant',
        lastConsent: consents.length > 0
          ? consents.slice().sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[consents.length - 1]?.createdAt ?? null
          : null,
        // Per-type records so the UI renders real statuses and real consent IDs
        consents: consents.map((c) => {
          const published = policyByType.get(c.consentType);
          return {
            id: c.id,
            consentType: c.consentType,
            status: c.status,
            grantedAt: c.grantedAt,
            revokedAt: c.revokedAt,
            consentVersion: c.consentVersion,
            policyId: c.policyId,
            // granted against an outdated policy version => must re-consent
            requiresReconsent: c.status === 'granted' && !!published && c.consentVersion !== published.version,
          };
        }),
      };
    });

    // Overall stats
    const totalEmployees = employees.length;
    const fullyCompliant = employees.filter(e => e.allGranted).length;
    const nonCompliant = employees.filter(e => e.pct < 60).length;
    const overallPct = totalEmployees > 0 ? Math.round(employees.reduce((s, e) => s + e.pct, 0) / totalEmployees) : 0;

    // Type-level breakdown
    const typeBreakdown = consentTypes.map(type => {
      const typeConsents = allConsents.filter(c => c.consentType === type);
      const published = policyByType.get(type);
      return {
        type,
        label: typeLabels[type],
        total: typeConsents.length,
        granted: typeConsents.filter(c => c.status === 'granted').length,
        pending: typeConsents.filter(c => c.status === 'pending').length,
        denied: typeConsents.filter(c => c.status === 'denied').length,
        revoked: typeConsents.filter(c => c.status === 'revoked').length,
        expired: typeConsents.filter(c => c.status === 'expired').length,
        policyVersion: published?.version ?? null,
        requiresReconsent: typeConsents.filter(c => c.status === 'granted' && !!published && c.consentVersion !== published.version).length,
        pct: typeConsents.length > 0 ? Math.round((typeConsents.filter(c => c.status === 'granted').length / typeConsents.length) * 100) : 0,
      };
    });

    return NextResponse.json({
      summary: { totalEmployees, fullyCompliant, nonCompliant, overallPct },
      typeBreakdown,
      employees: employees.sort((a, b) => b.pct - a.pct),
    });
  } catch (error) {
    log.error('api.consent.summary.', { error: String('Consent summary error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to get consent summary' }, { status: 500 });
  }
}
