import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';
import { hasActiveConsent } from '@/lib/consent';
import { isInternalAgentProcess } from '@/lib/agent-process';
import { resolveOrgMonitoring, resolveActivityDedupeEnabled, resolveServerClassificationEnabled } from '@/lib/jobs/settings';
import { normalizeWebsiteDomain, sanitizeWebsiteTitle } from '@/lib/domain';
import { classifyRow } from '@/lib/classification/engine';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/activity
// Agent sends activity data (app usage, website visits, idle time, etc.)
// Accepts batch of activities.
//
// SERVER-AUTHORITATIVE VALIDATION (P2-2): the agent client is never trusted.
// type/category are allowlisted against the values the existing system
// actually produces/consumes (agent collectors, seed data, UI badges,
// analytics — see the Activity type comment in prisma/schema.prisma); a
// future timestamp is rejected (server time is the upper bound) while
// historical timestamps remain valid for legitimate offline queue uploads;
// duration must be a finite number within the documented 24h bound. Any
// invalid item rejects the WHOLE batch (422) — no partial writes.

const ACTIVITY_TYPE_ALLOWLIST = new Set(['application', 'website', 'idle', 'work_session', 'screenshot']);
const ACTIVITY_CATEGORY_ALLOWLIST = new Set(['productive', 'neutral', 'unproductive', 'idle']);
const MAX_DURATION_SECONDS = 86400; // existing 24h hard bound (no longer silently clamped)
const FUTURE_SKEW_MS = 5 * 60 * 1000; // small tolerance for legitimate clock skew

// P3-01 — server-side string length bounds (reject, never silently truncate
// security-relevant identifiers). The agent's own protocol produces short
// values (exe names, window titles, bare domains), so these caps are far
// above any legitimate payload while bounding row size and memory.
const MAX_TITLE_LENGTH = 512;
const MAX_URL_LENGTH = 2048;
const MAX_APPLICATION_NAME_LENGTH = 255;
// Whole-body guard (before JSON parse): 100 items × the field caps above is
// well under 1 MB — anything larger is malicious or a broken agent. Prevents
// unbounded in-memory JSON parsing from an oversized request body.
const MAX_BODY_BYTES = 1024 * 1024;

const MAX_LENGTH_BY_FIELD: Record<'title' | 'url' | 'applicationName', number> = {
  title: MAX_TITLE_LENGTH,
  url: MAX_URL_LENGTH,
  applicationName: MAX_APPLICATION_NAME_LENGTH,
};

// Phase 1 — optional idempotency key. One batchId per logical drain/upload
// batch (generated once by the agent, stable across retries of that batch).
// Accepts RFC-4122 UUID versions 1-5; uuid v4 (agent crypto.randomUUID) and
// v5 (deterministic derivation over queued item ids) are the supported
// producers. Absent batchId → today's behavior (legacy agents).
const BATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ActivityInput {
  type?: unknown;
  title?: unknown;
  url?: unknown;
  applicationName?: unknown;
  category?: unknown;
  duration?: unknown;
  timestamp?: unknown;
}

type ValidatedActivity = {
  ok: true;
  type: string;
  category: string;
  duration: number;
  timestamp: Date | null;
  title: string | null;
  url: string | null;
  applicationName: string | null;
};

type ActivityValidation = ValidatedActivity | { ok: false; error: string };

