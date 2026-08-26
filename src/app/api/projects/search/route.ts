'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

/**
 * Lightweight, org-scoped project search for selectors/comboboxes.
 * Mirrors /api/employees/search:
 *   q        — substring match on project name (case-insensitive via
 *              PostgreSQL ILIKE), also matches the raw project id. Multi-word
 *              queries AND-match every token (each token must match name OR id).
 *   limit    — max 50, default 20
 *   offset   — >= 0
 *   status   — optional project status filter (active, on_hold, completed,
 *              cancelled); empty = all statuses
 *   ids      — comma-separated hydration of specific projects (max 50)
 *
 * Returns only id, name, status, priority, color, startDate, deadline,
 * departmentName — nothing else.
 */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MAX_IDS = 50;
const STATUSES = ['active', 'on_hold', 'completed', 'cancelled'] as const;

export async function GET(req: NextRequest) {
  try {
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);

    const { searchParams } = new URL(req.url);

    const rawLimit = searchParams.get('limit') || String(DEFAULT_LIMIT);
    const rawOffset = searchParams.get('offset') || '0';
    if (!/^\d+$/.test(rawLimit) || !/^\d+$/.test(rawOffset)) {
      return NextResponse.json({ error: 'Invalid limit or offset' }, { status: 400 });
    }
    const limit = Number(rawLimit);
    const offset = Number(rawOffset);
    if (limit < 1 || limit > MAX_LIMIT || offset < 0) {
      return NextResponse.json(
        { error: `Invalid limit or offset. limit: 1-${MAX_LIMIT}, offset >= 0` },
        { status: 400 }
      );
    }

    const rawStatus = (searchParams.get('status') || '').trim();
    if (rawStatus && !(STATUSES as readonly string[]).includes(rawStatus)) {
      return NextResponse.json(
        { error: `Invalid status. Allowed: ${STATUSES.join(', ')}` },
        { status: 400 }
      );
    }
    const status = rawStatus || null;
    // Archived (cancelled) projects are hidden from the DEFAULT selector list;
    // includeArchived=true brings them back; an explicit status filter wins.
    const includeArchived = searchParams.get('includeArchived') === 'true';

    const idsParam = (searchParams.get('ids') || '').trim();
    const ids = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean).slice(0, MAX_IDS) : [];

    const q = (searchParams.get('q') || '').trim().slice(0, 100);

    const orgFilter = scope.organizationId ? { organizationId: scope.organizationId } : {};

    // ids mode: return exactly the requested projects (hydration for selected
    // values that aren't in the current result set).
    if (ids.length > 0) {
      const projects = await db.project.findMany({
        where: { id: { in: ids }, ...orgFilter },
        select: {
          id: true, name: true, status: true, priority: true, color: true,
          startDate: true, deadline: true,
          department: { select: { name: true } },
        },
      });
      return NextResponse.json({
        data: projects.map((p) => ({ ...p, departmentName: p.department?.name ?? null, department: undefined })),
        total: projects.length,
        limit,
        offset: 0,
      });
    }

    // Search mode: token-AND across name + id.
    const where: Record<string, unknown> = { ...orgFilter };
    if (status) {
      // Explicit status filter takes precedence over the archive default.
      where.status = status;
    } else if (!includeArchived) {
      // Default selector view: hide archived (cancelled) projects.
      where.status = { not: 'cancelled' };
    }
    if (q) {
      const tokens = q.split(/\s+/).filter(Boolean);
      where.AND = tokens.map((token) => ({
        OR: [
          { name: { contains: token, mode: 'insensitive' } },
          { id: { contains: token, mode: 'insensitive' } },
        ],
      }));
    }

    const [projects, total] = await Promise.all([
      db.project.findMany({
        where,
        select: {
          id: true, name: true, status: true, priority: true, color: true,
          startDate: true, deadline: true,
          department: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
        skip: offset,
        take: limit,
      }),
      db.project.count({ where }),
    ]);

    return NextResponse.json({
      data: projects.map((p) => ({ ...p, departmentName: p.department?.name ?? null, department: undefined })),
      total,
      limit,
      offset,
    });
  } catch (error) {
    log.error('api.projects.search.', { error: String('Projects search error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to search projects' }, { status: 500 });
  }
}
