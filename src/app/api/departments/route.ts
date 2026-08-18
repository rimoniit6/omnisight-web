'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';

export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: list only the caller's organization.
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

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
    console.error('Departments GET error:', error);
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
    console.error('Departments POST error:', error);
    return NextResponse.json({ error: 'Failed to create department' }, { status: 500 });
  }
}