function validateActivity(act: ActivityInput): ActivityValidation {
  const type = act.type === undefined || act.type === null ? 'application' : act.type;
  if (
    typeof type !== 'string' ||
    type.length === 0 ||
    type.length > 32 ||
    !ACTIVITY_TYPE_ALLOWLIST.has(type)
  ) {
    return { ok: false, error: `Invalid activity type "${String(act.type)}"` };
  }

  const category = act.category === undefined || act.category === null ? 'neutral' : act.category;
  if (
    typeof category !== 'string' ||
    category.length === 0 ||
    category.length > 32 ||
    !ACTIVITY_CATEGORY_ALLOWLIST.has(category)
  ) {
    return { ok: false, error: `Invalid activity category "${String(act.category)}"` };
  }

  if (
    typeof act.duration !== 'number' ||
    !Number.isFinite(act.duration) ||
    act.duration < 0 ||
    act.duration > MAX_DURATION_SECONDS
  ) {
    return { ok: false, error: 'Invalid activity duration (must be 0-86400 seconds)' };
  }

  let timestamp: Date | null = null;
  if (act.timestamp !== undefined && act.timestamp !== null) {
    if (typeof act.timestamp !== 'string') {
      return { ok: false, error: 'Invalid activity timestamp' };
    }
    const parsed = new Date(act.timestamp);
    if (Number.isNaN(parsed.getTime())) {
      return { ok: false, error: 'Invalid activity timestamp' };
    }
    // Offline uploads are legitimate, so the PAST is unbounded. The FUTURE is
    // impossible: server time is the authoritative upper bound (small skew
    // tolerance so a slightly-fast agent clock never drops real events).
    if (parsed.getTime() > Date.now() + FUTURE_SKEW_MS) {
      return { ok: false, error: 'Activity timestamp is in the future' };
    }
    timestamp = parsed;
  }

  for (const field of ['title', 'url', 'applicationName'] as const) {
    const value = act[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return { ok: false, error: `Invalid activity ${field}` };
    }
    if (typeof value === 'string' && value.length > MAX_LENGTH_BY_FIELD[field]) {
      return {
        ok: false,
        error: `Activity ${field} exceeds maximum length of ${MAX_LENGTH_BY_FIELD[field]} characters`,
      };
    }
  }

  return {
    ok: true,
    type,
    category,
    duration: Math.round(act.duration),
    timestamp,
    title: typeof act.title === 'string' && act.title.length > 0 ? act.title : null,
    url: typeof act.url === 'string' && act.url.length > 0 ? act.url : null,
    applicationName:
      typeof act.applicationName === 'string' && act.applicationName.length > 0
        ? act.applicationName
        : null,
  };
}

