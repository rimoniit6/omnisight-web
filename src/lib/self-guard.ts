import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { verifyJWT, getRequestToken } from '@/lib/auth';

// Guard helper for /api/self/* routes.
// The JWT (validated by middleware) supplies role + organization; the
// requested employee must belong to the caller's organization, so no
// authenticated user can read another tenant's data by guessing ids/codes.
//
// The employee may be identified by EITHER the internal DB id (what the
// self-portal UI passes from employee selectors) OR the human-readable
// employee code (e.g. "EMP-001") — both resolve to the same tenant-scoped
// row. Unknown ids/codes (and any id/code from another organization) return
// null/404.

export async function getScopedEmployee(
  req: NextRequest,
  employeeRef: string
): Promise<{ employee: { id: string; organizationId: string } | null; error: string | null }> {
  const token = getRequestToken(req);
  const payload = token ? await verifyJWT(token) : null;
  if (!payload) {
    return { employee: null, error: 'Invalid or expired token' };
  }

  if (!payload.organizationId) {
    // Super admins without an org can access any employee (global scope)
    if (payload.role === 'super_admin') {
      const employee = await db.employee.findFirst({
        where: { OR: [{ id: employeeRef }, { employeeId: employeeRef }] },
        select: { id: true, organizationId: true },
      });
      return { employee, error: null };
    }
    return { employee: null, error: 'No organization scope' };
  }

  const employee = await db.employee.findFirst({
    where: {
      OR: [{ id: employeeRef }, { employeeId: employeeRef }],
      organizationId: payload.organizationId,
    },
    select: { id: true, organizationId: true },
  });
  if (!employee) {
    return { employee: null, error: 'Employee not found in your organization' };
  }
  return { employee, error: null };
}
