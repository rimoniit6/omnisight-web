// OmniSight — Global API Authentication & Authorization Middleware
// Enforces JWT authentication on every /api/* route and role-based access
// control (RBAC) by path. Public endpoints are explicitly whitelisted.

import { NextRequest, NextResponse } from 'next/server';
import {
  verifyJWT,
  extractToken,
  hasRolePermission,
  SESSION_COOKIE_NAME,
  type JWTPayload,
} from '@/lib/auth';
import { log, requestContext } from '@/lib/logger';
import { checkRateLimit, getClientIpFromHeaders, RATE_LIMITS } from '@/lib/rate-limit';
import { isWebSessionActive } from '@/lib/session';

// ─── Rate limiting (sensitive/expensive endpoints) ─────────────────────────
// Applied centrally here (before auth, so unauthenticated floods are also
// throttled). Longest-prefix wins; `methods` restricts a rule to specific
// HTTP verbs. Web routes are keyed by client IP; agent routes are keyed by a
// hash of the agent bearer token so many agents behind one NAT each get an
// independent budget.

interface RateRule {
  prefix: string;
  methods?: string[];
  limit: number;
  windowMs: number;
  keyBy: 'ip' | 'agentToken' | 'user';
  label: string;
}

const RATE_RULES: RateRule[] = [
  // Exports — expensive, generate files
  { prefix: '/api/export', limit: RATE_LIMITS.exportCsv.limit, windowMs: RATE_LIMITS.exportCsv.windowMs, keyBy: 'ip', label: 'export' },
  { prefix: '/api/audit-logs/export', limit: RATE_LIMITS.exportCsv.limit, windowMs: RATE_LIMITS.exportCsv.windowMs, keyBy: 'ip', label: 'export' },
  { prefix: '/api/reports', methods: ['GET'], limit: RATE_LIMITS.exportPdf.limit, windowMs: RATE_LIMITS.exportPdf.windowMs, keyBy: 'ip', label: 'report-get' },
  { prefix: '/api/reports/pdf', methods: ['POST'], limit: RATE_LIMITS.exportPdf.limit, windowMs: RATE_LIMITS.exportPdf.windowMs, keyBy: 'ip', label: 'report-pdf' },
  // Bulk / import — heavy writes
  { prefix: '/api/employees/bulk', methods: ['POST'], limit: RATE_LIMITS.bulkWrite.limit, windowMs: RATE_LIMITS.bulkWrite.windowMs, keyBy: 'ip', label: 'bulk' },
  { prefix: '/api/anomalies/batch', methods: ['POST'], limit: RATE_LIMITS.bulkWrite.limit, windowMs: RATE_LIMITS.bulkWrite.windowMs, keyBy: 'ip', label: 'bulk' },
  { prefix: '/api/notifications/batch', methods: ['POST'], limit: RATE_LIMITS.bulkWrite.limit, windowMs: RATE_LIMITS.bulkWrite.windowMs, keyBy: 'ip', label: 'bulk' },
  // Notification/alert mutations (N-11/N-15): bounded so a flood cannot
  // generate unbounded notification/alert data.
  { prefix: '/api/notifications', methods: ['POST', 'PUT'], limit: RATE_LIMITS.employeeWrite.limit, windowMs: RATE_LIMITS.employeeWrite.windowMs, keyBy: 'ip', label: 'notification-write' },
  { prefix: '/api/notifications/preferences', methods: ['PUT'], limit: 30, windowMs: 60 * 1000, keyBy: 'user', label: 'notification-pref' },
  { prefix: '/api/alerts', methods: ['PUT'], limit: RATE_LIMITS.employeeWrite.limit, windowMs: RATE_LIMITS.employeeWrite.windowMs, keyBy: 'ip', label: 'alert-write' },
  { prefix: '/api/consent/bulk', methods: ['POST'], limit: RATE_LIMITS.bulkWrite.limit, windowMs: RATE_LIMITS.bulkWrite.windowMs, keyBy: 'ip', label: 'bulk' },
  { prefix: '/api/screenshots/batch-analyze', methods: ['POST'], limit: RATE_LIMITS.aiWrite.limit, windowMs: RATE_LIMITS.aiWrite.windowMs, keyBy: 'ip', label: 'ai' },
  // Employee CRUD — write path
  { prefix: '/api/employees', methods: ['POST', 'PUT', 'DELETE'], limit: RATE_LIMITS.employeeWrite.limit, windowMs: RATE_LIMITS.employeeWrite.windowMs, keyBy: 'ip', label: 'employee-write' },
  // Device CRUD — write path
  { prefix: '/api/devices', methods: ['POST', 'PUT', 'DELETE'], limit: RATE_LIMITS.deviceWrite.limit, windowMs: RATE_LIMITS.deviceWrite.windowMs, keyBy: 'ip', label: 'device-write' },
  // Break-toggle mutations (admin force-toggle + self-service break): bounded
  // so a misbehaving client cannot spam break lifecycle writes.
  { prefix: '/api/break-status', methods: ['POST'], limit: 30, windowMs: 60 * 1000, keyBy: 'user', label: 'break-toggle' },
  { prefix: '/api/self/break-status', methods: ['POST'], limit: 30, windowMs: 60 * 1000, keyBy: 'user', label: 'self-break-toggle' },
  // AI operations — external calls + cost
  { prefix: '/api/sentiment/analyze', methods: ['POST'], limit: RATE_LIMITS.aiWrite.limit, windowMs: RATE_LIMITS.aiWrite.windowMs, keyBy: 'ip', label: 'ai' },
  { prefix: '/api/anomalies/detect', methods: ['POST'], limit: RATE_LIMITS.aiWrite.limit, windowMs: RATE_LIMITS.aiWrite.windowMs, keyBy: 'ip', label: 'ai' },
  { prefix: '/api/insights/ai-analysis', methods: ['GET'], limit: RATE_LIMITS.aiWrite.limit, windowMs: RATE_LIMITS.aiWrite.windowMs, keyBy: 'ip', label: 'ai' },
  { prefix: '/api/insights', methods: ['POST'], limit: RATE_LIMITS.aiWrite.limit, windowMs: RATE_LIMITS.aiWrite.windowMs, keyBy: 'user', label: 'ai-insight-generate' },
  { prefix: '/api/screenshots', methods: ['POST'], limit: RATE_LIMITS.aiWrite.limit, windowMs: RATE_LIMITS.aiWrite.windowMs, keyBy: 'ip', label: 'ai' },
  { prefix: '/api/reports/generate', methods: ['POST'], limit: RATE_LIMITS.aiWrite.limit, windowMs: RATE_LIMITS.aiWrite.windowMs, keyBy: 'ip', label: 'ai' },
  // Expensive analytics reads (dashboard polls a few/min — generous cap)
  { prefix: '/api/analytics', methods: ['GET'], limit: RATE_LIMITS.analyticsRead.limit, windowMs: RATE_LIMITS.analyticsRead.windowMs, keyBy: 'ip', label: 'analytics' },
  // Uploads
  { prefix: '/api/upload/avatar', methods: ['POST'], limit: RATE_LIMITS.uploadAvatar.limit, windowMs: RATE_LIMITS.uploadAvatar.windowMs, keyBy: 'ip', label: 'upload' },
  // Screenshot image bytes (thumbnail loading + paging)
  { prefix: '/api/screenshots', methods: ['GET'], limit: RATE_LIMITS.screenshotImage.limit, windowMs: RATE_LIMITS.screenshotImage.windowMs, keyBy: 'ip', label: 'screenshot-image' },
  // Agent routes — keyed by agent token hash (see below)
  { prefix: '/api/agent/heartbeat', methods: ['POST'], limit: RATE_LIMITS.agentHeartbeat.limit, windowMs: RATE_LIMITS.agentHeartbeat.windowMs, keyBy: 'agentToken', label: 'agent-heartbeat' },
  { prefix: '/api/agent/consent', methods: ['GET'], limit: RATE_LIMITS.agentHeartbeat.limit, windowMs: RATE_LIMITS.agentHeartbeat.windowMs, keyBy: 'agentToken', label: 'agent-consent-read' },
  // Webcam frame relay is a high-frequency media path (~10fps = 600/min). It
  // gets its OWN budget (longest-prefix wins over the generic agent-write
  // rule below) so live streaming can never starve the control-plane writes
  // (session start/end, ack) of their shared 120/min allowance — without the
  // dedicated rule, a running session exhausts the generic bucket and the
  // agent's end-session POST gets 429'd, orphaning the session as "active".
  { prefix: '/api/agent/webcam/frame', methods: ['POST'], limit: 900, windowMs: 60 * 1000, keyBy: 'agentToken', label: 'webcam-frame' },
  { prefix: '/api/agent', methods: ['POST'], limit: RATE_LIMITS.agentWrite.limit, windowMs: RATE_LIMITS.agentWrite.windowMs, keyBy: 'agentToken', label: 'agent-write' },
  // P2-4: expensive / external-AI endpoints — keyed by authenticated user
  // (Bearer hash) with IP fallback for cookie sessions. Daily report and AI
  // summary can trigger external AI calls, so they get strict budgets.
  { prefix: '/api/reports/daily', methods: ['POST'], limit: 10, windowMs: 60 * 1000, keyBy: 'user', label: 'daily-report' },
  { prefix: '/api/reports/daily/ai-summary', methods: ['POST'], limit: 10, windowMs: 60 * 1000, keyBy: 'user', label: 'ai-summary' },
  { prefix: '/api/ai-provider/test-connection', methods: ['POST'], limit: RATE_LIMITS.aiTestConnection.limit, windowMs: RATE_LIMITS.aiTestConnection.windowMs, keyBy: 'ip', label: 'ai-test-connection' },
];

