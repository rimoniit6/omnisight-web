import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireManagerOrg, requireSessionOrg, validatePagination } from '@/lib/api';
import { validateAppListInput } from '@/lib/policies/validation';
import { bumpPolicyVersion, readPolicyVersion } from '@/lib/policies/version';
import { MAX_POLICY_PAYLOAD_ENTRIES } from '@/lib/policies/constants';
import { log, requestContext } from '@/lib/logger';

const MAX_SEARCH_LENGTH = 100;

// GET /api/app-list — List all app whitelist/blacklist entries
export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: app-policy entries are organization-scoped from the
    // verified session — never from client input. Org-less super_admins get an
    // empty payload (bootstrap state, mirroring the other org-scoped lists).
    const scope = await requireSessionOrg(req, { allowGlobal: true });
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ data: [], total: 0, page: 1, pageSize: 50, totalPages: 0, policyVersion: '0' });
    }
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);

    // Strict pagination — malformed/negative/zero/oversized values are
    // rejected with 422 (never NaN reaching Prisma).
    const pagination = validatePagination(searchParams, { defaultPageSize: 50, maxPageSize: 200 });
    if (!pagination.ok) {
      return NextResponse.json({ error: pagination.error }, { status: pagination.status });
    }

    const listType = searchParams.get('type') || '';
    if (listType && listType !== 'whitelist' && listType !== 'blacklist') {
      return NextResponse.json({ error: 'type must be whitelist or blacklist' }, { status: 422 });
    }
    const search = (searchParams.get('search') || '').trim();
    if (search.length > MAX_SEARCH_LENGTH) {
      return NextResponse.json({ error: `search must be at most ${MAX_SEARCH_LENGTH} characters` }, { status: 422 });
    }

    const where: Record<string, unknown> = { organizationId: orgId, isActive: true };
    if (listType) where.listType = listType;
    if (search) {
      where.OR = [
        { appName: { contains: search } },
        { executableName: { contains: search } },
      ];
    }

    const [entries, total] = await Promise.all([
      db.appListEntry.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.pageSize,
      }),
      db.appListEntry.count({ where }),
    ]);

    return NextResponse.json({
      data: entries,
      total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalPages: Math.ceil(total / pagination.pageSize),
      policyVersion: await readPolicyVersion(orgId),
    });
  } catch (error) {
    log.error('api.app-list.', { error: String('App list GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch app list' }, { status: 500 });
  }
}

// POST /api/app-list — Add app to whitelist or blacklist
export async function POST(req: NextRequest) {
  try {
    // Role gate: manager-or-above required. Organization identity comes ONLY
    // from the verified session — never from client-supplied input.
    const manager = await requireManagerOrg(req);
    if (!manager.ok) return authError(manager);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const validated = validateAppListInput(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 422 });
    }
    const input = validated.value;

    // Hard cap: never allow an org's active policy set to grow unbounded
    // beyond what the agent payload ships.
    const activeCount = await db.appListEntry.count({
      where: { organizationId: manager.organizationId, isActive: true },
    });
    if (activeCount >= MAX_POLICY_PAYLOAD_ENTRIES) {
      return NextResponse.json(
        { error: `Policy limit reached (${MAX_POLICY_PAYLOAD_ENTRIES} active entries)` },
        { status: 422 }
      );
    }

    const entry = await db.$transaction(async (tx) => {
      // DB-safe dedupe: the unique (org, appName, listType, isActive)
      // constraint is the final authority; the pre-check below gives a
      // friendly error, and a concurrent duplicate is caught by P2002.
      const existing = await tx.appListEntry.findFirst({
        where: {
          appName: input.appName,
          listType: input.listType,
          isActive: true,
          organizationId: manager.organizationId,
        },
      });
      if (existing) {
        return { conflict: true, message: 'App already exists in this list' } as const;
      }

      const created = await tx.appListEntry.create({
        data: {
          appName: input.appName,
          executableName: input.executableName,
          category: input.category,
          listType: input.listType,
          reason: input.reason,
          publisher: input.publisher,
          sha256: input.sha256,
          path: input.path,
          organizationId: manager.organizationId,
        },
      });

      // Policy version bump — same transaction as the write.
      await bumpPolicyVersion(tx, manager.organizationId);

      // Audit log — bound to the authenticated actor and organization.
      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'policy',
          resourceId: created.id,
          description: `Added ${created.appName} to app ${created.listType}${created.reason ? `: ${created.reason}` : ''}`,
          userId: manager.userId,
          organizationId: manager.organizationId,
        },
      });

      return { conflict: false as const, entry: created };
    });

    if (entry.conflict) {
      return NextResponse.json({ error: entry.message }, { status: 409 });
    }
    return NextResponse.json(entry.entry, { status: 201 });
  } catch (error) {
    // DB-safe dedupe backstop: a concurrent duplicate hits the unique index.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002'
    ) {
      return NextResponse.json({ error: 'App already exists in this list' }, { status: 409 });
    }
    log.error('api.app-list.', { error: String('App list POST error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to add app' }, { status: 500 });
  }
}
