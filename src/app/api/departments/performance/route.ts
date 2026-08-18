'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';

export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    // Get all active employees with their department (org-scoped)
    const employees = await db.employee.findMany({
      where: { status: 'active', ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
      },
    });

    // Aggregate productive time per employee in SQL (single grouped query
    // instead of loading every productive activity row into memory).
    const productiveAgg = await db.activity.groupBy({
      by: ['employeeId'],
      where: { employeeId: { in: employees.map((e) => e.id) }, category: 'productive' },
      _sum: { duration: true },
    });
    const productiveByEmployee = new Map<string, number>();
    for (const g of productiveAgg) {
      productiveByEmployee.set(g.employeeId, g._sum.duration ?? 0);
    }

    // Group by department
    const deptMap = new Map<string, {
      departmentId: string;
      departmentName: string;
      totalProductiveSeconds: number;
      employeeCount: number;
      topPerformer: { name: string; hours: number } | null;
    }>();

    for (const emp of employees) {
      const deptId = emp.departmentId || 'unassigned';
      const deptName = emp.department?.name || 'Unassigned';

      const productiveSeconds = productiveByEmployee.get(emp.id) ?? 0;
      const productiveHours = productiveSeconds / 3600;

      const existing = deptMap.get(deptId);
      const empName = `${emp.firstName} ${emp.lastName}`;

      if (existing) {
        existing.totalProductiveSeconds += productiveSeconds;
        existing.employeeCount += 1;
        if (productiveHours > (existing.topPerformer?.hours ?? 0)) {
          existing.topPerformer = { name: empName, hours: Math.round(productiveHours * 10) / 10 };
        }
      } else {
        deptMap.set(deptId, {
          departmentId: deptId,
          departmentName: deptName,
          totalProductiveSeconds: productiveSeconds,
          employeeCount: 1,
          topPerformer: productiveHours > 0 ? { name: empName, hours: Math.round(productiveHours * 10) / 10 } : null,
        });
      }
    }

    const performance = Array.from(deptMap.values()).map((d) => ({
      departmentId: d.departmentId,
      departmentName: d.departmentName,
      employeeCount: d.employeeCount,
      avgProductiveHours: d.employeeCount > 0
        ? Math.round((d.totalProductiveSeconds / 3600 / d.employeeCount) * 10) / 10
        : 0,
      totalProductiveHours: Math.round((d.totalProductiveSeconds / 3600) * 10) / 10,
      topPerformer: d.topPerformer,
    }));

    // Sort by avg productive hours descending
    performance.sort((a, b) => b.avgProductiveHours - a.avgProductiveHours);

    return NextResponse.json({ data: performance });
  } catch (error) {
    console.error('Departments performance GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch department performance' }, { status: 500 });
  }
}