function matchRateRule(pathname: string, method: string): RateRule | null {
  let best: RateRule | null = null;
  for (const rule of RATE_RULES) {
    if (rule.methods && !rule.methods.includes(method)) continue;
    if (pathname === rule.prefix || pathname.startsWith(rule.prefix + '/')) {
      if (!best || rule.prefix.length > best.prefix.length) best = rule;
    }
  }
  return best;
}

function rateLimitResponse(rule: RateRule, retryAfterSeconds: number): NextResponse {
  const res = NextResponse.json(
    { error: `Rate limit exceeded. Try again in ${retryAfterSeconds} seconds.` },
    { status: 429 }
  );
  res.headers.set('Retry-After', String(retryAfterSeconds));
  res.headers.set('X-RateLimit-Limit', String(rule.limit));
  res.headers.set('X-RateLimit-Remaining', '0');
  return res;
}

async function enforceRateLimit(req: NextRequest): Promise<NextResponse | null> {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();
  const rule = matchRateRule(pathname, method);
  if (!rule) return null;

  let key: string;
  if (rule.keyBy === 'agentToken' || rule.keyBy === 'user') {
    const auth = req.headers.get('authorization') || '';
    // Agent routes: bucket per agent bearer token. User routes: bucket per
    // authenticated user (Bearer hash) so many users behind one NAT each get
    // an independent budget; cookie sessions (no header) fall back to IP.
    if (auth) {
      let hash = 0;
      for (let i = 0; i < auth.length; i++) hash = (hash * 31 + auth.charCodeAt(i)) >>> 0;
      key = `${rule.label}:${hash.toString(36)}`;
    } else {
      key = `${rule.label}:${getClientIpFromHeaders(req.headers)}`;
    }
  } else {
    key = `${rule.label}:${getClientIpFromHeaders(req.headers)}`;
  }

  const rl = await checkRateLimit(key, rule.limit, rule.windowMs);
  if (!rl.allowed) {
    log.warn('proxy.rate_limited', { path: pathname, method, label: rule.label }, requestContext(req));
    return rateLimitResponse(rule, rl.retryAfterSeconds);
  }
  return null;
}

