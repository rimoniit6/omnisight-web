import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { signJWT, setSessionCookie } from '@/lib/auth';
import { createUserSession, getUserAgent } from '@/lib/session';
import { checkRateLimit, getClientIpFromHeaders } from '@/lib/rate-limit';
import { log, requestContext } from '@/lib/logger';
import {
  resolveDemoOrganization,
  DEMO_USER_EMAIL,
  DEMO_SESSION_LIFETIME_SECONDS,
  DEMO_ENTER_RATE_LIMIT,
  DemoOrgError,
} from '@/lib/demo/guards';

// ─── OmniSight Demo-First Experience: public demo entry ────────────────────
//
// Landing Page "Explore Live Demo" → GET /api/demo/enter →
//   rate limit → validate demo configuration (fail-closed) →
//   create a NORMAL UserSession for the demo user → sign a NORMAL JWT →
//   set the EXISTING httpOnly session cookie → redirect to '/'.
//
// The resulting session is INDISTINGUISHABLE from a normal org-bound session:
// every dashboard API resolves the org from the verified JWT + session row and
// scopes queries by organizationId. No parallel auth path exists.
//
// SECURITY (Phase 4):
//   • Rate limited per client IP (token bucket, shared store).
//   • The demo organization is resolved SERVER-SIDE by its isDemo marker —
//     never from query params (?organizationId= / ?orgId= / ?userId= are
//     ignored by design; there is deliberately no body to parse).
//   • No redirect-url parameter: the redirect target is the fixed '/'.
//   • No credential disclosure: the demo user's password is never verified
//     here, never returned, never logged.
//   • Fail-closed on any demo configuration problem (503 with a generic
//     message; the specific DemoOrgError code stays server-side).

export async function GET(req: NextRequest) {
  const ctx = requestContext(req);
  try {
    // 1) Rate limit (per IP — public endpoint).
    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(
      `demo-enter:${clientIp}`,
      DEMO_ENTER_RATE_LIMIT.limit,
      DEMO_ENTER_RATE_LIMIT.windowMs
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many demo entries. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } }
      );
    }

    // 2) Resolve the demo tenant (fail-closed; NOT_FOUND/INVALID/etc → 503).
    let demo;
    try {
      demo = await resolveDemoOrganization();
    } catch (e) {
      if (e instanceof DemoOrgError) {
        log.error('api.demo.enter.not_provisioned', { code: e.code }, ctx);
        return NextResponse.json(
          { error: 'Demo is not available. Please try again later.' },
          { status: 503 }
        );
      }
      throw e;
    }

    // 3) Resolve the demo user (server-configured identity, never client input).
    const user = await db.appUser.findFirst({
      where: { email: DEMO_USER_EMAIL, isActive: true },
      select: { id: true, email: true, name: true, role: true, organizationId: true },
    });
    if (!user) {
      log.error('api.demo.enter.no_user', {}, ctx);
      return NextResponse.json(
        { error: 'Demo is not available. Please try again later.' },
        { status: 503 }
      );
    }
    // Defense-in-depth: the user must be bound to the resolved demo org.
    if (user.organizationId !== demo.id) {
      log.error('api.demo.enter.org_mismatch', {}, ctx);
      return NextResponse.json(
        { error: 'Demo is not available. Please try again later.' },
        { status: 503 }
      );
    }

    // 4) Create a NORMAL server-authoritative UserSession (S-04) that expires
    //    in lockstep with the short demo JWT lifetime. activeOrganizationId is
    //    persisted so the session row matches the JWT's activeOrganizationId
    //    claim (same consistency the org-switch flow maintains via P2-01).
    const expiresAt = new Date(Date.now() + DEMO_SESSION_LIFETIME_SECONDS * 1000);
    const { id: sessionId } = await createUserSession({
      userId: user.id,
      organizationId: demo.id,
      activeOrganizationId: demo.id,
      ipAddress: clientIp,
      userAgent: getUserAgent(req),
      expiresAt,
    });

    // 5) Sign a NORMAL JWT (org-bound; role from the membership layer is
    //    'manager' via the demo membership — mirror login's effectiveRole
    //    resolution by reading the ACTIVE membership directly).
    const membership = await db.organizationMembership.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId: demo.id } },
      select: { role: true, status: true },
    });
    if (!membership || membership.status !== 'ACTIVE') {
      log.error('api.demo.enter.no_membership', {}, ctx);
      return NextResponse.json(
        { error: 'Demo is not available. Please try again later.' },
        { status: 503 }
      );
    }

    const token = await signJWT({
      userId: user.id,
      email: user.email,
      role: membership.role,
      organizationId: demo.id,
      activeOrganizationId: demo.id,
      sessionId,
    });

    log.info('api.demo.enter', { sessionId }, ctx);

    // 6) Redirect into the existing SPA root with the standard cookie set.
    //    NextResponse.redirect + cookie: the AuthGuard hydrates from
    //    /api/auth/me and lands in the real dashboard for the demo org.
    const url = new URL('/', req.url);
    const res = NextResponse.redirect(url, { status: 302 });
    return setSessionCookie(res, token, DEMO_SESSION_LIFETIME_SECONDS);
  } catch (error) {
    log.error('api.demo.enter.error', { error: String(error) }, ctx);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
