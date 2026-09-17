import { NextRequest } from 'next/server';
import { requireOrgAdmin, apiSuccess, apiError } from '@/lib/api';
import { listOrgChangeRequests, serializeChangeRequest, type ChangeRequestSerialized } from '@/lib/infrastructure';
import { computeRequestConfigFingerprint } from '@/lib/migration/preconditions';
import { deriveConnectionState } from '@/lib/infrastructure-state';

// GET /api/organizations/[orgId]/settings/storage/requests
// Full change-request history for the org's storage (newest first).
// Org Admin / Owner only. Secrets never appear (masked last-4 only).
//
// (Phase 9) Each request carries a SERVER-DERIVED `connectionState` — the same
// state machine the transfer gate enforces (untested / verified / test_expired
// / config_changed / test_failed), computed from the request's persisted
// fingerprint-bound evidence. The UI renders this instead of inventing
// "Connection verified" from the mere existence of an open request.
export async function GET(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const auth = await requireOrgAdmin(req, orgId);
  if (!auth.ok) return apiError('Insufficient permissions', auth.status);

  const requests = await listOrgChangeRequests(orgId, 'STORAGE');
  const withState = await Promise.all(
    requests.map(async (r) => {
      const base = serializeChangeRequest(r) as ChangeRequestSerialized & { connectionState: string };
      base.connectionState = await deriveConnectionState(
        { lastTestStatus: r.lastTestStatus, lastTestedAt: r.lastTestedAt, lastTestConfigFingerprint: r.lastTestConfigFingerprint },
        await computeRequestConfigFingerprint('STORAGE', r.configJson)
      );
      return base;
    })
  );
  return apiSuccess({ requests: withState });
}
