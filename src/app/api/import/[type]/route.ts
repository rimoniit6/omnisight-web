import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { db } from '@/lib/db';
import { getRequestToken, hasRolePermission } from '@/lib/auth';
import { verifySessionToken } from '@/lib/session';
import { getSessionOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ImportResult {
  success: boolean;
  imported: number;
  errors: number;
  details: {
    rows: number;
    skipped: number;
    messages: Array<{ row: number; error: string }>;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeResult(imported: number, skipped: number, messages: Array<{ row: number; error: string }>, total: number): ImportResult {
  return {
    success: true,
    imported,
    errors: messages.length,
    details: {
      rows: total,
      skipped,
      messages,
    },
  };
}

/** Try to parse a date string in multiple common formats */
function parseDate(value: string): Date | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Try YYYY-MM-DD
  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const d = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    if (!isNaN(d.getTime())) return d;
  }

  // Try MM/DD/YYYY
  const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const d = new Date(Number(usMatch[3]), Number(usMatch[1]) - 1, Number(usMatch[2]));
    if (!isNaN(d.getTime())) return d;
  }

  // Try DD/MM/YYYY
  const euMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (euMatch) {
    const d = new Date(Number(euMatch[3]), Number(euMatch[2]) - 1, Number(euMatch[1]));
    if (!isNaN(d.getTime())) return d;
  }

  // Fallback: let JS parse
  const fallback = new Date(trimmed);
  if (!isNaN(fallback.getTime())) return fallback;

  return null;
}

// ─── Employee Import ────────────────────────────────────────────────────────

const EMPLOYEE_REQUIRED = ['firstName', 'lastName', 'email'];

async function importEmployees(rows: Record<string, string>[], orgId: string): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const messages: Array<{ row: number; error: string }> = [];

  // Get current employee count for auto-generating employeeId
  const employeeCount = await db.employee.count({ where: { organizationId: orgId } });
  let autoIdCounter = employeeCount + 1;

  // Cache existing emails for fast duplicate check
  const existingEmployees = await db.employee.findMany({
    where: { organizationId: orgId },
    select: { email: true },
  });
  const existingEmails = new Set(existingEmployees.map((e) => e.email.toLowerCase()));

  // Cache departments (case-insensitive lookup)
  const allDepts = await db.department.findMany({
    where: { organizationId: orgId },
    select: { id: true, name: true },
  });
  const deptMap = new Map<string, string>();
  allDepts.forEach((d) => deptMap.set(d.name.toLowerCase(), d.id));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // +1 for 1-indexed, +1 for header

    // Validate required fields
    const missing = EMPLOYEE_REQUIRED.filter((col) => !row[col]?.trim());
    if (missing.length > 0) {
      messages.push({ row: rowNum, error: `Missing required fields: ${missing.join(', ')}` });
      skipped++;
      continue;
    }

    const firstName = (row['firstName'] || '').trim();
    const lastName = (row['lastName'] || '').trim();
    const email = (row['email'] || '').trim();

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      messages.push({ row: rowNum, error: `Invalid email format: ${email}` });
      skipped++;
      continue;
    }

    // Check duplicate email
    if (existingEmails.has(email.toLowerCase())) {
      messages.push({ row: rowNum, error: `Duplicate email: ${email}` });
      skipped++;
      continue;
    }

    try {
      // Resolve department
      let departmentId: string | null = null;
      const deptName = (row['department'] || '').trim();
      if (deptName) {
        const cachedId = deptMap.get(deptName.toLowerCase());
        if (cachedId) {
          departmentId = cachedId;
        } else {
          // Create new department
          const newDept = await db.department.create({
            data: { name: deptName, organizationId: orgId },
          });
          departmentId = newDept.id;
          deptMap.set(deptName.toLowerCase(), newDept.id);
        }
      }

      // Generate or use provided employeeId
      const employeeId = (row['employeeId'] || '').trim() || `EMP-${autoIdCounter++}`;

      await db.employee.create({
        data: {
          firstName,
          lastName,
          email: email.toLowerCase(),
          phone: (row['phone'] || '').trim() || null,
          designation: (row['designation'] || '').trim() || null,
          departmentId,
          employeeId,
          organizationId: orgId,
          status: 'active',
        },
      });

      existingEmails.add(email.toLowerCase());
      imported++;
    } catch (err: unknown) {
      const msg = err instanceof Error && err.message.includes('Unique')
        ? 'Duplicate employeeId or email'
        : 'Database error creating employee';
      messages.push({ row: rowNum, error: msg });
      skipped++;
    }
  }

  return makeResult(imported, skipped, messages, rows.length);
}

