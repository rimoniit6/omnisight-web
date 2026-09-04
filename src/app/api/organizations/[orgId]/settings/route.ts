import { NextRequest } from 'next/server';
import { requireOrgAdmin, apiSuccess } from '@/lib/api';
import { getOrgSettings, serializeOrgSettings } from '@/lib/org-settings';

// GET /api/organizations/[orgId]/settings
// Returns the org's customization settings (AI provider + analytics DB config)
// with secrets MASKED — the plaintext API key / DB password are never returned.
// Org Admin / Owner only.
export async function GET(req: NextRequest, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;

  const auth = await requireOrgAdmin(req, orgId);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: 'Insufficient permissions' }), {
      status: auth.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const settings = await getOrgSettings(orgId);
  return apiSuccess(serializeOrgSettings(settings));
}
