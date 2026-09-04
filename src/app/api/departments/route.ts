'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: list only the caller's organization. Org-less
    // sessions get EMPTY — never a global cross-customer dump (Phase 2).
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) return NextResponse.json({ data: [] });

    const where: Record<string, unknown> = {};
    if (scope.organizationId) where.organizationId = scope.organizationId;

    const departments = await db.department.findMany({
      where,
      include: {
        _count: { select: { employees: true } },
        manager: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { name: 'asc' },
    });
    return NextResponse.json({ data: departments });
  } catch (error) {
    log.error('api.departments.', { error: String('Departments GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch departments' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    // Admin-only mutation; org from session.
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const body = await req.json();
    const { name, description, managerId } = body;
    if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 });

    // Cross-org validation: managerId must belong to the caller's org.
    if (managerId) {
      const manager = await db.employee.findFirst({
        where: { id: managerId, organizationId: admin.organizationId },
        select: { id: true },
      });
      if (!manager) {
        return NextResponse.json({ error: 'Manager not found in your organization' }, { status: 422 });
      }
    }

    const department = await db.department.create({
      data: { name, description, managerId: managerId || null, organizationId: admin.organizationId },
      include: { _count: { select: { employees: true } } },
    });
    return NextResponse.json({ data: department }, { status: 201 });
  } catch (error) {
    log.error('api.departments.', { error: String('Departments POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to create department' }, { status: 500 });
  }
}
