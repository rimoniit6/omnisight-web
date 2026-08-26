'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg } from '@/lib/api';
import { sanitizeSpreadsheetCell } from '@/lib/export';
import { excludeInternalAgentActivities, isInternalAgentProcess } from '@/lib/agent-process';
import { log, requestContext } from '@/lib/logger';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // S-3: report CSV export requires manager-or-above.
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);

    const { id } = await params;
    const org = { id: scope.organizationId };
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 400 });
    const report = await db.report.findUnique({ where: { id, organizationId: org.id } });
    if (!report) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }

    // Try to use stored JSON data first. Internal agent process rows are
    // excluded from historical snapshots too (column keys vary by report
    // shape: Application / name / app).
    if (report.data) {
      const parsed = JSON.parse(report.data);
      const rows = flattenReportData(parsed, report.type).filter(
        (r) => !isInternalAgentProcess(String(r['Application'] ?? r['name'] ?? r['app'] ?? ''))
      );
      if (rows.length > 0) {
        const csv = convertToCSV(rows);
        const filename = report.title.replace(/[^a-zA-Z0-9\-_ ]/g, '').replace(/\s+/g, '_').toLowerCase();
        return new NextResponse(csv, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}.csv"`,
          },
        });
      }
    }

    // Fallback: fetch data dynamically based on report type (same logic as export route)
    const startDate = report.periodStart || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = report.periodEnd || new Date();

    let exportData: Record<string, unknown>[] = [];

    switch (report.type) {
      case 'productivity': {
        const activities = excludeInternalAgentActivities(await db.activity.findMany({
          where: { employee: { organizationId: org.id }, timestamp: { gte: startDate, lte: endDate } },
          include: {
            employee: { select: { firstName: true, lastName: true, employeeId: true } },
            device: { select: { name: true } },
          },
          orderBy: { timestamp: 'desc' },
          take: 1000,
        }));
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
          where: { employee: { organizationId: org.id }, timestamp: { gte: startDate, lte: endDate } },
          include: { employee: { select: { firstName: true, lastName: true } } },
          orderBy: { timestamp: 'desc' },
          take: 1000,
        }));
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
          include: { employee: { select: { firstName: true, lastName: true, employeeId: true } } },
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

    if (exportData.length === 0) {
      exportData = [{ Info: 'No data found for this report' }];
    }

    const csv = convertToCSV(exportData);
    const filename = report.title.replace(/[^a-zA-Z0-9\-_ ]/g, '').replace(/\s+/g, '_').toLowerCase();

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}.csv"`,
      },
    });
  } catch (error) {
    log.error('api.reports.id.csv.', { error: String('Report CSV export error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to export report as CSV' }, { status: 500 });
  }
}

function convertToCSV(data: Record<string, unknown>[]): string {
  if (data.length === 0) return '';
  const headers = Object.keys(data[0]);
  const rows = [
    headers.join(','),
    ...data.map(row =>
      headers.map(h => {
        const val = row[h];
        // CWE-1236 guard: neutralize spreadsheet formula prefixes (=, +, -, @)
        // before quoting — a quoted ="..." cell is still evaluated as a formula.
        const str = sanitizeSpreadsheetCell(typeof val === 'object' && val !== null ? JSON.stringify(val) : val ?? '');
        return `"${str.replace(/"/g, '""')}"`;
      }).join(',')
    ),
  ];
  return rows.join('\n');
}

/**
 * Flatten nested report JSON data into tabular rows for CSV export.
 * Handles various report type structures from the generate endpoint.
 */
function flattenReportData(parsed: Record<string, unknown>, _reportType: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];

  // Check for summary data and tabular data
  const summary = (parsed.summary || parsed.departmentName || parsed.employeeName)
    ? {
        ...(parsed.summary as Record<string, unknown> || {}),
        ...(parsed.departmentName ? { departmentName: parsed.departmentName } : {}),
        ...(parsed.manager ? { manager: parsed.manager } : {}),
        ...(parsed.employeeName ? { employeeName: parsed.employeeName } : {}),
        ...(parsed.department ? { department: parsed.department } : {}),
        ...(parsed.employeeCount !== undefined ? { employeeCount: parsed.employeeCount } : {}),
      }
    : null;

  // Extract arrays of rows from known keys
  const tableKeys = ['departmentBreakdown', 'dailyTrend', 'employees', 'devices', 'categoryDistribution', 'topApplications', 'topWebsites'];

  for (const key of tableKeys) {
    const arr = parsed[key];
    if (Array.isArray(arr) && arr.length > 0) {
      // Prepend summary as a header row if present
      if (summary && rows.length === 0) {
        rows.push({ _section: 'Summary', ...summary });
      }
      rows.push({ _section: key } as unknown as Record<string, unknown>);
      rows.push(...arr as Record<string, unknown>[]);
      break;
    }
  }

  // If no tabular data found, flatten the entire object
  if (rows.length === 0) {
    const flatRow: Record<string, unknown> = {};
    flattenObject('', parsed, flatRow);
    rows.push(flatRow);
  }

  return rows;
}

function flattenObject(prefix: string, obj: unknown, result: Record<string, unknown>) {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== 'object') {
    result[prefix] = obj;
    return;
  }
  if (Array.isArray(obj)) {
    result[prefix] = JSON.stringify(obj);
    return;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    flattenObject(newKey, value, result);
  }
}
