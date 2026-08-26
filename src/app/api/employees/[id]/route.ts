'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { authError, requireSessionOrg, requireAdminOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

const EMPLOYEE_STATUSES = ['active', 'inactive', 'archived'] as const;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

/**
 * Validate a PARTIAL PUT payload for editing an employee.
 *
 * PUT is merge-semantics: only the fields actually present in the body are
 * validated and applied; omitted fields keep their existing values. This is
 * required by real callers — the table's status toggle sends only
 * `{ status }` and the dialog sends the full form — and by the security
 * suite (EMPLOYEE-11/12 send `{ designation }` / `{ departmentId }`).
 * Returns an error message or null.
 */
function validateUpdateBody(body: Record<string, unknown>): string | null {
  if (body.firstName !== undefined) {
    if (!isStr(body.firstName) || !body.firstName.trim()) return 'First name is required';
    if (body.firstName.trim().length > 100) return 'Name fields must be 100 characters or fewer';
  }
  if (body.lastName !== undefined) {
    if (!isStr(body.lastName) || !body.lastName.trim()) return 'Last name is required';
    if (body.lastName.trim().length > 100) return 'Name fields must be 100 characters or fewer';
  }
  if (body.email !== undefined) {
    if (!isStr(body.email) || !EMAIL_RE.test(body.email.trim())) return 'A valid email is required';
  }
  if (body.phone !== undefined && body.phone !== null && !isStr(body.phone)) return 'Phone must be a string';
  if (body.designation !== undefined && body.designation !== null && !isStr(body.designation)) {
    return 'Designation must be a string';
  }
  if (body.status !== undefined && !(EMPLOYEE_STATUSES as readonly string[]).includes(body.status as string)) {
    return `Invalid status. Allowed: ${EMPLOYEE_STATUSES.join(', ')}`;
  }
  if (body.joinDate !== undefined && body.joinDate !== null) {
    if (!isStr(body.joinDate) || !DATE_RE.test(body.joinDate)) {
      return 'Join date must be YYYY-MM-DD';
    }
  }
  if (body.departmentId !== undefined && body.departmentId !== null && !isStr(body.departmentId)) {
    return 'Department must be a string';
  }
  return null;
}