// ─── Project Import ─────────────────────────────────────────────────────────

const PROJECT_REQUIRED = ['name'];

async function importProjects(rows: Record<string, string>[], orgId: string): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const messages: Array<{ row: number; error: string }> = [];

  const validPriorities = ['low', 'medium', 'high', 'critical'];
  const validBudgetTypes = ['fixed', 'hourly', 'retainer'];

  // Reject duplicates against existing org projects AND within this batch
  // (case-insensitive) — same rule as the create/update APIs.
  const existingProjects = await db.project.findMany({
    where: { organizationId: orgId },
    select: { name: true },
  });
  const seenNames = new Set(existingProjects.map((p) => p.name.toLowerCase()));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    // Validate required fields
    const missing = PROJECT_REQUIRED.filter((col) => !row[col]?.trim());
    if (missing.length > 0) {
      messages.push({ row: rowNum, error: `Missing required fields: ${missing.join(', ')}` });
      skipped++;
      continue;
    }

    const name = (row['name'] || '').trim();
    const priority = (row['priority'] || '').trim().toLowerCase();
    const budgetType = (row['budgetType'] || '').trim().toLowerCase();

    // Skip duplicate names within the org (case-insensitive).
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) {
      messages.push({ row: rowNum, error: `Duplicate project name: ${name}` });
      skipped++;
      continue;
    }
    seenNames.add(nameKey);

    try {
      await db.project.create({
        data: {
          name,
          description: (row['description'] || '').trim() || null,
          priority: validPriorities.includes(priority) ? priority : 'medium',
          status: 'active',
          deadline: parseDate(row['deadline'] || ''),
          estimatedHours: parseFloat(row['estimatedHours'] || '0') || 0,
          budgetType: validBudgetTypes.includes(budgetType) ? budgetType : null,
          organizationId: orgId,
        },
      });

      imported++;
    } catch (err: unknown) {
      const msg = err instanceof Error && err.message.includes('Unique')
        ? 'Duplicate project name'
        : 'Database error creating project';
      messages.push({ row: rowNum, error: msg });
      skipped++;
    }
  }

  return makeResult(imported, skipped, messages, rows.length);
}

// ─── Time Entry Import ──────────────────────────────────────────────────────

const TIME_ENTRY_REQUIRED = ['employeeEmail', 'projectName', 'date', 'hours'];

async function importTimeEntries(rows: Record<string, string>[], orgId: string): Promise<ImportResult> {
  let imported = 0;
  let skipped = 0;
  const messages: Array<{ row: number; error: string }> = [];

  // Pre-load employees and projects for lookup
  const employees = await db.employee.findMany({
    where: { organizationId: orgId },
    select: { id: true, email: true },
  });
  const employeeMap = new Map<string, string>();
  employees.forEach((e) => employeeMap.set(e.email.toLowerCase(), e.id));

  const projects = await db.project.findMany({
    where: { organizationId: orgId },
    select: { id: true, name: true },
  });
  const projectMap = new Map<string, string>();
  projects.forEach((p) => projectMap.set(p.name.toLowerCase(), p.id));

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;

    // Validate required fields
    const missing = TIME_ENTRY_REQUIRED.filter((col) => !row[col]?.trim());
    if (missing.length > 0) {
      messages.push({ row: rowNum, error: `Missing required fields: ${missing.join(', ')}` });
      skipped++;
      continue;
    }

    const employeeEmail = (row['employeeEmail'] || '').trim().toLowerCase();
    const projectName = (row['projectName'] || '').trim();
    const dateStr = (row['date'] || '').trim();
    const hoursStr = (row['hours'] || '').trim();

    // Lookup employee
    const employeeId = employeeMap.get(employeeEmail);
    if (!employeeId) {
      messages.push({ row: rowNum, error: `Employee not found: ${employeeEmail}` });
      skipped++;
      continue;
    }

    // Lookup project
    const projectId = projectMap.get(projectName.toLowerCase());
    if (!projectId) {
      messages.push({ row: rowNum, error: `Project not found: ${projectName}` });
      skipped++;
      continue;
    }

    // Parse date
    const date = parseDate(dateStr);
    if (!date) {
      messages.push({ row: rowNum, error: `Invalid date format: ${dateStr}` });
      skipped++;
      continue;
    }

    // Parse hours
    const hours = parseFloat(hoursStr);
    if (isNaN(hours) || hours <= 0) {
      messages.push({ row: rowNum, error: `Invalid hours value: ${hoursStr}` });
      skipped++;
      continue;
    }

    // Parse billable
    const billableRaw = (row['billable'] || '').trim().toLowerCase();
    const billable = billableRaw === 'false' || billableRaw === 'no' || billableRaw === '0' ? false : true;

    try {
      await db.timeEntry.create({
        data: {
          projectId,
          employeeId,
          date,
          hours,
          description: (row['description'] || '').trim() || null,
          category: (row['category'] || '').trim() || null,
          billable,
          organizationId: orgId,
        },
      });

      imported++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Database error creating time entry';
      messages.push({ row: rowNum, error: msg });
      skipped++;
    }
  }

  return makeResult(imported, skipped, messages, rows.length);
}

