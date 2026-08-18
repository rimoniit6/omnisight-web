'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { id } = await params;
    const dept = await db.department.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      include: {
        employees: { where: { status: 'active' }, select: { id: true, firstName: true, lastName: true, email: true } },
        manager: { select: { id: true, firstName: true, lastName: true } },
        _count: { select: { employees: true } },
      },
    });
    if (!dept) return NextResponse.json({ error: 'Department not found' }, { status: 404 });
    return NextResponse.json({ data: dept });
  } catch (error) {
    console.error('Department GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch department' }, { status: 500 });
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id } = await params;
    const body = await req.json();

    const existing = await db.department.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true },
    });
    if (!existing) return NextResponse.json({ error: 'Department not found' }, { status: 404 });

    // Cross-org validation: managerId must belong to the caller's org.
    if (body.managerId) {
      const manager = await db.employee.findFirst({
        where: { id: body.managerId, organizationId: admin.organizationId },
        select: { id: true },
      });
      if (!manager) {
        return NextResponse.json({ error: 'Manager not found in your organization' }, { status: 422 });
      }
    }

    const dept = await db.department.update({
      where: { id },
      data: { name: body.name, description: body.description, status: body.status, managerId: body.managerId || null },
      include: { _count: { select: { employees: true } } },
    });
    return NextResponse.json({ data: dept });
  } catch (error) {
    console.error('Department PUT error:', error);
    return NextResponse.json({ error: 'Failed to update department' }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const { id } = await params;
    const existing = await db.department.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true },
    });
    if (!existing) return NextResponse.json({ error: 'Department not found' }, { status: 404 });

    await db.employee.updateMany({ where: { departmentId: id }, data: { departmentId: null } });
    await db.department.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Department DELETE error:', error);
    return NextResponse.json({ error: 'Failed to delete department' }, { status: 500 });
  }
}
