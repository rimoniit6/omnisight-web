// OmniSight — Guest enrollment helpers (zero-touch person-level enrollment).
//
// A guest is created when an admin approves a zero-touch DeviceClaim in GUEST
// mode (no employee credentials, no AgentAccount). The guest is backed by a
// SYNTHESIZED Employee row (Employee.type = 'guest') so every existing runtime
// subsystem — AgentToken, AgentSession, Consent, telemetry, config assignment,
// heartbeat, break sessions — works unchanged. Approval NEVER grants consent.
//
// Security invariants:
//   - Everything is organization-scoped; the caller must pass a verified
//     org-bound admin scope (requireAdminOrg).
//   - The synthesized employee identity is clearly synthetic (prefix
//     "GUEST-", reserved .invalid email domain), globally unique
//     (Employee.employeeId is @unique; Employee.email is unique per org),
//     deterministic enough for auditing, and exposes no secrets.
//   - The DB enforces at most ONE ACTIVE and ONE PENDING guest per device
//     (partial unique indexes Guest_one_active_per_device /
//     Guest_one_pending_per_device) — the code checks first and the index is
//     the concurrency backstop.
import { randomBytes } from 'crypto';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { authError, authenticateRequest } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';
import { getPublishedPolicy, applyConsentTransition } from '@/lib/consent';
import type { ConsentStatus } from '@/lib/consent';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// ─── Organization-scoped guest configuration (OrganizationSetting) ──────────

export const GUEST_PENDING_LIMIT_SETTING_KEY = 'guest_pending_limit';
/** Conservative default: at most 20 pending guest enrollments per org. */
export const DEFAULT_GUEST_PENDING_LIMIT = 20;

/**
 * Resolve the org's pending-guest cap. Stored as a whole number in
 * OrganizationSetting; missing/invalid values fall back to the default. The
 * cap gates GUEST-mode approval only — normal employee enrollment is never
 * affected.
 */
export async function resolveGuestPendingLimit(orgId: string): Promise<number> {
  const setting = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgId, key: GUEST_PENDING_LIMIT_SETTING_KEY } },
  });
  if (!setting) return DEFAULT_GUEST_PENDING_LIMIT;
  const n = Number.parseInt(setting.value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 1000) return DEFAULT_GUEST_PENDING_LIMIT;
  return n;
}

// ─── Synthesized guest identity ──────────────────────────────────────────────

export interface GuestIdentity {
  employeeId: string; // GUEST-<hex> — globally unique, clearly synthetic
  email: string;      // guest-<...>@guests.invalid — reserved TLD, per-org unique
  firstName: string;
  lastName: string;
}

/**
 * Build a clearly-synthetic employee identity for a guest. `employeeId` and
 * `email` derive from a fresh cryptographically-random token so they can never
 * collide with real employees or leak device information. Collisions are
 * practically impossible; Employee.employeeId @unique and Employee.email
 * (per-org) @unique are the DB backstops.
 */
export function synthesizeGuestIdentity(hostname: string): GuestIdentity {
  const token = randomBytes(6).toString('hex');
  const employeeId = `GUEST-${token.toUpperCase()}`;
  return {
    employeeId,
    email: `guest-${token}@guests.invalid`,
    firstName: 'Guest',
    // Human-readable context in the admin panel; never used for auth.
    lastName: hostname.trim().slice(0, 40) || 'Device',
  };
}

// ─── Guest mutation guard (Org Admin or Manager, org-scoped, rate-limited) ──

export type GuestWriteScope =
  | { ok: true; organizationId: string; userId: string; email: string; clientIp: string }
  | { ok: false; response: NextResponse };

