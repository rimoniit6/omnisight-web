import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { getRequestToken, verifyJWT, hasRolePermission } from '@/lib/auth';
import { NON_INTERNAL_AGENT_ACTIVITY_FILTER } from '@/lib/agent-process';
import {
  generateExport,
  getExportContentType,
  getExportExtension,
  DEFAULT_EXPORT_WINDOW_DAYS,
  parseExportRange,
  type ExportColumn,
} from '@/lib/export';

// ─── Bounded-export constants (P2-2) ────────────────────────────────────────
// Exports never load the entire Activity/TimeEntry table into memory:
//   - DB pages of EXPORT_PAGE_SIZE rows are fetched with keyset pagination
//     ((timestamp, id) cursor — the same order the export is sorted by), so
//     only one page is materialized at a time;
//   - the final dataset is capped at MAX_EXPORT_ROWS (deep scans are the
//     point of this fix — a silent truncation log guards the cap);
//   - when no date range is given, activity/time-entry exports default to the
//     last DEFAULT_EXPORT_WINDOW_DAYS days (matches the analytics 90-day cap;
//     the UI already always sends an explicit 30-day range).
const EXPORT_PAGE_SIZE = 2000;
const MAX_EXPORT_ROWS = 100_000;

/**
 * Collect matching rows page-by-page in (timestamp desc, id desc) order with
 * a hard row cap. `first`/`next` return raw pages; `keep` applies the fuzzy
 * in-memory filters (search) so results are byte-identical to the previous
 * single `findMany` + JS filter approach — only the memory profile changes.
 */
export async function pagedCollect<T extends { id: string }>(
  first: () => Promise<T[]>,
  next: (last: T) => Promise<T[]>,
  keep: (row: T) => boolean,
  label: string,
  opts: { cap?: number; pageSize?: number } = {}
): Promise<T[]> {
  const cap = opts.cap ?? MAX_EXPORT_ROWS;
  const pageSize = opts.pageSize ?? EXPORT_PAGE_SIZE;
  const out: T[] = [];
  let page = await first();
  while (page.length > 0 && out.length < cap) {
    for (const row of page) {
      if (out.length >= cap) break;
      if (keep(row)) out.push(row);
    }
    if (page.length < pageSize) break; // last page
    if (out.length >= cap) break; // cap reached — never fetch another page
    page = await next(page[page.length - 1]);
  }
  if (out.length >= cap) {
    console.warn(`[export] ${label}: result capped at ${cap} rows (increase window or narrow filters)`);
  }
  return out;
}



// ─── Available Column Definitions per Export Type ────────────────────────────

const EMPLOYEE_COLUMNS: ExportColumn[] = [
  { key: 'name', label: 'Name', format: 'string', width: 24 },
  { key: 'email', label: 'Email', format: 'string', width: 30 },
  { key: 'employeeId', label: 'Employee ID', format: 'string', width: 14 },
  { key: 'designation', label: 'Designation', format: 'string', width: 20 },
  { key: 'department', label: 'Department', format: 'string', width: 18 },
  { key: 'status', label: 'Status', format: 'string', width: 12 },
  { key: 'phone', label: 'Phone', format: 'string', width: 16 },
  { key: 'joinDate', label: 'Join Date', format: 'date', width: 16 },
  { key: 'avatar', label: 'Avatar', format: 'string', width: 40 },
];

const ACTIVITY_COLUMNS: ExportColumn[] = [
  { key: 'employee', label: 'Employee', format: 'string', width: 24 },
  { key: 'applicationName', label: 'Application', format: 'string', width: 24 },
  { key: 'title', label: 'Title', format: 'string', width: 32 },
  { key: 'category', label: 'Category', format: 'string', width: 16 },
  { key: 'duration', label: 'Duration', format: 'duration', width: 12 },
  { key: 'device', label: 'Device', format: 'string', width: 20 },
  { key: 'timestamp', label: 'Timestamp', format: 'datetime', width: 22 },
];

const TIME_ENTRY_COLUMNS: ExportColumn[] = [
  { key: 'employee', label: 'Employee', format: 'string', width: 24 },
  { key: 'project', label: 'Project', format: 'string', width: 24 },
  { key: 'date', label: 'Date', format: 'date', width: 16 },
  { key: 'hours', label: 'Hours', format: 'number', width: 10 },
  { key: 'description', label: 'Description', format: 'string', width: 36 },
  { key: 'category', label: 'Category', format: 'string', width: 16 },
  { key: 'billable', label: 'Billable', format: 'string', width: 10 },
];