export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid) {
      return NextResponse.json({ error: authResult.error }, { status: 401 });
    }

    // Privacy enforcement: activity tracking requires a valid, unexpired
    // 'activity_tracking' consent (the type granted for app/website/session
    // telemetry). Revoked or missing consent fails closed.
    const employeeId = authResult.employee!.id;
    if (!(await hasActiveConsent(employeeId, 'activity_tracking'))) {
      return NextResponse.json(
        { error: 'Activity tracking requires consent. Consent is not granted or has been revoked.' },
        { status: 403 }
      );
    }

    // P3-01: reject oversized bodies BEFORE parsing — a malicious or broken
    // agent must never force an unbounded in-memory JSON parse.
    const contentLength = Number(req.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return NextResponse.json({ error: `Request body exceeds maximum size of ${MAX_BODY_BYTES} bytes` }, { status: 413 });
    }

    const body = await req.json();
    const { activities, batchId, batchSeq } = body as {
      activities?: unknown;
      batchId?: unknown;
      batchSeq?: unknown;
    };

    if (!activities || !Array.isArray(activities) || activities.length === 0) {
      return NextResponse.json({ error: 'No activities provided' }, { status: 400 });
    }

    if (activities.length > 100) {
      return NextResponse.json({ error: 'Max 100 activities per request' }, { status: 400 });
    }

    // Phase 1 — optional batch metadata. batchId is validated strictly when
    // present (legacy agents omit it and keep today's path). batchSeq is a
    // monotonic per-device drain counter (informational; validated but not
    // persisted). Both are OPTIONAL: an upload without them is accepted and
    // processed exactly as before.
    let validBatchId: string | null = null;
    if (batchId !== undefined && batchId !== null) {
      if (typeof batchId !== 'string' || !BATCH_ID_RE.test(batchId)) {
        return NextResponse.json({ error: 'Invalid batchId (expected a UUID)' }, { status: 422 });
      }
      validBatchId = batchId;
    }
    if (batchSeq !== undefined && batchSeq !== null) {
      if (typeof batchSeq !== 'number' || !Number.isSafeInteger(batchSeq) || batchSeq < 0) {
        return NextResponse.json({ error: 'Invalid batchSeq (expected a non-negative integer)' }, { status: 422 });
      }
    }

    // Internal-process exclusion (defense in depth): activity records whose
    // applicationName is an internal WorkLensAI monitoring process are dropped
    // at ingestion — they can never become employee application usage, even
    // from an outdated agent build that still sends them.
    const filtered = activities.filter(
      (act) => !isInternalAgentProcess((act as ActivityInput).applicationName as string | undefined)
    );
    if (filtered.length === 0) {
      return NextResponse.json({ success: true, count: 0, message: '0 activities recorded' });
    }

    // Strict per-item validation FIRST — the whole batch is rejected on the
    // first invalid item (no partial writes, no silent category/type coercion).
    const validated: ValidatedActivity[] = [];
    for (const act of filtered) {
      const result = validateActivity(act as ActivityInput);
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 422 });
      }
      validated.push(result);
    }

    // Server-authoritative website_tracking enforcement (WT-P2-1): the org
    // setting gates ingestion INDEPENDENTLY of the agent/extension. Resolved
    // from the authenticated token's organization via the same canonical
    // resolver the agent config endpoint uses (resolveOrgMonitoring) — so the
    // server and the agent can never disagree, and a stale/compromised/rogue
    // agent can never upload website rows while the org has tracking disabled.
    // A website row in a mixed batch rejects the WHOLE batch (atomic — zero
    // rows written), matching the existing batch contract.
    const hasWebsite = validated.some((v) => v.type === 'website');
    if (hasWebsite) {
      const monitoring = await resolveOrgMonitoring(authResult.employee!.organizationId);
      if (monitoring.website_tracking !== true) {
        return NextResponse.json(
          { error: 'WEBSITE_TRACKING_DISABLED' },
          { status: 403 }
        );
      }
    }

    // Domain-only enforcement for website rows (privacy-first): the server
    // never trusts the agent blindly. Every `type='website'` value is
    // normalized to a bare lowercase domain (see lib/domain.ts). Full URLs,
    // paths, query strings, fragments, credentials and internal schemes are
    // stripped or rejected — and website rows that fail normalization are
    // DROPPED (never stored, never counted). Non-website rows keep their
    // existing behavior (their url field passes through as-is).
    const normalized = validated
      .map((v) => {
        if (v.type !== 'website') return { v, url: v.url };
        const domain = normalizeWebsiteDomain(v.url || v.applicationName || v.title || null);
        return { v, url: domain }; // null → website row dropped below
      })
      .filter(({ v, url }) => v.type !== 'website' || url !== null) as Array<{
      v: ValidatedActivity;
      url: string | null;
    }>;

    if (normalized.length === 0) {
      return NextResponse.json({ success: true, count: 0, message: '0 activities recorded' });
    }

    // Create activity records. Website titles are sanitized the same way the
    // domain is: URL-like tokens are stripped so a page title can never smuggle
    // a full URL (query params, tokens, paths) into storage.
    const organizationId = authResult.employee!.organizationId;
    const rows = normalized.map(({ v, url }) => ({
      type: v.type,
      title: v.type === 'website' ? sanitizeWebsiteTitle(v.title) : v.title,
      url,
      applicationName: v.applicationName,
      category: v.category,
      duration: v.duration,
      employeeId,
      deviceId: authResult.deviceId || null,
      timestamp: v.timestamp ?? new Date(),
      createdAt: new Date(),
    }));

    // Phase 3 — server-authoritative classification (org-scoped opt-in,
    // default OFF). When the org enables `server_classification`, the server
    // re-classifies every application/website row: org CategoryRules first
    // (ordered precedence), then the default heuristic mirror for unmatched
    // rows — so rows that match no rule keep exactly the category the agent
    // would have produced. When disabled, category is the agent's value
    // (today's behavior, byte-for-byte). Rules load ONCE per request and are
    // bounded (MAX_RULES_PER_ORG); idle/screenshot/work_session rows are never
    // re-classified.
    const classificationEnabled = await resolveServerClassificationEnabled(organizationId);
    let reclassified = 0;
    if (classificationEnabled) {
      const rules = await db.categoryRule.findMany({
        where: { organizationId, enabled: true },
        select: { id: true, matchType: true, pattern: true, category: true, priority: true, createdAt: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
      for (const row of rows) {
        if (row.type !== 'application' && row.type !== 'website') continue;
        const outcome = classifyRow(row, rules);
        if (!outcome) continue;
        if (outcome.category !== row.category) reclassified += 1;
        row.category = outcome.category;
      }
      if (reclassified > 0) {
        log.info(
          'api.agent.activity.classified',
          { organizationId, employeeId, reclassified, total: rows.length },
          requestContext(req)
        );
      }
    }

    // Phase 1 — receipt-based dedupe (org-scoped opt-in, default OFF). When
    // the org has activity_dedupe disabled — or the agent sent no batchId —
    // this is byte-for-byte today's behavior: insert and respond.
    const dedupeEnabled =
      validBatchId !== null && (await resolveActivityDedupeEnabled(organizationId));
    if (!dedupeEnabled) {
      const created = await db.activity.createMany({ data: rows });
      return NextResponse.json({
        success: true,
        count: created.count,
        message: `${created.count} activities recorded`,
      });
    }

    // Receipt + rows are committed in ONE transaction: a receipt can never
    // exist without its rows and rows can never exist without their receipt.
    // Race analysis:
    //  - Two identical uploads at once: the second hits the unique
    //    (organizationId, employeeId, batchId) constraint inside its tx,
    //    the whole tx aborts (no partial rows), and the handler re-reads the
    //    winner's committed receipt → success + deduplicated count.
    //  - Retry after a lost response: the first tx committed; the retry takes
    //    the duplicate path above → zero duplicate rows.
    //  - Partial validation failure: validation happens BEFORE this point and
    //    rejects the whole batch (422) — no receipt, no rows.
    const batchIdKey = validBatchId!;
    const receipt = { organizationId, employeeId, batchId: batchIdKey, rowCount: rows.length };
    try {
      await db.$transaction(async (tx) => {
        await tx.activityBatchReceipt.create({ data: receipt });
        await tx.activity.createMany({ data: rows });
      });
      // Observability (one line per accepted batch — no row content, no
      // secrets): batch id, tenant/employee scope and row count only.
      log.info(
        'api.agent.activity.batch-received',
        { organizationId, employeeId, batchId: batchIdKey, rowCount: rows.length },
        requestContext(req)
      );
      return NextResponse.json({
        success: true,
        count: rows.length,
        deduplicated: 0,
        message: `${rows.length} activities recorded`,
      });
    } catch (error) {
      // The only unique constraint this tx can hit is the batch receipt's
      // (organizationId, employeeId, batchId) key — Activity has no other
      // unique column. Treat that as an idempotent replay, never a 500.
      const isReceiptConflict =
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: string }).code === 'P2002' &&
        JSON.stringify((error as { meta?: { target?: unknown } }).meta?.target ?? '').includes('batchId');
      if (!isReceiptConflict) throw error;
      const existing = await db.activityBatchReceipt.findUnique({
        where: {
          organizationId_employeeId_batchId: {
            organizationId,
            employeeId,
            batchId: batchIdKey,
          },
        },
      });
      if (!existing) throw error; // not a real receipt conflict — surface it
      // Duplicate replay: a success, not an error — one summary line keeps it
      // diagnosable without flooding logs.
      log.info(
        'api.agent.activity.batch-duplicate',
        { organizationId, employeeId, batchId: batchIdKey, deduplicated: existing.rowCount },
        requestContext(req)
      );
      return NextResponse.json({
        success: true,
        count: 0,
        deduplicated: existing.rowCount,
        message: `${existing.rowCount} activities already recorded for batch ${batchIdKey}`,
      });
    }
  } catch (error) {
    log.error('api.agent.activity.', { error: String('Agent activity error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
