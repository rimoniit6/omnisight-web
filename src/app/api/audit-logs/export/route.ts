'use server';
import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { authenticateRequest } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { DEFAULT_EXPORT_WINDOW_DAYS, parseExportRange } from '@/lib/export';

// ─── Bounded-export constants (S-02) ────────────────────────────────────────
// The export never loads the whole audit-log table into memory:
//   - rows are fetched in DB pages of EXPORT_PAGE_SIZE with keyset pagination
//     on (createdAt, id) — the same order the export is sorted by — so only
//     one page is materialized at a time;
//   - the dataset is capped at MAX_EXPORT_ROWS with a `truncated` flag (a deep
//     scan is the point of this fix — a silent truncation log guards the cap);
//   - without an explicit date range the export defaults to the last
//     DEFAULT_EXPORT_WINDOW_DAYS days (never the entire history on a direct
//     API call). Malformed/inverted ranges are rejected with 400.
const EXPORT_PAGE_SIZE = 2000;
const MAX_EXPORT_ROWS = 100_000;

type ExportLogRow = {
  id: string;
  createdAt: Date;
  action: string;
  resource: string;
  resourceId: string | null;
  description: string;
  userId: string | null;
  ipAddress: string | null;
};

export async function GET(req: NextRequest) {
  try {
    // Handler-level RBAC — the proxy gates /api/audit-logs to manager+, and
    // the handler enforces it too (never proxy-only).
    const auth = await authenticateRequest(req);
    if (!auth) return authError({ ok: false, status: 401 });
    if (!hasRolePermission(auth.role, 'manager')) return authError({ ok: false, status: 403 });

    // Tenant isolation: the export is scoped to the caller's organization —
    // never dumps audit logs across tenants. Org-less super_admins get an
    // empty export (bootstrap state, mirroring the audit-logs list route).
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ data: [], total: 0, truncated: false });
    }
    const orgId = scope.organizationId;

    // Date range: malformed/inverted → 400 (never a silent empty/partial
    // export); absent → last 90 days instead of the whole table.
    const { searchParams } = new URL(req.url);
    const range = parseExportRange(
      searchParams.get('from') || '',
      searchParams.get('to') || ''
    );
    if (range.error) {
      return NextResponse.json({ error: range.error.message }, { status: range.error.status });
    }
    const fromDate = range.fromDate ?? new Date(Date.now() - DEFAULT_EXPORT_WINDOW_DAYS * 86_400_000);
    const toDate = range.toDate ?? null;

    const where: Prisma.AuditLogWhereInput = {
      organizationId: orgId,
      createdAt: {
        ...(fromDate ? { gte: fromDate } : {}),
        ...(toDate ? { lte: toDate } : {}),
      },
    };

    // Keyset pagination in (createdAt desc, id desc) — the export order — so
    // only EXPORT_PAGE_SIZE rows live in memory at once. Stops at the cap.
    const exportData: Record<string, string>[] = [];
    let cursor: { createdAt: Date; id: string } | null = null;
    let truncated = false;

    for (;;) {
      const page: ExportLogRow[] = await db.auditLog.findMany({
        where: {
          ...where,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: EXPORT_PAGE_SIZE,
        select: {
          id: true,
          createdAt: true,
          action: true,
          resource: true,
          resourceId: true,
          description: true,
          userId: true,
          ipAddress: true,
        },
      });

      if (page.length === 0) break;

      for (const log of page) {
        if (exportData.length >= MAX_EXPORT_ROWS) {
          truncated = true;
          break;
        }
        exportData.push({
          Timestamp: log.createdAt.toISOString(),
          Action: log.action,
          Resource: log.resource,
          ResourceID: log.resourceId || '',
          Description: log.description,
          UserID: log.userId || '',
          IPAddress: log.ipAddress || '',
        });
      }

      if (truncated || page.length < EXPORT_PAGE_SIZE) break;
      cursor = { createdAt: page[page.length - 1].createdAt, id: page[page.length - 1].id };
    }

    if (truncated) {
      console.warn(
        `[export] audit-logs: result capped at ${MAX_EXPORT_ROWS} rows (increase window or narrow filters)`
      );
    }

    return NextResponse.json({ data: exportData, total: exportData.length, truncated });
  } catch (error) {
    console.error('Audit logs export GET error:', error);
    return NextResponse.json({ error: 'Failed to export audit logs' }, { status: 500 });
  }
}