const PROJECT_COLUMNS: ExportColumn[] = [
  { key: 'name', label: 'Name', format: 'string', width: 28 },
  { key: 'status', label: 'Status', format: 'string', width: 14 },
  { key: 'priority', label: 'Priority', format: 'string', width: 12 },
  { key: 'startDate', label: 'Start Date', format: 'date', width: 16 },
  { key: 'deadline', label: 'Deadline', format: 'date', width: 16 },
  { key: 'members', label: 'Members', format: 'string', width: 36 },
  { key: 'totalHours', label: 'Total Hours', format: 'number', width: 14 },
  { key: 'estimatedHours', label: 'Estimated Hours', format: 'number', width: 16 },
  { key: 'budgetType', label: 'Budget Type', format: 'string', width: 14 },
];

const COLUMN_MAP: Record<string, ExportColumn[]> = {
  employees: EMPLOYEE_COLUMNS,
  activities: ACTIVITY_COLUMNS,
  'time-entries': TIME_ENTRY_COLUMNS,
  projects: PROJECT_COLUMNS,
};

// ─── Data Fetching per Export Type ───────────────────────────────────────────

async function fetchEmployees(
  search: string,
  department: string,
  status: string,
  from: string,
  to: string,
  orgId: string | null
): Promise<Record<string, unknown>[]> {
  const orgFilter = orgId ? { organizationId: orgId } : {};
  const employees = await db.employee.findMany({
    where: { status: { not: 'archived' }, ...orgFilter },
    include: {
      department: { select: { name: true } },
    },
  });

  let filtered = employees;

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.firstName.toLowerCase().includes(q) ||
        e.lastName.toLowerCase().includes(q) ||
        e.email.toLowerCase().includes(q) ||
        e.employeeId.toLowerCase().includes(q)
    );
  }

  if (department) {
    const q = department.toLowerCase();
    filtered = filtered.filter(
      (e) => e.department?.name.toLowerCase().includes(q)
    );
  }

  if (status) {
    filtered = filtered.filter((e) => e.status === status);
  }

  if (from) {
    const fromDate = new Date(from);
    filtered = filtered.filter(
      (e) => e.joinDate && e.joinDate >= fromDate
    );
  }

  if (to) {
    const toDate = new Date(to);
    filtered = filtered.filter(
      (e) => e.joinDate && e.joinDate <= toDate
    );
  }

  return filtered.map((e) => ({
    name: `${e.firstName} ${e.lastName}`,
    email: e.email,
    employeeId: e.employeeId,
    designation: e.designation || '',
    department: e.department?.name || '',
    status: e.status,
    phone: e.phone || '',
    joinDate: e.joinDate?.toISOString() || '',
    avatar: e.avatar || '',
  }));
}

type ActivityExportRow = {
  id: string;
  timestamp: Date;
  title: string | null;
  applicationName: string | null;
  category: string | null;
  duration: number;
  employee: { firstName: string; lastName: string };
  device: { name: string } | null;
};

async function fetchActivities(
  search: string,
  employeeId: string,
  category: string,
  from: string,
  to: string,
  orgId: string | null
): Promise<Record<string, unknown>[]> {
  // Activity has no organizationId column — scope through the employee relation.
  // Internal agent processes are excluded at the DATA layer (NULL-safe filter)
  // so the monitoring agent's own process never appears in activity exports.
  let fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;

  // P2-2: no date range → default to the last 90 days instead of the entire
  // Activity table (the UI always sends an explicit range; this guards
  // direct API calls).
  if (!fromDate && !toDate) {
    fromDate = new Date(Date.now() - DEFAULT_EXPORT_WINDOW_DAYS * 86_400_000);
  }

  const baseWhere: Prisma.ActivityWhereInput = {
    ...(orgId ? { employee: { is: { organizationId: orgId } } } : {}),
    ...(employeeId ? { employeeId } : {}),
    ...(category ? { category } : {}),
    ...(fromDate ? { timestamp: { gte: fromDate } } : {}),
    ...(toDate ? { timestamp: { lte: toDate } } : {}),
    ...NON_INTERNAL_AGENT_ACTIVITY_FILTER,
  };

  const include = {
    employee: { select: { id: true, firstName: true, lastName: true } },
    device: { select: { id: true, name: true } },
  };
  const orderBy: Prisma.ActivityOrderByWithRelationInput[] = [{ timestamp: 'desc' }, { id: 'desc' }];

  const q = search.toLowerCase();
  const keep = (a: ActivityExportRow): boolean => {
    if (!q) return true;
    return (
      (a.title?.toLowerCase().includes(q) ?? false) ||
      (a.applicationName?.toLowerCase().includes(q) ?? false) ||
      `${a.employee.firstName} ${a.employee.lastName}`.toLowerCase().includes(q)
    );
  };

  const activities = await pagedCollect<ActivityExportRow>(
    () => db.activity.findMany({ where: baseWhere, include, orderBy, take: EXPORT_PAGE_SIZE }),
    (last) =>
      db.activity.findMany({
        where: {
          ...baseWhere,
          OR: [
            { timestamp: { lt: last.timestamp } },
            { timestamp: last.timestamp, id: { lt: last.id } },
          ],
        },
        include,
        orderBy,
        take: EXPORT_PAGE_SIZE,
      }),
    keep,
    'activities'
  );

  return activities.map((a) => ({
    employee: `${a.employee.firstName} ${a.employee.lastName}`,
    applicationName: a.applicationName || '',
    title: a.title || '',
    category: a.category || '',
    duration: a.duration,
    device: a.device?.name || '',
    timestamp: a.timestamp.toISOString(),
  }));
}