// ─── Public / agent-token whitelist (exact path prefixes) ──────────────────
const PUBLIC_PREFIXES = ['/api/auth/login'];
const AGENT_PREFIXES = ['/api/agent/'];
// Public health probes for external monitoring: the routes only reveal
// availability + latency (no credentials, no schema, no env). Prefix match
// so /api/health and /api/health/database are both reachable without a token.
const HEALTH_PREFIX = '/api/health';

// ─── RBAC rules: prefix -> minimum role (longest prefix wins) ──────────────
interface RoleRule {
  prefix: string;
  minRole: 'admin' | 'manager';
}
const ROLE_RULES: RoleRule[] = [
  // Manager+ read-only settings sub-routes (defense-in-depth: retention
  // policies and monitoring config reveal operational data lifecycles but
  // are read-only). Longest-prefix match wins over the general /api/settings
  // admin rule below.
  { prefix: '/api/settings/retention', minRole: 'manager' },
  { prefix: '/api/settings/monitoring', minRole: 'manager' },
  // Admin+ only (super_admin, owner, admin)
  { prefix: '/api/settings', minRole: 'admin' },
  { prefix: '/api/organization', minRole: 'admin' },
  { prefix: '/api/branding/organization', minRole: 'admin' },
  // Device claims are admin workflows (the Agent
  // Approvals page is admin-gated in navigation.ts). The list
  // exposes pending-device identities, so reads must match the
  // actions' admin gate. The device-owned {id}/cancel path is unaffected:
  // it is proxy-public by design (claim-secret authenticated inside the
  // route) and short-circuits before this RBAC section.
  { prefix: '/api/device-claims', minRole: 'admin' },
  { prefix: '/api/auth/users', minRole: 'admin' },
  { prefix: '/api/ai-provider', minRole: 'admin' },
  { prefix: '/api/import', minRole: 'admin' },
  // Manager+ only (super_admin, owner, admin, manager). The audit-logs rule
  // covers BOTH the list and the export (longest-prefix wins) — security
  // telemetry (hostnames, employee codes, IPs, admin emails) is not exposed to
  // the lowest-privilege role (S-05).
  { prefix: '/api/export', minRole: 'manager' },
  { prefix: '/api/audit-logs', minRole: 'manager' },
  { prefix: '/api/self', minRole: 'manager' },
  { prefix: '/api/consent', minRole: 'manager' },
];