function formatAuditDiff(before: { firstName: string; lastName: string; email: string; designation: string | null; departmentId: string | null; status: string; phone: string | null; joinDate: Date | null }, body: Record<string, unknown>): string {
  const changes: string[] = [];
  const deptChanged = body.departmentId !== undefined
    ? String(body.departmentId || '') !== String(before.departmentId || '')
    : false;
  if (body.firstName !== undefined && body.firstName !== before.firstName) changes.push('first name');
  if (body.lastName !== undefined && body.lastName !== before.lastName) changes.push('last name');
  if (body.email !== undefined && body.email !== before.email) changes.push('email');
  if (body.phone !== undefined && (body.phone || null) !== before.phone) changes.push('phone');
  if (body.designation !== undefined && (body.designation || null) !== before.designation) changes.push('designation');
  if (deptChanged) changes.push('department');
  if (body.status !== undefined && body.status !== before.status) changes.push('status');
  // Compare actual values (normalized to the same YYYY-MM-DD form) so a
  // no-op joinDate never produces a phantom "join date" audit entry.
  if (body.joinDate !== undefined) {
    const incoming = String(body.joinDate || '');
    const existing = before.joinDate ? before.joinDate.toISOString().slice(0, 10) : '';
    if (incoming !== existing) changes.push('join date');
  }
  return changes.length > 0 ? ` (${changes.join(', ')})` : '';
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { id } = await params;
    // Resolve inside the caller's org only; cross-org ids -> 404.
    const employee = await db.employee.findFirst({
      where: { id, ...(scope.organizationId ? { organizationId: scope.organizationId } : {}) },
      include: {
        department: true,
        organization: { select: { id: true, name: true } },
        devices: true,
        activities: { orderBy: { timestamp: 'desc' }, take: 20 },
      },
    });
    if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    // Never expose agent credentials to the web app
    const { agentPassword: _agentPassword, ...safeEmployee } = employee;
    return NextResponse.json({ data: safeEmployee });
  } catch (error) {
    log.error('api.employees.id.', { error: String('Employee GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch employee' }, { status: 500 });
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
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const validationError = validateUpdateBody(body);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const existing = await db.employee.findFirst({
      where: { id, organizationId: admin.organizationId },
      include: {
        department: { select: { id: true, name: true } },
        organization: { select: { id: true, name: true } },
      },
    });
    if (!existing) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

    // Cross-org validation: departmentId must belong to the caller's org.
    if (body.departmentId) {
      const dept = await db.department.findFirst({
        where: { id: body.departmentId, organizationId: admin.organizationId },
        select: { id: true },
      });
      if (!dept) {
        return NextResponse.json({ error: 'Department not found in your organization' }, { status: 422 });
      }
    }

    const diff = formatAuditDiff(existing, body);

    // No actual change (e.g. status toggle to the same value) — return the
    // record as-is instead of writing a phantom audit entry.
    if (!diff) {
      const { agentPassword: _agentPassword, ...safeExisting } = existing;
      return NextResponse.json({ data: safeExisting });
    }

    try {
      const employee = await db.$transaction(async (tx) => {
        // MERGE semantics — only fields present in the body are updated, so a
        // partial payload (`{ status }` from the table toggle, `{ designation }`
        // from a quick edit) can never silently wipe the other columns.
        const updated = await tx.employee.update({
          where: { id },
          data: {
            firstName: body.firstName !== undefined ? body.firstName.trim() : existing.firstName,
            lastName: body.lastName !== undefined ? body.lastName.trim() : existing.lastName,
            email: body.email !== undefined ? body.email.trim() : existing.email,
            phone: body.phone !== undefined ? body.phone : existing.phone,
            designation: body.designation !== undefined ? body.designation : existing.designation,
            departmentId: body.departmentId !== undefined ? (body.departmentId || null) : existing.departmentId,
            status: body.status !== undefined ? body.status : existing.status,
            joinDate:
              body.joinDate !== undefined
                ? body.joinDate
                  ? new Date(body.joinDate)
                  : null // explicit null clears the date
                : existing.joinDate,
          },
          include: {
            department: { select: { id: true, name: true } },
            organization: { select: { id: true, name: true } },
          },
        });

        // Audit log — never log credentials or secrets.
        await tx.auditLog.create({
          data: {
            action: 'update',
            resource: 'employee',
            resourceId: id,
            description: `Updated employee ${existing.firstName} ${existing.lastName}${diff}`,
            userId: admin.userId,
            organizationId: admin.organizationId,
          },
        });

        return updated;
      });
      // Never expose agent credentials to the web app
      const { agentPassword: _agentPassword, ...safeEmployee } = employee;
      return NextResponse.json({ data: safeEmployee });
    } catch (error) {
      // Unique email/employeeId constraint — surface as 409, not 500.
      // Code-based check (provider-independent) matching the POST route.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return NextResponse.json(
          { error: 'An employee with this email already exists in your organization' },
          { status: 409 }
        );
      }
      throw error;
    }
  } catch (error) {
    log.error('api.employees.id.', { error: String('Employee PUT error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update employee' }, { status: 500 });
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
    const existing = await db.employee.findFirst({
      where: { id, organizationId: admin.organizationId },
      select: { id: true },
    });
    if (!existing) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

    const employee = await db.employee.update({
      where: { id },
      data: { status: 'archived' },
    });
    return NextResponse.json({ data: employee });
  } catch (error) {
    log.error('api.employees.id.', { error: String('Employee DELETE error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to archive employee' }, { status: 500 });
  }
}