/**
 * Shared guard for guest lifecycle mutations (suspend / revoke / reactivate /
 * convert). Authentication is the JWT entry gate; the AUTHORIZATION decision is
 * DB-authoritative:
 *   - The caller must be acting within an organization (from the session).
 *   - The effective role is re-read from the DATABASE (AppUser.role), so a
 *     revoked/downgraded role is honored immediately even if the JWT still
 *     carries stale claims. When no AppUser record exists (legacy / claim-only
 *     sessions) the JWT claim is the fallback.
 *   - Guest management requires "Organization Admin or Manager" (manager+ in the
 *     shared role hierarchy). Viewer, Employee and Guest identities are denied.
 *   - The same per-IP write rate limit the device-claim routes use is applied.
 * Returns an error response when unauthorized/rate-limited.
 */
export async function requireGuestWriteScope(req: NextRequest): Promise<GuestWriteScope> {
  const auth = await authenticateRequest(req);
  if (!auth) return { ok: false, response: authError({ ok: false, status: 401 }) };

  // JWT is only the entry gate; the elevation authority is the DB role below.
  let effectiveRole = auth.role;
  const dbUser = await db.appUser.findUnique({
    where: { id: auth.userId },
    select: { role: true, isActive: true },
  });
  if (dbUser) {
    if (!dbUser.isActive) return { ok: false, response: authError({ ok: false, status: 401 }) };
    effectiveRole = dbUser.role;
  }

  // Guest lifecycle management requires Organization Admin OR Manager.
  if (!hasRolePermission(effectiveRole, 'manager')) {
    return {
      ok: false,
      response: authError({ ok: false, status: 403 }, { permission: 'guests.manage', userRole: effectiveRole }),
    };
  }

  const callerOrg = auth.activeOrganizationId || auth.organizationId;
  if (!callerOrg) return { ok: false, response: authError({ ok: false, status: 403 }, { permission: 'guests.manage', userRole: effectiveRole }) };

  const org = await db.organization.findUnique({ where: { id: callerOrg }, select: { status: true } });
  if (!org || org.status !== 'active') return { ok: false, response: authError({ ok: false, status: 403 }, { permission: 'guests.manage', userRole: effectiveRole }) };

  const clientIp = getClientIpFromHeaders(req.headers);
  const rl = await checkRateLimit(`guest:${clientIp}`, RATE_LIMITS.deviceClaimWrite.limit, RATE_LIMITS.deviceClaimWrite.windowMs);
  if (!rl.allowed) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Too many requests. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      ),
    };
  }
  return { ok: true, organizationId: callerOrg, userId: auth.userId, email: auth.email, clientIp };
}

/**
 * Resolve a guest inside the admin's organization (cross-org ids are
 * indistinguishable from missing ones → null, and the caller maps to 404).
 */
export async function findOrgGuest(guestId: string, organizationId: string) {
  return db.guest.findFirst({
    where: { id: guestId, organizationId },
    include: { device: true, employee: true },
  });
}

/**
 * Create the Guest + guest-backed Employee atomically inside the caller's
 * transaction. "Approve as Guest" yields a GUEST workforce state: an
 * Employee row with Employee.type = 'guest', plus an ACTIVE Guest lifecycle
 * row so the enrollment stays addressable/manageable in the Guests view
 * (Active / Suspended / Rejected / Convert to Employee). A Guest may remain a
 * Guest indefinitely, or an authorized Org Admin/Manager may convert it to an
 * Employee later.
 *
 * The caller is responsible for:
 *   - admin org scope (requireAdminOrg),
 *   - the Device row lock + claim pending/expiry checks (concurrency),
 *   - the pending-guest cap check,
 *   - approving the DeviceClaim and binding the device,
 *   - audit log + notification.
 *
 * Ordering matters (FK cycle between Employee.guestId and Guest.employeeId):
 * Employee is created with guestId = NULL, then the Guest row is created, then
 * the Employee is back-linked.
 *
 * NEVER creates an AgentAccount, AppUser, OrganizationMembership, password or
 * Admin Panel login. Monitoring consent is granted separately via
 * grantGuestMonitoringConsents (auto-grant at approval).
 */
