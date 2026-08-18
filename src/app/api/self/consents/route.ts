import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getScopedEmployee } from '@/lib/self-guard';
import { CONSENT_TYPES } from '@/lib/consent';

// GET /api/self/consents?employeeId=xxx
// Manager+ role (enforced by middleware); employee scoped to caller's org.
// Returns each consent enriched with the current published policy so the
// employee can read what they are consenting to and see re-consent flags.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const employeeId = searchParams.get('employeeId');

    if (!employeeId) {
      return NextResponse.json({ error: 'employeeId is required' }, { status: 400 });
    }

    // Tenant-scoped lookup: employee must belong to the caller's org
    const { employee: scoped, error: scopeError } = await getScopedEmployee(req, employeeId);
    if (scopeError || !scoped) {
      return NextResponse.json({ error: scopeError || 'Employee not found' }, { status: 404 });
    }

    // Published policies per type for the employee's org
    const publishedPolicies = await db.consentPolicy.findMany({
      where: { organizationId: scoped.organizationId, status: 'published' },
      select: { id: true, consentType: true, title: true, version: true, content: true },
    });
    const policyByType = new Map(publishedPolicies.map((p) => [p.consentType, p]));

    // Fetch existing consents with their logs
    const existingConsents = await db.consent.findMany({
      where: { employeeId: scoped.id },
      include: {
        consentLogs: {
          select: {
            id: true,
            action: true,
            description: true,
            performedBy: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    // Build map of existing consent types
    const consentMap = new Map(existingConsents.map((c) => [c.consentType, c]));

    // READ-ONLY: never persist rows from a GET. Missing types are synthesized
    // in memory as 'pending' so the UI still renders all 8 rows; the record is
    // created by a real mutation (grant/revoke) instead.
    const missingTypes = CONSENT_TYPES.filter((t) => !consentMap.has(t));
    const syntheticConsents = missingTypes.map((consentType) => ({
      id: `pending:${consentType}`,
      employeeId: scoped.id,
      consentType,
      status: 'pending' as const,
      organizationId: scoped.organizationId,
      consentVersion: null,
      policyId: null,
      grantedAt: null,
      revokedAt: null,
      expiresAt: null,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      consentLogs: [
        {
          id: `pending:${consentType}:log`,
          consentId: `pending:${consentType}`,
          action: 'requested' as const,
          description: `Consent for ${consentType} awaiting decision`,
          performedBy: 'system',
          createdAt: new Date(),
        },
      ],
    }));

    const refreshed = [...existingConsents, ...syntheticConsents];
    const refreshedMap = new Map(refreshed.map((c) => [c.consentType, c]));
    const consents = CONSENT_TYPES.map((consentType) => refreshedMap.get(consentType)!).filter(Boolean);

    // Sort by type for consistent ordering
    consents.sort((a, b) => a.consentType.localeCompare(b.consentType));

    // Enrich with policy info + re-consent flag
    const enriched = consents.map((c) => {
      const published = policyByType.get(c.consentType);
      return {
        ...c,
        policy: published
          ? { id: published.id, title: published.title, version: published.version, content: published.content }
          : null,
        // Mirrors hasActiveConsent: a grant is only current when bound to the
        // SAME published policy id AND version — a different id (re-published)
        // or a version bump both require re-consent.
        requiresReconsent:
          c.status === 'granted' &&
          !!published &&
          (c.policyId !== published.id || c.consentVersion !== published.version),
      };
    });

    // Summary counts
    const grantedCount = enriched.filter((c) => c.status === 'granted').length;
    const pendingCount = enriched.filter((c) => c.status === 'pending').length;
    const revokedCount = enriched.filter((c) => c.status === 'revoked').length;
    const deniedCount = enriched.filter((c) => c.status === 'denied').length;

    return NextResponse.json({
      data: enriched,
      total: enriched.length,
      summary: {
        total: enriched.length,
        granted: grantedCount,
        pending: pendingCount,
        denied: deniedCount,
        revoked: revokedCount,
      },
    });
  } catch (error) {
    console.error('Self Consents GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch consents' }, { status: 500 });
  }
}