// ─── Route Handler ──────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ type: string }> }
) {
  try {
    // 1. Auth check
    const token = getRequestToken(req);
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const payload = await verifySessionToken(token);
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
    }

    // M-9: Handler-level role authorization — never rely solely on proxy.
    if (!hasRolePermission(payload.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    if (!payload.organizationId) {
      return NextResponse.json({ error: 'Organization scope required' }, { status: 403 });
    }

    // 2. Parse type param
    const { type } = await params;
    const validTypes = ['employees', 'projects', 'time-entries'];
    if (!validTypes.includes(type)) {
      return NextResponse.json(
        { error: `Invalid import type. Must be one of: ${validTypes.join(', ')}` },
        { status: 400 }
      );
    }

    // 3. Parse file from multipart/form-data
    const formData = await req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // 4. Read and parse file with xlsx
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return NextResponse.json({ error: 'No sheets found in the file' }, { status: 400 });
    }
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet);

    if (rows.length === 0) {
      return NextResponse.json(
        { success: true, imported: 0, errors: 0, details: { rows: 0, skipped: 0, messages: [] } }
      );
    }

    // 5. Validate required columns exist
    const columns = Object.keys(rows[0]);
    let requiredCols: string[] = [];

    switch (type) {
      case 'employees':
        requiredCols = EMPLOYEE_REQUIRED;
        break;
      case 'projects':
        requiredCols = PROJECT_REQUIRED;
        break;
      case 'time-entries':
        requiredCols = TIME_ENTRY_REQUIRED;
        break;
    }

    const missingCols = requiredCols.filter((col) => !columns.includes(col));
    if (missingCols.length > 0) {
      return NextResponse.json(
        { error: `Missing required columns: ${missingCols.join(', ')}. Required: ${requiredCols.join(', ')}` },
        { status: 400 }
      );
    }

    // 6. Get organization
    const org = await getSessionOrg(req);
    if (!org) {
      return NextResponse.json({ error: 'No organization found' }, { status: 400 });
    }

    // 7. Perform import based on type
    let result: ImportResult;

    switch (type) {
      case 'employees':
        result = await importEmployees(rows, org.id);
        break;
      case 'projects':
        result = await importProjects(rows, org.id);
        break;
      case 'time-entries':
        result = await importTimeEntries(rows, org.id);
        break;
      default:
        return NextResponse.json({ error: 'Invalid import type' }, { status: 400 });
    }

    // 8. Audit log
    await db.auditLog.create({
      data: {
        action: 'import',
        resource: type,
        description: `Imported ${result.imported} ${type} (${result.errors} errors, ${result.details.skipped} skipped)`,
        userId: payload.userId,
        organizationId: org.id,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    log.error('api.import.param.', { error: String('Import error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to import file' }, { status: 500 });
  }
}
