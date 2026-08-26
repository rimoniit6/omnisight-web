'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg } from '@/lib/api';
import { excludeInternalAgentActivities } from '@/lib/agent-process';
import { effectiveLiveStatus } from '@/lib/presence';
import { log, requestContext } from '@/lib/logger';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // S-3: report PDF generation requires manager-or-above.
    const scope = await requireManagerOrg(req);
    if (!scope.ok) return authError(scope);

    const { id } = await params;
    const org = { id: scope.organizationId };
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 400 });
    const report = await db.report.findUnique({ where: { id, organizationId: org.id } });
    if (!report) {
      return NextResponse.json({ error: 'Report not found' }, { status: 404 });
    }

    const startDate = report.periodStart || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = report.periodEnd || new Date();

    // Gather summary statistics based on report type
    // WM-06: PDF preview is bounded (PDF_ROW_CAP). `truncated` is returned so
    // the UI can tell a capped sample from the full dataset.
    const PDF_ROW_CAP = 500;
    let summaryStats: Record<string, string | number> = {};
    let tableRows: string[] = [];
    let tableHeaders: string[] = [];
    let truncated = false;

    switch (report.type) {
      case 'productivity': {
        const activities = excludeInternalAgentActivities(await db.activity.findMany({
          where: { employee: { organizationId: org.id }, timestamp: { gte: startDate, lte: endDate } },
          include: {
            employee: { select: { firstName: true, lastName: true, employeeId: true } },
            device: { select: { name: true } },
          },
          orderBy: { timestamp: 'desc' },
          take: PDF_ROW_CAP,
        }));
        truncated = activities.length === PDF_ROW_CAP;

        const productive = activities.filter((a) => a.category === 'productive').reduce((s, a) => s + a.duration, 0);
        const unproductive = activities.filter((a) => a.category === 'unproductive').reduce((s, a) => s + a.duration, 0);
        const totalDuration = activities.reduce((s, a) => s + a.duration, 0);

        summaryStats = {
          'Total Records': activities.length,
          'Total Hours': (totalDuration / 3600).toFixed(1),
          'Productive Hours': (productive / 3600).toFixed(1),
          'Unproductive Hours': (unproductive / 3600).toFixed(1),
          'Productivity Score': totalDuration > 0 ? `${Math.round((productive / totalDuration) * 100)}%` : 'N/A',
        };

        tableHeaders = ['Date', 'Employee', 'Employee ID', 'Type', 'Application', 'Category', 'Duration (min)', 'Device'];
        tableRows = activities.slice(0, 100).map((a) => [
          a.timestamp.toISOString().split('T')[0],
          `${a.employee.firstName} ${a.employee.lastName}`,
          a.employee.employeeId,
          a.type,
          a.applicationName || '-',
          a.category || '-',
          String(Math.round(a.duration / 60)),
          a.device?.name || '-',
        ].map((v) => `<td>${v}</td>`).join(''));
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

        const activeEmps = employees.filter((e) => e.status === 'active').length;
        // Internal agent processes are excluded so the monitoring agent never
        // inflates attendance metrics.
        const empsWithActivity = employees.filter((e) => excludeInternalAgentActivities(e.activities).length > 0).length;

        summaryStats = {
          'Total Employees': employees.length,
          'Active Employees': activeEmps,
          'Employees with Activity': empsWithActivity,
          'Attendance Rate': employees.length > 0 ? `${Math.round((empsWithActivity / employees.length) * 100)}%` : 'N/A',
        };

        tableHeaders = ['Employee ID', 'Name', 'Email', 'Department', 'Status', 'Activity Days', 'First Activity', 'Last Activity'];
        tableRows = employees.map((e) => {
          const empActs = excludeInternalAgentActivities(e.activities);
          const activityDays = new Set(empActs.map((a) => a.timestamp.toISOString().split('T')[0])).size;
          return [
            e.employeeId,
            `${e.firstName} ${e.lastName}`,
            e.email,
            e.department?.name || '-',
            e.status,
            String(activityDays),
            empActs[0]?.timestamp.toISOString().split('T')[0] || '-',
            empActs[empActs.length - 1]?.timestamp.toISOString().split('T')[0] || '-',
          ].map((v) => `<td>${v}</td>`).join('');
        });
        break;
      }

      case 'activity': {
        const activities = excludeInternalAgentActivities(await db.activity.findMany({
          where: { employee: { organizationId: org.id }, timestamp: { gte: startDate, lte: endDate } },
          include: { employee: { select: { firstName: true, lastName: true } } },
          orderBy: { timestamp: 'desc' },
          take: PDF_ROW_CAP,
        }));
        truncated = activities.length === PDF_ROW_CAP;

        const appTime: Record<string, number> = {};
        activities.forEach((a) => {
          const key = a.applicationName || a.type;
          appTime[key] = (appTime[key] || 0) + a.duration;
        });

        const topApps = Object.entries(appTime).sort((a, b) => b[1] - a[1]).slice(0, 5);

        summaryStats = {
          'Total Activities': activities.length,
          'Unique Applications': Object.keys(appTime).length,
          'Total Duration (hrs)': (activities.reduce((s, a) => s + a.duration, 0) / 3600).toFixed(1),
          'Top Application': topApps[0]?.[0] || 'N/A',
          'Top App Hours': topApps[0] ? (topApps[0][1] / 3600).toFixed(1) : 'N/A',
        };

        tableHeaders = ['Timestamp', 'Employee', 'Type', 'Application', 'URL', 'Category', 'Duration (sec)'];
        tableRows = activities.slice(0, 100).map((a) => [
          a.timestamp.toISOString(),
          `${a.employee.firstName} ${a.employee.lastName}`,
          a.type,
          a.applicationName || '-',
          a.url ? `<a href="${a.url}" style="color:#0d9488">${a.url.length > 40 ? a.url.substring(0, 40) + '...' : a.url}</a>` : '-',
          a.category || '-',
          String(a.duration),
        ].map((v) => `<td>${v}</td>`).join(''));
        break;
      }

      case 'device': {
        const devices = await db.device.findMany({
          where: { organizationId: org.id },
          include: { employee: { select: { firstName: true, lastName: true, employeeId: true } } },
          orderBy: { updatedAt: 'desc' },
        });

        // Device.status is a sticky lifecycle field — report online/offline
        // counts and per-device status derive from heartbeat freshness.
        const effectiveStatuses = devices.map((d) => effectiveLiveStatus(d.status, d.lastHeartbeat));
        const onlineDevices = effectiveStatuses.filter((s) => s === 'online').length;
        const assignedDevices = devices.filter((d) => d.employeeId).length;

        summaryStats = {
          'Total Devices': devices.length,
          'Online Devices': onlineDevices,
          'Offline Devices': effectiveStatuses.filter((s) => s === 'offline').length,
          'Assigned Devices': assignedDevices,
          'Online Rate': devices.length > 0 ? `${Math.round((onlineDevices / devices.length) * 100)}%` : 'N/A',
        };

        tableHeaders = ['Name', 'Hostname', 'OS', 'Status', 'Assigned To', 'Employee ID', 'IP Address', 'Last Heartbeat'];
        tableRows = devices.map((d, i) => [
          d.name,
          d.hostname || '-',
          d.operatingSystem || '-',
          effectiveStatuses[i],
          d.employee ? `${d.employee.firstName} ${d.employee.lastName}` : 'Unassigned',
          d.employee?.employeeId || '-',
          d.ipAddress || '-',
          d.lastHeartbeat?.toISOString() || '-',
        ].map((v) => `<td>${v}</td>`).join(''));
        break;
      }

      default: {
        summaryStats = { 'Report Type': report.type, 'Status': report.status };
        tableHeaders = ['Field', 'Value'];
        tableRows = [
          `<td>Title</td><td>${report.title}</td>`,
          `<td>Type</td><td>${report.type}</td>`,
          `<td>Status</td><td>${report.status}</td>`,
          `<td>Created</td><td>${report.createdAt.toISOString()}</td>`,
        ];
      }
    }

    const statsHtml = Object.entries(summaryStats).map(([key, val]) =>
      `<div class="stat-item"><div class="stat-label">${key}</div><div class="stat-value">${val}</div></div>`
    ).join('');

    const headersHtml = tableHeaders.map((h) => `<th>${h}</th>`).join('');
    const rowsHtml = tableRows.map((r, idx) =>
      `<tr class="${idx % 2 === 0 ? 'even-row' : 'odd-row'}">${r}</tr>`
    ).join('');

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${report.title} - OmniSight Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1a1a2e; background: #f0fdf4; line-height: 1.6; }
    .container { max-width: 1100px; margin: 0 auto; padding: 32px; }
    .header { background: linear-gradient(135deg, #059669, #0d9488); color: white; padding: 32px; border-radius: 12px; margin-bottom: 24px; }
    .header h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
    .header .subtitle { font-size: 14px; opacity: 0.85; }
    .header .meta { display: flex; gap: 24px; margin-top: 12px; font-size: 12px; opacity: 0.75; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .stat-item { background: white; border: 1px solid #d1fae5; border-radius: 8px; padding: 16px; text-align: center; }
    .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; font-weight: 600; margin-bottom: 4px; }
    .stat-value { font-size: 22px; font-weight: 700; color: #059669; }
    .table-wrapper { background: white; border-radius: 12px; border: 1px solid #d1fae5; overflow: hidden; }
    .table-header-bar { padding: 16px 20px; border-bottom: 1px solid #d1fae5; font-size: 14px; font-weight: 600; color: #059669; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f0fdf4; padding: 10px 16px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; font-weight: 600; text-align: left; border-bottom: 2px solid #d1fae5; }
    td { padding: 10px 16px; font-size: 13px; border-bottom: 1px solid #f3f4f6; }
    .even-row { background: white; }
    .odd-row { background: #fafafa; }
    tr:hover { background: #f0fdf4; }
    .footer { text-align: center; padding: 24px; font-size: 11px; color: #9ca3af; margin-top: 24px; }
    @media print {
      body { background: white; }
      .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .stat-item { border: 1px solid #ccc; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${report.title}</h1>
      <div class="subtitle">OmniSight ${report.type.charAt(0).toUpperCase() + report.type.slice(1)} Report</div>
      <div class="meta">
        <span>Period: ${startDate.toISOString().split('T')[0]} - ${endDate.toISOString().split('T')[0]}</span>
        <span>Generated: ${report.createdAt.toISOString()}</span>
        <span>Format: ${report.format.toUpperCase()}</span>
      </div>
    </div>

    <div class="stats-grid">${statsHtml}</div>

    <div class="table-wrapper">
      <div class="table-header-bar">Report Data (${tableRows.length} records)</div>
      <div style="overflow-x: auto;">
        <table>
          <thead><tr>${headersHtml}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>

    <div class="footer">
      <p>Generated by OmniSight - AI-Powered Workforce Intelligence</p>
      <p style="margin-top: 4px;">This is an auto-generated report. For questions, contact your system administrator.</p>
    </div>
  </div>
</body>
</html>`;

    return NextResponse.json({
      data: {
        id: report.id,
        title: report.title,
        type: report.type,
        status: report.status,
        periodStart: report.periodStart?.toISOString() || null,
        periodEnd: report.periodEnd?.toISOString() || null,
        createdAt: report.createdAt.toISOString(),
        summaryStats,
        totalRows: tableRows.length,
        truncated,
        htmlContent,
      },
    });
  } catch (error) {
    log.error('api.reports.id.pdf.', { error: String('Report PDF GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to generate report preview' }, { status: 500 });
  }
}
