'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg } from '@/lib/api';
import { excludeInternalAgentActivities } from '@/lib/agent-process';
import { log, requestContext } from '@/lib/logger';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // S-3: report export requires manager-or-above.
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);

    const { id } = await params;
    const org = { id: scope.organizationId };
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 400 });
    const report = await db.report.findUnique({ where: { id, organizationId: org.id } });
    if (!report) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }

    // WM-06: exports are bounded (EXPORT_ROW_CAP per query). `truncated` is
    // returned so consumers never mistake a capped sample for the full set.
    const EXPORT_ROW_CAP = 1000;
    let exportData: Record<string, unknown>[] = [];
    let truncated = false;
    const startDate = report.periodStart || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = report.periodEnd || new Date();

    switch (report.type) {
      case 'productivity': {
        const activities = excludeInternalAgentActivities(await db.activity.findMany({
          where: {
            employee: { organizationId: org.id },
            timestamp: { gte: startDate, lte: endDate },
          },
          include: {
            employee: { select: { firstName: true, lastName: true, employeeId: true } },
            device: { select: { name: true } },
          },
          orderBy: { timestamp: 'desc' },
          take: EXPORT_ROW_CAP,
        }));
        truncated = activities.length === EXPORT_ROW_CAP;
        exportData = activities.map((a) => ({
          Date: a.timestamp.toISOString().split('T')[0],
          Employee: `${a.employee.firstName} ${a.employee.lastName}`,
          EmployeeID: a.employee.employeeId,
          Type: a.type,
          Application: a.applicationName || '',
          Website: a.url || '',
          Category: a.category || '',
          'Duration (min)': Math.round(a.duration / 60),
          Device: a.device?.name || '',
        }));
        break;
      }
      case 'attendance': {
        const employees = await db.employee.findMany({
          where: { organizationId: org.id },
          include: {
            department: { select: { name: true } },
            activities: {
              where: { timestamp: { gte: startDate, lte: endDate } },
              select: { timestamp: true, applicationName: true },
              orderBy: { timestamp: 'asc' },
            },
          },
        });
        exportData = employees.map((e) => {
          // Internal agent processes are excluded so the monitoring agent never
          // inflates attendance metrics.
          const empActs = excludeInternalAgentActivities(e.activities);
          return {
            EmployeeID: e.employeeId,
            Name: `${e.firstName} ${e.lastName}`,
            Email: e.email,
            Department: e.department?.name || '',
            Status: e.status,
            FirstActivity: empActs[0]?.timestamp.toISOString() || '',
            LastActivity: empActs[empActs.length - 1]?.timestamp.toISOString() || '',
            ActivityDays: new Set(empActs.map((a) => a.timestamp.toISOString().split('T')[0])).size,
          };
        });
        break;
      }
      case 'activity': {
        const activities = excludeInternalAgentActivities(await db.activity.findMany({
          where: {
            employee: { organizationId: org.id },
            timestamp: { gte: startDate, lte: endDate },
          },
          include: {
            employee: { select: { firstName: true, lastName: true } },
          },
          orderBy: { timestamp: 'desc' },
          take: EXPORT_ROW_CAP,
        }));
        truncated = activities.length === EXPORT_ROW_CAP;
        exportData = activities.map((a) => ({
          Timestamp: a.timestamp.toISOString(),
          Employee: `${a.employee.firstName} ${a.employee.lastName}`,
          Type: a.type,
          Title: a.title || '',
          Application: a.applicationName || '',
          URL: a.url || '',
          Category: a.category || '',
          'Duration (sec)': a.duration,
        }));
        break;
      }
      case 'device': {
        const devices = await db.device.findMany({
          where: { organizationId: org.id },
          include: {
            employee: { select: { firstName: true, lastName: true, employeeId: true } },
          },
          orderBy: { updatedAt: 'desc' },
        });
        exportData = devices.map((d) => ({
          Name: d.name,
          Hostname: d.hostname || '',
          OS: d.operatingSystem || '',
          Status: d.status,
          AssignedTo: d.employee ? `${d.employee.firstName} ${d.employee.lastName}` : 'Unassigned',
          EmployeeID: d.employee?.employeeId || '',
          IPAddress: d.ipAddress || '',
          LastHeartbeat: d.lastHeartbeat?.toISOString() || '',
          RegisteredAt: d.registeredAt.toISOString(),
        }));
        break;
      }
      default: {
        exportData = [{ Report: report.title, Type: report.type, Status: report.status, CreatedAt: report.createdAt.toISOString() }];
      }
    }

    return NextResponse.json({ data: exportData, reportTitle: report.title, truncated });
  } catch (error) {
    log.error('api.reports.id.export.', { error: String('Report export GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to export report' }, { status: 500 });
  }
}
