'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';

export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const orgWhere: Record<string, unknown> = scope.organizationId ? { organizationId: scope.organizationId } : {};
    // Org-bound employee ids — used to scope the cross-tenant activity groupBy.
    const orgEmployeeIds = scope.organizationId
      ? (await db.employee.findMany({ where: { organizationId: scope.organizationId }, select: { id: true } })).map((e) => e.id)
      : null;

    const [byDepartment, byDesignation, byStatus, allEmployees, newHiresThisMonth] = await Promise.all([
      // By department
      db.employee.groupBy({
        by: ['departmentId'],
        where: { status: { not: 'archived' }, ...orgWhere },
        _count: { id: true },
      }),
      // By designation
      db.employee.groupBy({
        by: ['designation'],
        where: { status: { not: 'archived' }, ...orgWhere },
        _count: { id: true },
      }),
      // By status
      db.employee.groupBy({
        by: ['status'],
        where: orgWhere,
        _count: { id: true },
      }),
      // All employees for tenure calculation
      db.employee.findMany({
        where: { status: { not: 'archived' }, joinDate: { not: null }, ...orgWhere },
        select: { id: true, joinDate: true },
      }),
      // New hires this month
      db.employee.count({
        where: {
          status: { not: 'archived' },
          joinDate: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
          },
          ...orgWhere,
        },
      }),
    ]);

    // Resolve department names
    const deptMap = new Map<string, string>();
    const deptIds = byDepartment.map((d) => d.departmentId).filter(Boolean) as string[];
    if (deptIds.length > 0) {
      const depts = await db.department.findMany({
        where: { id: { in: deptIds } },
        select: { id: true, name: true },
      });
      for (const d of depts) deptMap.set(d.id, d.name);
    }

    // Active count per department
    const activeByDept = await db.employee.groupBy({
      by: ['departmentId'],
      where: { status: 'active', ...orgWhere },
      _count: { id: true },
    });
    const activeDeptMap = new Map<string, number>();
    for (const a of activeByDept) {
      if (a.departmentId) activeDeptMap.set(a.departmentId, a._count.id);
    }

    const departmentStats = byDepartment
      .map((d) => ({
        name: d.departmentId ? (deptMap.get(d.departmentId) || 'Unknown') : 'Unassigned',
        count: d._count.id,
        activeCount: d.departmentId ? (activeDeptMap.get(d.departmentId) || 0) : 0,
      }))
      .sort((a, b) => b.count - a.count);

    const designationStats = byDesignation
      .map((d) => ({
        designation: d.designation || 'Unspecified',
        count: d._count.id,
      }))
      .sort((a, b) => b.count - a.count);

    const statusStats = byStatus.map((s) => ({
      status: s.status,
      count: s._count.id,
    }));

    // Average tenure in months
    let avgTenure = 0;
    if (allEmployees.length > 0) {
      const now = Date.now();
      const totalMonths = allEmployees.reduce((sum, emp) => {
        const joinDate = new Date(emp.joinDate!).getTime();
        const months = (now - joinDate) / (1000 * 60 * 60 * 24 * 30.44);
        return sum + months;
      }, 0);
      avgTenure = Math.round(totalMonths / allEmployees.length);
    }

    // Top performers: employees with highest productive activity hours
    const productiveActivities = await db.activity.groupBy({
      by: ['employeeId'],
      where: { category: 'productive', ...(orgEmployeeIds ? { employeeId: { in: orgEmployeeIds } } : {}) },
      _sum: { duration: true },
      orderBy: { _sum: { duration: 'desc' } },
      take: 5,
    });

    const topEmployeeIds = productiveActivities.map((a) => a.employeeId);
    let topPerformers: Array<{ id: string; firstName: string; lastName: string; designation: string | null; productivityScore: number }> = [];

    if (topEmployeeIds.length > 0) {
      const topEmployees = await db.employee.findMany({
        where: { id: { in: topEmployeeIds }, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
        select: { id: true, firstName: true, lastName: true, designation: true },
      });
      const empMap = new Map(topEmployees.map((e) => [e.id, e]));
      const maxDuration = productiveActivities[0]?._sum.duration || 1;
      topPerformers = productiveActivities.map((a) => {
        const emp = empMap.get(a.employeeId);
        const score = Math.round(((a._sum.duration || 0) / maxDuration) * 100);
        return {
          id: a.employeeId,
          firstName: emp?.firstName || '',
          lastName: emp?.lastName || '',
          designation: emp?.designation ?? null,
          productivityScore: score,
        };
      });
    }

    return NextResponse.json({
      byDepartment: departmentStats,
      byDesignation: designationStats,
      byStatus: statusStats,
      newHiresThisMonth,
      avgTenure,
      topPerformers,
    });
  } catch (error) {
    console.error('Employee statistics error:', error);
    return NextResponse.json({ error: 'Failed to fetch employee statistics' }, { status: 500 });
  }
}
