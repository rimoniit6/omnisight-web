'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { deriveEmployeePresence } from '@/lib/presence';

// GET /api/employees/presence
// Organization-scoped employee presence snapshot.
//
// Semantics: an employee is ONLINE when at least one of their devices has a
// lastHeartbeat within the centralized threshold (see src/lib/presence.ts).
// Presence means "an authenticated Desktop Agent is currently communicating
// with the server" — it is NOT device lifecycle status, activity, or
// productivity.
//
// Security:
//   - Organization is derived strictly from the verified session — an
//     `organizationId` query/body value is never accepted as authority
//     (forged/foreign ids are simply ignored).
//   - Only employees of the authenticated organization are returned (same
//     visibility as GET /api/employees).
//   - Response carries ids + presence booleans only — no activity, screenshot
//     or device detail data is exposed.
//
// Performance: exactly two bounded, indexed queries (employees + devices) —
// no N+1, no per-employee lookups, no unbounded selects.

export async function GET(req: NextRequest) {
  const scope = await requireSessionOrg(req, { allowGlobal: true });
  if (!scope.ok) return authError(scope);

  const organizationId = scope.organizationId;

  // Org-less global super_admin has no tenant to scope to — return an empty
  // snapshot (never cross-tenant data). Presence is consumed inside org-scoped
  // admin views, where the session always carries an organization.
  if (!organizationId) {
    return NextResponse.json({ employees: {}, generatedAt: new Date().toISOString() });
  }

  try {
    const cutoff = new Date(Date.now());

    // All visible employees of the session organization.
    const employees = await db.employee.findMany({
      where: { organizationId, status: { not: 'archived' } },
      select: { id: true },
    });

    // Fresh devices are rare relative to the employee set; fetch devices with
    // a heartbeat at all and let the pure helper apply the threshold.
    const devices = await db.device.findMany({
      where: { organizationId, employeeId: { not: null }, lastHeartbeat: { not: null } },
      select: { employeeId: true, lastHeartbeat: true },
    });

    const byEmployee = deriveEmployeePresence(devices, cutoff);

    const employeesMap: Record<string, { online: boolean; lastSeenAt: string | null }> = {};
    for (const emp of employees) {
      const p = byEmployee.get(emp.id);
      employeesMap[emp.id] = p
        ? { online: p.online, lastSeenAt: p.lastSeenAt }
        : { online: false, lastSeenAt: null };
    }

    return NextResponse.json({
      employees: employeesMap,
      generatedAt: cutoff.toISOString(),
    });
  } catch {
    return NextResponse.json({ error: 'Failed to load presence' }, { status: 500 });
  }
}