type TimeEntryExportRow = {
  id: string;
  date: Date;
  description: string | null;
  category: string | null;
  hours: number;
  billable: boolean;
  employee: { firstName: string; lastName: string };
  project: { name: string };
};

async function fetchTimeEntries(
  search: string,
  projectId: string,
  employeeId: string,
  from: string,
  to: string,
  orgId: string | null
): Promise<Record<string, unknown>[]> {
  const orgFilter = orgId ? { organizationId: orgId } : {};
  let fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;

  // P2-2: same default window as activities when no range is supplied.
  if (!fromDate && !toDate) {
    fromDate = new Date(Date.now() - DEFAULT_EXPORT_WINDOW_DAYS * 86_400_000);
  }

  const baseWhere: Prisma.TimeEntryWhereInput = {
    ...orgFilter,
    ...(projectId ? { projectId } : {}),
    ...(employeeId ? { employeeId } : {}),
    ...(fromDate ? { date: { gte: fromDate } } : {}),
    ...(toDate ? { date: { lte: toDate } } : {}),
  };

  const include = {
    employee: { select: { id: true, firstName: true, lastName: true } },
    project: { select: { id: true, name: true } },
  };
  const orderBy: Prisma.TimeEntryOrderByWithRelationInput[] = [{ date: 'desc' }, { id: 'desc' }];

  const q = search.toLowerCase();
  const keep = (t: TimeEntryExportRow): boolean => {
    if (!q) return true;
    return (
      (t.description?.toLowerCase().includes(q) ?? false) ||
      (t.category?.toLowerCase().includes(q) ?? false) ||
      t.project.name.toLowerCase().includes(q) ||
      `${t.employee.firstName} ${t.employee.lastName}`.toLowerCase().includes(q)
    );
  };

  const entries = await pagedCollect<TimeEntryExportRow>(
    () => db.timeEntry.findMany({ where: baseWhere, include, orderBy, take: EXPORT_PAGE_SIZE }),
    (last) =>
      db.timeEntry.findMany({
        where: {
          ...baseWhere,
          OR: [
            { date: { lt: last.date } },
            { date: last.date, id: { lt: last.id } },
          ],
        },
        include,
        orderBy,
        take: EXPORT_PAGE_SIZE,
      }),
    keep,
    'time-entries'
  );

  return entries.map((t) => ({
    employee: `${t.employee.firstName} ${t.employee.lastName}`,
    project: t.project.name,
    date: t.date.toISOString(),
    hours: t.hours,
    description: t.description || '',
    category: t.category || '',
    billable: t.billable ? 'Yes' : 'No',
  }));
}

