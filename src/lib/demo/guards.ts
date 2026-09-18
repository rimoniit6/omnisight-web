// OmniSight — Demo-First Experience configuration + fail-closed guards.
//
// Central demo identification and safety assertions. Every demo-related write
// (bootstrap, seed, simulator, reset) MUST call assertDemoOrg() before it
// touches the database; every demo context check uses isDemoOrganization() or
// resolveDemoOrganization(). There is deliberately NO string-matching and NO
// client input involved: the marker lives on the Organization row (isDemo,
// partial unique index => at most one demo org) and the id always comes from
// the server's own configuration or the verified session.

import 'server-only';

import { db } from '@/lib/db';

// ─── Configuration ─────────────────────────────────────────────────────────

/** Stable, deterministic demo organization slug. */
export const DEMO_ORG_SLUG = 'omnisight-demo';

/** Stable, deterministic demo display name. */
export const DEMO_ORG_NAME = 'OmniSight Demo (Simulated)';

/** Demo timezone — Asia/Dhaka matches the platform default (BDT pricing). */
export const DEMO_ORG_TIMEZONE = 'Asia/Dhaka';

/** Deterministic demo user identity. Email uses a reserved fake domain. */
export const DEMO_USER_EMAIL = process.env.DEMO_USER_EMAIL || 'demo@demo.omnisight.invalid';
export const DEMO_USER_NAME = process.env.DEMO_USER_NAME || 'Demo Explorer';

/**
 * Optional explicit password for the demo account (env-configured, never in
 * source). When unset the bootstrap generates a random one (stored hashed) —
 * the demo entry endpoint does NOT verify passwords: it mints the session
 * server-side after validating the demo configuration, so the password exists
 * only so the account cannot be logged into directly with a guessable value.
 */
export function demoUserPassword(): string | null {
  const p = process.env.DEMO_USER_PASSWORD;
  return p && p.length >= 12 ? p : null;
}

/**
 * Demo session lifetime (seconds). Short by design: a demo visitor session
 * lives 8 hours max, far below the normal 7-day JWT lifetime. The UserSession
 * row expires in lockstep.
 */
export const DEMO_SESSION_LIFETIME_SECONDS = 8 * 60 * 60;

/** Rate limit for the public demo entry endpoint (20 entries / minute / IP). */
export const DEMO_ENTER_RATE_LIMIT = { limit: 20, windowMs: 60 * 1000 } as const;

/**
 * Simulator cadence (seconds) for the lease-guarded loop. 60s keeps the demo
 * lively without noticeable DB write pressure (a handful of rows per tick).
 */
export const DEMO_SIMULATOR_INTERVAL_SECONDS = 60;

/** Reset the demo dataset after this many days of accumulated runtime. */
export const DEMO_RESET_AFTER_DAYS = 7;

/** Job lease name for the demo simulator (JobRun.claimJob mechanism). */
export const DEMO_SIMULATOR_JOB_NAME = 'demo_simulator';

/** Job lease name for the demo reset job. */
export const DEMO_RESET_JOB_NAME = 'demo_reset';

// ─── Fail-closed demo organization resolution ──────────────────────────────

export interface DemoOrg {
  id: string;
  name: string;
  slug: string;
  status: string;
}

/**
 * Thrown when the demo organization cannot be resolved as a valid demo
 * tenant. Every caller must fail closed — never fall back to another org.
 */
export class DemoOrgError extends Error {
  constructor(public readonly code: 'NOT_FOUND' | 'INVALID_MARKER' | 'NOT_MANAGED' | 'NOT_ACTIVE') {
    super(`Demo organization resolution failed [${code}] (fail-closed)`);
    this.name = 'DemoOrgError';
  }
}

/**
 * Resolve the ONE demo organization by its authoritative isDemo marker.
 * Fails closed when: no row, more than one (impossible via the partial unique
 * index, but checked defensively), the row is not MANAGED, or it is not
 * active. Never guesses, never falls back to another organization.
 */
