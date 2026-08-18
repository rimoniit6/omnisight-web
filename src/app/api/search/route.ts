import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';

function emptySearch() {
  return NextResponse.json({ employees: [], departments: [], devices: [] });
}

export async function GET(request: NextRequest) {
  try {
    // Tenant isolation: global search is organization-scoped from the verified
    // session — never from client input. Org-less super_admins (bootstrap)
    // get an EMPTY result set.
    const scope = await requireSessionOrg(request, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) return emptySearch();
    const orgId = scope.organizationId;

    const q = request.nextUrl.searchParams.get('q')?.trim();

    if (!q) {
      return emptySearch();
    }

    // Case-insensitive, database-driven (PostgreSQL ILIKE via mode) — the
    // queries below already return ONLY matching rows, so no client-side
    // re-filter is needed (removed P3-3: the old SQLite-era re-filter was
    // redundant and could drift from the DB predicate).
    const [employees, departments, devices] = await Promise.all([
      db.employee.findMany({
        where: {
          organizationId: orgId,
          status: { not: 'archived' },
          OR: [
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          designation: true,
          department: { select: { name: true } },
        },
        take: 8,
        orderBy: { firstName: 'asc' },
      }),
      db.department.findMany({
        where: {
          organizationId: orgId,
          name: { contains: q, mode: 'insensitive' },
        },
        select: {
          id: true,
          name: true,
          status: true,
          _count: { select: { employees: true } },
        },
        take: 5,
        orderBy: { name: 'asc' },
      }),
      db.device.findMany({
        where: {
          organizationId: orgId,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { hostname: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          name: true,
          hostname: true,
          operatingSystem: true,
          status: true,
        },
        take: 8,
        orderBy: { name: 'asc' },
      }),
    ]);

    const mappedEmployees = employees.map((e) => ({
      id: e.id,
      name: `${e.firstName} ${e.lastName}`,
      subtitle: e.email,
      detail: e.designation || e.department?.name || null,
      type: 'employee' as const,
    }));

    const mappedDepartments = departments.map((d) => ({
      id: d.id,
      name: d.name,
      subtitle: `${d._count.employees} employee${d._count.employees !== 1 ? 's' : ''}`,
      detail: null,
      type: 'department' as const,
    }));

    const mappedDevices = devices.map((d) => ({
      id: d.id,
      name: d.name,
      subtitle: d.operatingSystem || d.hostname || d.status,
      detail: null,
      type: 'device' as const,
    }));

    return NextResponse.json({
      employees: mappedEmployees,
      departments: mappedDepartments,
      devices: mappedDevices,
    });
  } catch (error) {
    console.error('Search API error:', error);
    return NextResponse.json(
      { employees: [], departments: [], devices: [], error: 'Search failed' },
      { status: 500 }
    );
  }
}
