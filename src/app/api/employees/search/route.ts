import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiError, apiSuccess, requireSessionOrg, authError } from '@/lib/api';
import { Prisma } from '@prisma/client';
import { log, requestContext } from '@/lib/logger';

// Lightweight, org-scoped employee search for searchable selectors
// (EmployeeCombobox). Returns only the minimal fields required for
// selection. Case-insensitive via PostgreSQL ILIKE (`mode: 'insensitive'`).

const SEARCH_FIELDS = ['firstName', 'lastName', 'email', 'employeeId'] as const;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_IDS = 50;

export async function GET(req: NextRequest) {
  const scope = await requireSessionOrg(req, { allowGlobal: true });
  if (!scope.ok) return authError(scope);

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 100);

  // Explicit id lookup (used to hydrate already-selected employees so the
  // selector can always render a proper label for its current value).
  const idsParam = url.searchParams.get('ids');
  const ids = idsParam
    ? idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_IDS)
    : [];

  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Number(limitRaw) : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return apiError(`limit must be an integer between 1 and ${MAX_LIMIT}`, 400);
  }

  const offsetRaw = url.searchParams.get('offset');
  const offset = offsetRaw ? Number(offsetRaw) : 0;
  if (!Number.isInteger(offset) || offset < 0) {
    return apiError('offset must be a non-negative integer', 400);
  }

  const statusParam = url.searchParams.get('status');
  if (statusParam && !['active', 'inactive', 'all'].includes(statusParam)) {
    return apiError('invalid status', 400);
  }

  // ─── Where clauses ────────────────────────────────────────────────────────

  // Tenant isolation: org always derived from the verified session; the
  // organizationId param is honored only for org-less global super_admins
  // targeting MANAGED organizations (same convention as GET /api/employees).
  // CUSTOMER_DB / PRIVATE targets are rejected (Phase 2 privacy).
  const organizationWhere: Prisma.EmployeeWhereInput = {};
  if (scope.organizationId) {
    organizationWhere.organizationId = scope.organizationId;
  } else {
    const orgParam = url.searchParams.get('organizationId');
    if (orgParam) {
      const target = await db.organization.findUnique({
        where: { id: orgParam },
        select: { id: true, deploymentMode: true },
      });
      if (!target) return apiError('Organization not found', 400);
      if (target.deploymentMode !== 'MANAGED') {
        return NextResponse.json(
          { error: 'Operational data for customer-owned organizations is not accessible from the Super Admin console', code: 'TENANT_ACCESS_DENIED_FOR_MODE' },
          { status: 403 },
        );
      }
      organizationWhere.organizationId = orgParam;
    }
  }

  // Archived employees are never returned by default (same as /api/employees).
  const statusWhere: Prisma.EmployeeWhereInput =
    statusParam === 'active' ? { status: 'active' }
    : statusParam === 'inactive' ? { status: 'inactive' }
    : { status: { not: 'archived' } };

  const idWhere: Prisma.EmployeeWhereInput = ids.length ? { id: { in: ids } } : {};

  // Multi-word queries: every token must match at least one field.
  // Case-insensitive on PostgreSQL via `mode: 'insensitive'` (ILIKE).
  const tokens = q.split(/\s+/).filter(Boolean);
  const searchWhere: Prisma.EmployeeWhereInput = tokens.length
    ? {
        AND: tokens.map((token) => ({
          OR: SEARCH_FIELDS.map((field) => ({ [field]: { contains: token, mode: 'insensitive' } })),
        })),
      }
    : {};

  const where: Prisma.EmployeeWhereInput = {
    ...organizationWhere,
    ...statusWhere,
    ...idWhere,
    ...searchWhere,
  };

  const select = {
    id: true,
    employeeId: true,
    firstName: true,
    lastName: true,
    email: true,
    designation: true,
    avatar: true,
    department: { select: { id: true, name: true } },
  } satisfies Prisma.EmployeeSelect;

  const orderBy: Prisma.EmployeeOrderByWithRelationInput[] = q || ids.length
    ? [{ firstName: 'asc' }, { lastName: 'asc' }]
    : [{ createdAt: 'desc' }];

  try {
    const [data, total] = await Promise.all([
      db.employee.findMany({ where, select, orderBy, skip: offset, take: limit }),
      db.employee.count({ where }),
    ]);

    return apiSuccess({
      data: data.map((e) => ({
        id: e.id,
        employeeId: e.employeeId,
        firstName: e.firstName,
        lastName: e.lastName,
        email: e.email,
        designation: e.designation,
        avatar: e.avatar,
        departmentName: e.department?.name ?? null,
      })),
      total,
      limit,
      offset,
    });
  } catch {
    return apiError('Failed to search employees', 500);
  }
}