export async function createGuestBackedEmployee(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    deviceId: string;
    deviceHostname: string;
    identity?: GuestIdentity;
    /** Admin user id recorded on approval (lifecycle audit metadata). */
    approvedBy?: string;
  }
): Promise<{ guest: { id: string }; employee: { id: string; employeeId: string } }> {
  const identity = input.identity ?? synthesizeGuestIdentity(input.deviceHostname);

  const employee = await tx.employee.create({
    data: {
      employeeId: identity.employeeId,
      firstName: identity.firstName,
      lastName: identity.lastName,
      email: identity.email,
      status: 'active',
      // GUEST is a legitimate, intentional workforce state (not an error).
      // It is converted to 'employee' only when an authorized user chooses
      // "Convert to Employee" via the secure conversion endpoint.
      type: 'guest',
      organizationId: input.organizationId,
      // Approved devices authenticate via PATH A device-secret — an
      // AgentAccount is deliberately NEVER created.
      agentApproved: true,
    },
    select: { id: true, employeeId: true },
  });

  const guest = await tx.guest.create({
    data: {
      organizationId: input.organizationId,
      deviceId: input.deviceId,
      employeeId: employee.id,
      status: 'ACTIVE',
      ...(input.approvedBy ? { approvedAt: new Date(), approvedBy: input.approvedBy } : {}),
    },
    select: { id: true },
  });

  await tx.employee.update({
    where: { id: employee.id },
    data: { guestId: guest.id },
  });

  return { guest, employee };
}

// ─── Guest monitoring consent (auto-grant at approval) ─────────────────────

/**
 * The standard monitoring consents auto-granted when a guest is approved.
 * `activity_tracking` is what gates application/website telemetry upload
 * (POST /api/agent/activity); `monitoring` is the umbrella consent other
 * collectors consult. Screenshot/keystroke/location/etc. are NEVER
 * auto-granted — they require a separate, deliberate grant.
 */
export const GUEST_AUTO_GRANT_CONSENT_TYPES = ['monitoring', 'activity_tracking'] as const;

/**
 * Auto-grant the guest's monitoring consents inside the caller's transaction.
 *
 * Consent is NOT bypassed and NOT fabricated: each type goes through the
 * shared audited state machine (applyConsentTransition) and is bound to the
 * organization's CURRENT published policy version — exactly the semantics the
 * Consent page bulk-grant uses, so hasActiveConsent()/getConsentState() (and
 * therefore the agent's consent snapshot) report it as active.
 *
 * A type with NO published policy is SKIPPED (never invented) — the approval
 * still succeeds and collection for that type stays fail-closed until an
 * admin publishes a policy and grants it. A missing published policy must
 * never make device approval fail.
 *
 * Returns the consent types actually granted (for audit messaging).
 */
export async function grantGuestMonitoringConsents(
  tx: Prisma.TransactionClient,
  input: { employeeId: string; organizationId: string; performedBy: string }
): Promise<string[]> {
  const granted: string[] = [];
  for (const consentType of GUEST_AUTO_GRANT_CONSENT_TYPES) {
    // Fail-closed guard: no published policy → no consent row at all.
    const policy = await getPublishedPolicy(input.organizationId, consentType);
    if (!policy) continue;

    try {
      const existing = await tx.consent.findFirst({
        where: { employeeId: input.employeeId, consentType },
      });
      const consent =
        existing ??
        (await tx.consent.create({
          data: {
            employeeId: input.employeeId,
            consentType,
            status: 'pending',
            organizationId: input.organizationId,
          },
        }));
      await applyConsentTransition(
        tx,
        {
          id: consent.id,
          status: consent.status as ConsentStatus,
          consentType,
          organizationId: input.organizationId,
        },
        'granted',
        {
          performedBy: input.performedBy,
          action: 'auto_granted',
          writeAuditLog: false, // the guest_approved audit entry covers the event
        }
      );
      granted.push(consentType);
    } catch (err) {
      // A policy archived/withdrawn between the check and the write: skip this
      // type (fail-closed, never fabricate consent), keep the approval atomic.
      if (err instanceof Error && err.message.startsWith('No published policy')) continue;
      throw err;
    }
  }
  return granted;
}