async function fetchProjects(
  search: string,
  status: string,
  _from: string,
  _to: string,
  orgId: string | null
): Promise<Record<string, unknown>[]> {
  const orgFilter = orgId ? { organizationId: orgId } : {};
  const projects = await db.project.findMany({
    where: orgFilter,
    include: {
      members: {
        where: { leftAt: null },
        select: {
          employee: { select: { firstName: true, lastName: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Get total hours per project
  const projectIds = projects.map((p) => p.id);
  const hoursByProject =
    projectIds.length > 0
      ? await db.timeEntry.groupBy({
          by: ['projectId'],
          where: { projectId: { in: projectIds }, ...orgFilter },
          _sum: { hours: true },
        })
      : [];
  const hoursMap = new Map(
    hoursByProject.map((h) => [h.projectId, h._sum.hours || 0])
  );

  let filtered = projects;

  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter((p) => p.name.toLowerCase().includes(q));
  }

  if (status) {
    filtered = filtered.filter((p) => p.status === status);
  }

  return filtered.map((p) => ({
    name: p.name,
    status: p.status,
    priority: p.priority,
    startDate: p.startDate?.toISOString() || '',
    deadline: p.deadline?.toISOString() || '',
    members: p.members
      .map((m) => `${m.employee.firstName} ${m.employee.lastName}`)
      .join(', '),
    totalHours: hoursMap.get(p.id) || 0,
    estimatedHours: p.estimatedHours,
    budgetType: p.budgetType || '',
  }));
}

// ─── Route Handler ───────────────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  let exportType = 'unknown';

  try {
    // 1. Auth check
    const token = getRequestToken(req);
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const payload = await verifyJWT(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    // P3-7: handler-level RBAC — the proxy gates /api/export to manager+, but
    // the handler enforces it too (defense-in-depth, never proxy-only).
    if (!hasRolePermission(payload.role, 'manager')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }

    // 2. Parse type param
    const { type } = await params;
    exportType = type;
    const validTypes = ['employees', 'activities', 'time-entries', 'projects'];
    if (!validTypes.includes(type)) {
      return NextResponse.json(
        { error: `Invalid export type. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    // 3. Parse query params
    const { searchParams } = new URL(req.url);
    const format = (searchParams.get('format') || 'csv') as 'csv' | 'xlsx';
    const columnsParam = searchParams.get('columns') || '';
    const search = searchParams.get('search') || '';
    const from = searchParams.get('from') || '';
    const to = searchParams.get('to') || '';

    // Type-specific filters
    const department = searchParams.get('department') || '';
    const status = searchParams.get('status') || '';
    const employeeId = searchParams.get('employeeId') || '';
    const category = searchParams.get('category') || '';
    const projectId = searchParams.get('projectId') || '';

    // 4. Validate format
    if (format !== 'csv' && format !== 'xlsx') {
      return NextResponse.json(
        { error: 'Invalid format. Must be csv or xlsx.' },
        { status: 400 }
      );
    }

    // 4b. Validate the shared date range at the API boundary (P2-2): malformed
    // or inverted ranges get a 400, never a silent empty/partial export.
    const range = parseExportRange(from, to);
    if (range.error) {
      return NextResponse.json({ error: range.error.message }, { status: range.error.status });
    }

    // 5. Get available columns and filter to requested
    const allColumns = COLUMN_MAP[type];
    const requestedKeys = columnsParam
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    const columns = requestedKeys.length > 0
      ? allColumns.filter((col) => requestedKeys.includes(col.key))
      : allColumns;

    if (columns.length === 0) {
      return NextResponse.json(
        { error: 'No valid columns requested.' },
        { status: 400 }
      );
    }

    // 6. Fetch data based on type
    let data: Record<string, unknown>[] = [];

    switch (type) {
      case 'employees':
        data = await fetchEmployees(search, department, status, from, to, payload.organizationId ?? null);
        break;
      case 'activities':
        data = await fetchActivities(search, employeeId, category, from, to, payload.organizationId ?? null);
        break;
      case 'time-entries':
        data = await fetchTimeEntries(search, projectId, employeeId, from, to, payload.organizationId ?? null);
        break;
      case 'projects':
        data = await fetchProjects(search, status, from, to, payload.organizationId ?? null);
        break;
      default:
        break;
    }

    if (data.length === 0) {
      return NextResponse.json(
        { error: 'No data found matching the given filters.' },
        { status: 404 }
      );
    }

    // 7. Generate export
    const filename = `omnisight-${type}-export`;
    const buffer = generateExport({
      filename,
      format,
      sheetName: type.charAt(0).toUpperCase() + type.slice(1).replace('-', ' '),
      columns,
      data,
    });

    const ext = getExportExtension(format);
    const contentType = getExportContentType(format);

    // 8. Return as downloadable file
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}.${ext}"`,
      },
    });
  } catch (error) {
    console.error(`Export [${exportType}] error:`, error);
    return NextResponse.json(
      { error: 'Failed to generate export.' },
      { status: 500 }
    );
  }
}
