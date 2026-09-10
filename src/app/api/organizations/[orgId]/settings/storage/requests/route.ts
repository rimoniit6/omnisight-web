import { NextRequest } from 'next/server';
import { requireOrgAdmin, apiSuccess, apiError } from '@/lib/api';
import { listOrgChangeRequests, serializeChangeRequest } from '@/lib/infrastructure';

// GET /api/organizations/[orgId]/settings/storage/requests
// Full change-request history for the org's storage (newest first).
// Org Admin / Owner only. Service-role key masked (last-4 only).
export async function GET(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const auth = await requireOrgAdmin(req, orgId);
  if (!auth.ok) return apiError('Insufficient permissions', auth.status);

  const requests = await listOrgChangeRequests(orgId, 'STORAGE');
  return apiSuccess({ requests: requests.map(serializeChangeRequest) });
}