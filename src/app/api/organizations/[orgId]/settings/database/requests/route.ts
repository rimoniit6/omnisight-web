import { NextRequest } from 'next/server';
import { requireOrgAdmin, apiSuccess, apiError } from '@/lib/api';
import { listOrgChangeRequests, serializeChangeRequest } from '@/lib/infrastructure';

// GET /api/organizations/[orgId]/settings/database/requests
// Full change-request history for the org's analytics DB (newest first).
// Org Admin / Owner only. Secrets never appear (masked last-4 only).
export async function GET(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const auth = await requireOrgAdmin(req, orgId);
  if (!auth.ok) return apiError('Insufficient permissions', auth.status);

  const requests = await listOrgChangeRequests(orgId, 'DATABASE');
  return apiSuccess({ requests: requests.map(serializeChangeRequest) });
}