import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';
import { hasActiveConsent } from '@/lib/consent';
import { isInternalAgentProcess } from '@/lib/agent-process';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';
import { normalizeWebsiteDomain, sanitizeWebsiteTitle } from '@/lib/domain';

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
    const { activities } = body as { activities?: unknown };

    if (!activities || !Array.isArray(activities) || activities.length === 0) {
      return NextResponse.json({ error: 'No activities provided' }, { status: 400 });
    }

    if (activities.length > 100) {
      return NextResponse.json({ error: 'Max 100 activities per request' }, { status: 400 });
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
    const created = await db.activity.createMany({
      data: normalized.map(({ v, url }) => ({
        type: v.type,
        title: v.type === 'website' ? sanitizeWebsiteTitle(v.title) : v.title,
        url,
        applicationName: v.applicationName,
        category: v.category,
        duration: v.duration,
        employeeId: authResult.employee!.id,
        deviceId: authResult.deviceId || null,
        timestamp: v.timestamp ?? new Date(),
        createdAt: new Date(),
      })),
    });

    return NextResponse.json({
      success: true,
      count: created.count,
      message: `${created.count} activities recorded`,
    });
  } catch (error) {
    console.error('Agent activity error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