export async function resolveDemoOrganization(): Promise<DemoOrg> {
  const rows = await db.organization.findMany({
    where: { isDemo: true },
    select: { id: true, name: true, slug: true, status: true, deploymentMode: true },
    take: 2,
  });
  if (rows.length === 0) throw new DemoOrgError('NOT_FOUND');
  if (rows.length > 1) throw new DemoOrgError('INVALID_MARKER');
  const org = rows[0];
  if (org.deploymentMode !== 'MANAGED') throw new DemoOrgError('NOT_MANAGED');
  if (org.status !== 'active') throw new DemoOrgError('NOT_ACTIVE');
  return { id: org.id, name: org.name, slug: org.slug, status: org.status };
}

/** True when the given organization row IS the demo organization. */
export function isDemoOrganization(org: { isDemo?: boolean | null } | null | undefined): boolean {
  return org?.isDemo === true;
}

/**
 * Server-side assertion used by EVERY demo write path (bootstrap, seed,
 * simulator, reset). Verifies the id is the resolved demo organization and
 * that the demo tenant is healthy (MANAGED + active). Throws (fail-closed)
 * on any mismatch — callers must abort, never fall back.
 */
export async function assertDemoOrg(organizationId: string): Promise<DemoOrg> {
  const demo = await resolveDemoOrganization();
  if (!organizationId || organizationId !== demo.id) {
    // Wrap as DemoOrgError-style failure: a write attempt for a non-demo id
    // is a bug or an attack — never proceed.
    throw new DemoOrgError('INVALID_MARKER');
  }
  return demo;
}

/**
 * Server-side assertion used by demo data routes (e.g. demo banner state):
 * verifies the SESSION organization is the demo organization. Returns the
 * demo org when true, null otherwise (NOT an error — most sessions are
 * normal tenants).
 */
export async function isSessionDemoOrg(organizationId: string | null | undefined): Promise<DemoOrg | null> {
  if (!organizationId) return null;
  try {
    const demo = await resolveDemoOrganization();
    return organizationId === demo.id ? demo : null;
  } catch {
    return null; // demo not provisioned — no session can be a demo session
  }
}

// ─── Cached demo-id lookup for the request proxy (Phase 12) ────────────────
//
// src/proxy.ts needs to recognize demo sessions on EVERY request. Resolving
// the demo org per request would add a query to each mutation; a short-TTL
// in-process cache keeps that cost at one query per TTL per replica. The id
// is stable for the lifetime of a deployment (only the bootstrap writes it),
// so a stale cache can only delay recognition, never misidentify: a cached id
// is only compared against JWT organization claims that were minted from the
// same row.
//
// Failure semantics: on a lookup error the cache returns null → the proxy
// cannot POSITIVELY identify a demo session → it allows the request (same as
// before this feature). This is deliberate: the read-only demo rule is UX
// defense-in-depth — the actual tenant-isolation boundary lives in the
// per-route organizationId scoping, which is unaffected. A demo mutation that
// slips through during a DB blip only ever touches the disposable demo org.

let cachedDemoOrgId: { id: string; expiresAt: number } | null = null;
const DEMO_ID_CACHE_TTL_MS = 5 * 60 * 1000;

/** Cached demo organization id (null when unresolved / not provisioned). */
export async function getDemoOrgIdCached(): Promise<string | null> {
  const now = Date.now();
  if (cachedDemoOrgId && cachedDemoOrgId.expiresAt > now) return cachedDemoOrgId.id;
  try {
    const demo = await resolveDemoOrganization();
    cachedDemoOrgId = { id: demo.id, expiresAt: now + DEMO_ID_CACHE_TTL_MS };
    return demo.id;
  } catch {
    // Negative-caching for a short window avoids hammering the DB when the
    // demo simply is not provisioned.
    cachedDemoOrgId = { id: '', expiresAt: now + 60 * 1000 };
    return null;
  }
}

/** True when the given org claim identifies the demo organization. */
export async function isDemoOrgId(organizationId: string | null | undefined): Promise<boolean> {
  if (!organizationId) return false;
  const demoId = await getDemoOrgIdCached();
  return demoId !== null && organizationId === demoId;
}
