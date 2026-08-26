import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';
import { hasActiveConsent } from '@/lib/consent';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/keystroke
// Aggregate keyboard-activity intervals from the desktop agent.
//
// PRIVACY CONTRACT (server-side enforcement): the payload may contain ONLY
// aggregate counts and durations. Fields that would carry raw keystroke data
// (key, keyCode, character, text, typedText, clipboard, form contents, IME)
// are REJECTED outright, as is ANY unknown field — the schema is closed:
// a payload with a single unexpected key is rejected as a whole (422).
//
// Enforcement chain:
//   validateAgentToken (device-bound + employee + org) →
//   hasActiveConsent('keystroke') → 403 when missing/revoked/stale →
//   org `keystroke_logging_enabled` → 403 when disabled →
//   strict per-interval validation → persist KeyboardActivity rows.

const MAX_INTERVALS_PER_REQUEST = 50;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000; // matching the activity 24h bound
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_KEYSTROKES_PER_INTERVAL = 100_000;
const MAX_TYPING_SECONDS = 86_400;
const APPLICATION_RE = /^[a-zA-Z0-9._-]{1,128}$/;

const ALLOWED_INTERVAL_KEYS = new Set(['intervalStart', 'intervalEnd', 'keystrokeCount', 'activeTypingSeconds', 'application']);
// Explicitly forbidden even if they were somehow allowed by name matching —
// these must NEVER be accepted, logged or stored.
const FORBIDDEN_KEYS = new Set(['key', 'keyCode', 'character', 'char', 'text', 'typedText', 'clipboard', 'formData', 'ime', 'scanCode', 'virtualKey']);

interface IntervalInput {
  [key: string]: unknown;
}

function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return !Number.isNaN(new Date(value).getTime());
}

function validateInterval(raw: IntervalInput): { ok: true; interval: {
  intervalStart: Date; intervalEnd: Date; keystrokeCount: number;
  activeTypingSeconds: number; application: string | null;
} } | { ok: false; error: string } {
  // Closed schema: every present key must be allowed, none may be forbidden.
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return { ok: false, error: `Field "${key}" is not allowed — raw keystroke data is never accepted` };
    }
    if (!ALLOWED_INTERVAL_KEYS.has(key)) {
      return { ok: false, error: `Unknown field "${key}" — payload schema is closed` };
    }
  }

  if (!isIsoTime(raw.intervalStart) || !isIsoTime(raw.intervalEnd)) {
    return { ok: false, error: 'intervalStart and intervalEnd must be ISO timestamps' };
  }
  const start = new Date(raw.intervalStart);
  const end = new Date(raw.intervalEnd);
  if (end.getTime() <= start.getTime()) {
    return { ok: false, error: 'intervalEnd must be after intervalStart' };
  }
  if (end.getTime() - start.getTime() > MAX_DURATION_MS) {
    return { ok: false, error: 'interval must be at most 24 hours' };
  }
  // Offline uploads are legitimate (past is unbounded); future is impossible.
  if (end.getTime() > Date.now() + FUTURE_SKEW_MS) {
    return { ok: false, error: 'intervalEnd is in the future' };
  }

  const keystrokeCount = raw.keystrokeCount;
  if (typeof keystrokeCount !== 'number' || !Number.isInteger(keystrokeCount) ||
      keystrokeCount < 0 || keystrokeCount > MAX_KEYSTROKES_PER_INTERVAL) {
    return { ok: false, error: `keystrokeCount must be an integer 0..${MAX_KEYSTROKES_PER_INTERVAL}` };
  }

  const activeTypingSeconds = raw.activeTypingSeconds;
  if (typeof activeTypingSeconds !== 'number' || !Number.isInteger(activeTypingSeconds) ||
      activeTypingSeconds < 0 || activeTypingSeconds > MAX_TYPING_SECONDS) {
    return { ok: false, error: `activeTypingSeconds must be an integer 0..${MAX_TYPING_SECONDS}` };
  }

  // A typing-duration can never exceed the interval wall-clock length + 1s.
  const intervalSeconds = Math.ceil((end.getTime() - start.getTime()) / 1000);
  if (activeTypingSeconds > intervalSeconds + 1) {
    return { ok: false, error: 'activeTypingSeconds exceeds the interval length' };
  }

  let application: string | null = null;
  if (raw.application !== undefined && raw.application !== null) {
    if (typeof raw.application !== 'string' || !APPLICATION_RE.test(raw.application)) {
      return { ok: false, error: 'application must be a safe process identifier (letters/digits/._-) up to 128 chars' };
    }
    application = raw.application;
  }

  return {
    ok: true,
    interval: { intervalStart: start, intervalEnd: end, keystrokeCount, activeTypingSeconds, application },
  };
}

export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid || !authResult.employee) {
      return NextResponse.json({ error: authResult.error || 'Authentication failed' }, { status: 401 });
    }
    const employee = authResult.employee;

    // Consent gate — fail closed on missing/revoked/outdated keystroke consent.
    if (!(await hasActiveConsent(employee.id, 'keystroke'))) {
      return NextResponse.json(
        { error: 'Keystroke logging requires consent. Consent is not granted or has been revoked.' },
        { status: 403 }
      );
    }

    // Org config gate — the server never trusts the agent blindly.
    const monitoring = await resolveOrgMonitoring(employee.organizationId);
    if (monitoring.keystroke_logging_enabled !== true) {
      return NextResponse.json({ error: 'KEYSTROKE_LOGGING_DISABLED' }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as unknown;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }

    // Accept either a single interval object (the documented payload) or a
    // batched { intervals: [...] }. Both go through the identical validator.
    let rawIntervals: unknown[];
    if ('intervals' in (body as Record<string, unknown>)) {
      const list = (body as { intervals?: unknown }).intervals;
      if (!Array.isArray(list) || list.length === 0) {
        return NextResponse.json({ error: 'intervals must be a non-empty array' }, { status: 400 });
      }
      rawIntervals = list;
    } else {
      rawIntervals = [body];
    }

    if (rawIntervals.length > MAX_INTERVALS_PER_REQUEST) {
      return NextResponse.json({ error: `Max ${MAX_INTERVALS_PER_REQUEST} intervals per request` }, { status: 400 });
    }

    const validated = [];
    for (const item of rawIntervals) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return NextResponse.json({ error: 'Each interval must be an object' }, { status: 422 });
      }
      const result = validateInterval(item as IntervalInput);
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 422 });
      }
      validated.push(result.interval);
    }

    const created = await db.keyboardActivity.createMany({
      data: validated.map((v) => ({
        employeeId: employee.id,
        deviceId: authResult.deviceId || null,
        organizationId: employee.organizationId,
        intervalStart: v.intervalStart,
        intervalEnd: v.intervalEnd,
        keystrokeCount: v.keystrokeCount,
        activeTypingSeconds: v.activeTypingSeconds,
        application: v.application,
      })),
    });

    return NextResponse.json({
      success: true,
      count: created.count,
      message: `${created.count} keyboard intervals recorded`,
    });
  } catch (error) {
    log.error('api.agent.keystroke.', { error: String('Agent keystroke error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