function getToken(req: NextRequest): string | null {
  const header = extractToken(req);
  if (header) return header;
  const cookie = req.cookies.get(SESSION_COOKIE_NAME);
  return cookie?.value || null;
}

function matchRoleRule(pathname: string): RoleRule | null {
  let best: RoleRule | null = null;
  for (const rule of ROLE_RULES) {
    if (pathname === rule.prefix || pathname.startsWith(rule.prefix + '/')) {
      if (!best || rule.prefix.length > best.prefix.length) best = rule;
    }
  }
  return best;
}

function unauthorized(message = 'Unauthorized'): NextResponse {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Health check (public — external monitoring probes these without a token)
  if (pathname === HEALTH_PREFIX || pathname.startsWith(HEALTH_PREFIX + '/')) {
    return NextResponse.next();
  }

  // Public login
  for (const p of PUBLIC_PREFIXES) {
    if (pathname === p || pathname.startsWith(p + '/')) {
      return NextResponse.next();
    }
  }

  // Central rate limiting for sensitive/expensive endpoints (before auth so
  // unauthenticated floods are throttled too). Agent routes are keyed by
  // token hash; web routes by client IP.
  const rateLimited = await enforceRateLimit(req);
  if (rateLimited) return rateLimited;

  // Agent-token endpoints — the routes themselves validate the agent bearer
  // token (validateAgentToken). Do not apply JWT middleware here.
  for (const p of AGENT_PREFIXES) {
    if (pathname.startsWith(p)) {
      return NextResponse.next();
    }
  }

  // Device-owned claim cancellation — authenticated INSIDE the route with the
  // device's one-time claim secret (never an admin JWT). Only the exact
  // /api/device-claims/{id}/cancel path is public-at-proxy-level; the
  // approve/reject/revoke siblings keep their admin-JWT + RBAC guard here.
  if (pathname.startsWith('/api/device-claims/') && pathname.endsWith('/cancel')) {
    return NextResponse.next();
  }

  // Authenticate
  const token = getToken(req);
  if (!token) {
    log.warn('proxy.auth.missing_token', { path: pathname, method: req.method }, requestContext(req));
    return unauthorized('Unauthorized. Please sign in.');
  }

  const payload: JWTPayload | null = await verifyJWT(token);
  if (!payload) {
    log.warn('proxy.auth.invalid_token', { path: pathname, method: req.method }, requestContext(req));
    return unauthorized('Invalid or expired token');
  }

  // Server-authoritative session revocation (S-04): web tokens carry a
  // sessionId that must still be active (not revoked, not expired). A uniform
  // 401 — same response for revoked, expired, or missing rows (no oracle).
  // Agent-token routes and public paths short-circuit before this section.
  if (payload.sessionId) {
    const sessionActive = await isWebSessionActive(payload.sessionId);
    if (!sessionActive) {
      log.warn('proxy.auth.session_inactive', { path: pathname, method: req.method }, requestContext(req));
      return unauthorized('Invalid or expired token');
    }
  }

  // CSRF defense-in-depth: for state-changing requests, reject cross-origin
  // calls. SameSite=Lax already blocks cross-site cookie sending; this
  // guards the Bearer-header path.
  const method = req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = req.headers.get('origin');
    if (origin) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== req.headers.get('host')) {
          log.warn('proxy.csrf.cross_origin_rejected', { path: pathname, origin, host: req.headers.get('host') }, requestContext(req));
          return NextResponse.json({ error: 'Cross-origin request rejected' }, { status: 403 });
        }
      } catch {
        log.warn('proxy.csrf.invalid_origin', { path: pathname }, requestContext(req));
        return NextResponse.json({ error: 'Invalid origin' }, { status: 403 });
      }
    }
  }

  // RBAC
  const roleRule = matchRoleRule(pathname);
  if (roleRule && !hasRolePermission(payload.role, roleRule.minRole)) {
    log.warn('proxy.rbac.denied', { path: pathname, role: payload.role, required: roleRule.minRole }, requestContext(req));
    return NextResponse.json(
      { error: 'Insufficient permissions' },
      { status: 403 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/api/:path*'],
};

// Exported for regression tests (MO-ADMIN-17/18): the daily-report and
// ai-summary rate rules must exist with strict per-user budgets.
export const __RATE_RULES_FOR_TESTS = RATE_RULES;
