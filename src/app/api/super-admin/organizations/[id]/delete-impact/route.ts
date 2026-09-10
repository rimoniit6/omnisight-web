import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError, apiSuccess, authError } from '@/lib/api';
import { getOrganizationDeleteImpact } from '@/lib/delete-impact';

// GET /api/super-admin/organizations/[id]/delete-impact
// Read-only delete preview for a full tenant deletion. Super Admin only.
// Every count is computed against the live database at request time — the
// preview endpoint and the DELETE endpoint never disagree.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireSuperAdmin(req);
  if (!admin.ok) return authError(admin);

  const { id } = await params;

  const organization = await db.organization.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true },
  });
  if (!organization) return apiError('Organization not found', 404);

  const impact = await getOrganizationDeleteImpact(id);
  return apiSuccess({ organization, impact });
}