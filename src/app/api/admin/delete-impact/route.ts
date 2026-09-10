import { NextRequest } from 'next/server';
import { requireAdminOrg, apiError, apiSuccess, authError, parseJsonBody, BodyParseError } from '@/lib/api';
import {
  getDeviceDeleteImpact,
  getEmployeeDeleteImpact,
  getProjectDeleteImpact,
  getDepartmentDeleteImpact,
  getMembershipDeleteImpact,
  type DeleteEntity,
} from '@/lib/delete-impact';

// POST /api/admin/delete-impact
// Org-scoped read-only preview of what a delete will touch. Returns the
// disposition (soft / direct / blocked) + per-table counts so the UI can
// present a warning before the mutation. No data is modified.
//
// Body:
//   entity: 'device' | 'employee' | 'project' | 'department' | 'membership'
//   id:     entity id (userId for 'membership')
export async function POST(req: NextRequest) {
  const admin = await requireAdminOrg(req);
  if (!admin.ok) return authError(admin);

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch {
    return apiError('Provide a JSON body with entity and id', 400);
  }

  const entity = body.entity as DeleteEntity | undefined;
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!entity || !id) {
    return apiError('entity and id are required', 400);
  }

  switch (entity) {
    case 'device': {
      const impact = await getDeviceDeleteImpact(id, admin.organizationId);
      return apiSuccess({ organizationId: admin.organizationId, impact });
    }
    case 'employee': {
      const impact = await getEmployeeDeleteImpact(id, admin.organizationId);
      return apiSuccess({ organizationId: admin.organizationId, impact });
    }
    case 'project': {
      const impact = await getProjectDeleteImpact(id, admin.organizationId);
      return apiSuccess({ organizationId: admin.organizationId, impact });
    }
    case 'department': {
      const impact = await getDepartmentDeleteImpact(id, admin.organizationId);
      return apiSuccess({ organizationId: admin.organizationId, impact });
    }
    case 'membership': {
      // This route is org-scoped (requireAdminOrg). An org-bound admin is
      // never allowed to remove the last active org administrator; the global
      // Super Admin path (members DELETE handler, super-admin org APIs) is the
      // only override, resolved there against the DB-verified role.
      const impact = await getMembershipDeleteImpact(admin.organizationId, id, false);
      return apiSuccess({ organizationId: admin.organizationId, impact });
    }
    default:
      return apiError(`Unknown entity: ${entity}`, 400);
  }
}
