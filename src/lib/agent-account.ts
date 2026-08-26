// OmniSight — Agent Account service (Phase 1: Employee Agent Authentication).
//
// A dedicated 1:1 credentials row (AgentAccount) for the employee-agent login
// flow. The Admin creates the account and provides the initial credentials —
// the employee NEVER self-registers. All passwords are bcrypt; hashes are
// never returned by any API. Lockout fields protect the login endpoint from
// brute force.
//
// Security invariants:
//   - verifyCredential() returns a SINGLE uniform failure for every failure
//     mode (no account / wrong password / disabled / locked) — no enumeration.
//   - failedLoginCount/lockedUntil implement account lockout (5 fails → 15 min).
//   - Legacy plaintext credentials copied by the migration are upgraded to
//     bcrypt in place on first successful verify (same pattern as
//     verifyAgentPassword in src/lib/agent/auth.ts).

import { db } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth';

/** Brute-force lockout policy. */
export const AGENT_ACCOUNT = {
  MAX_FAILED_LOGINS: 5,
  LOCKOUT_MS: 15 * 60 * 1000, // 15 minutes
  MIN_PASSWORD_LENGTH: 12,
} as const;

export type AgentAccountStatus = 'active' | 'disabled';

/** Public shape — NEVER includes passwordHash. */
export interface AgentAccountPublic {
  id: string;
  employeeId: string;
  agentId: string;
  status: AgentAccountStatus;
  lastLoginAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  passwordChangedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Strip the hash before anything crosses an API boundary. */
export function toPublicAccount(
  account: {
    id: string;
    employeeId: string;
    agentId: string;
    status: string;
    lastLoginAt: Date | null;
    failedLoginCount: number;
    lockedUntil: Date | null;
    passwordChangedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    passwordHash: string;
  }
): AgentAccountPublic {
  const { passwordHash: _hash, ...rest } = account;
  return { ...rest, status: rest.status as AgentAccountStatus };
}

/**
 * Password policy shared by create + reset. Returns an error string, or null
 * when the password is acceptable. Mirrors the Super Admin bootstrap policy.
 */
export function validateAgentPassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < AGENT_ACCOUNT.MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${AGENT_ACCOUNT.MIN_PASSWORD_LENGTH} characters`;
  }
  if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
  if (!/\d/.test(password)) return 'Password must contain a number';
  return null;
}

/** True when the account is currently in a lockout window. */
function isLocked(account: { lockedUntil: Date | null }): boolean {
  return account.lockedUntil !== null && account.lockedUntil.getTime() > Date.now();
}

/**
 * Create an AgentAccount for an employee (admin-only operation at the API layer).
 * - agentId defaults to the employee's Employee.employeeId unless overridden.
 * - Throws on duplicate agentId / missing employee (callers map to 409/422).
 * - NEVER logs or returns the plaintext password.
 */
export async function createAgentAccount(input: {
  employeeId: string;
  agentId?: string;
  password: string;
  status?: AgentAccountStatus;
}): Promise<AgentAccountPublic> {
  const validationError = validateAgentPassword(input.password);
  if (validationError) {
    const err = new Error(validationError);
    (err as Error & { code?: string }).code = 'INVALID_PASSWORD';
    throw err;
  }

  const agentId = (input.agentId ?? '').trim() || (await getDefaultAgentId(input.employeeId));

  const passwordHash = await hashPassword(input.password);
  const account = await db.agentAccount.create({
    data: {
      employeeId: input.employeeId,
      agentId,
      passwordHash,
      status: input.status ?? 'active',
      passwordChangedAt: new Date(),
    },
  });
  return toPublicAccount(account);
}

/** Resolve the default agentId (Employee.employeeId) for an employee. */
export async function getDefaultAgentId(employeeId: string): Promise<string> {
  const employee = await db.employee.findUnique({
    where: { id: employeeId },
    select: { employeeId: true },
  });
  if (!employee) {
    const err = new Error('Employee not found');
    (err as Error & { code?: string }).code = 'EMPLOYEE_NOT_FOUND';
    throw err;
  }
  return employee.employeeId;
}

/** Look up an account by its internal id. */
export async function getAgentAccount(accountId: string): Promise<AgentAccountPublic | null> {
  const account = await db.agentAccount.findUnique({ where: { id: accountId } });
  return account ? toPublicAccount(account) : null;
}

/** Look up an account by employee (internal id or Employee.employeeId code). */
export async function getAgentAccountByEmployee(
  employeeRef: string
): Promise<{ account: AgentAccountPublic; employee: { id: string; organizationId: string; status: string } } | null> {
  const account = await db.agentAccount.findFirst({
    where: { OR: [{ employeeId: employeeRef }, { employee: { employeeId: employeeRef } }] },
    include: { employee: { select: { id: true, organizationId: true, status: true } } },
  });
  if (!account) return null;
  const { passwordHash: _hash, ...rest } = account;
  return { account: { ...rest, status: rest.status as AgentAccountStatus }, employee: account.employee };
}

/**
 * Reset an account's password (admin-only at the API layer). Clears lockout
 * state. Returns the public account — never the password.
 *
 * `opts.activate` — used by the "Set up Agent Account" flow: a migrated
 * placeholder account (disabled, passwordChangedAt === null) is ACTIVATED in
 * the same atomic update that sets its first real password. Deliberately
 * disabled accounts stay disabled unless the caller opts in.
 */
export async function resetAgentAccountPassword(
  accountId: string,
  newPassword: string,
  opts?: { activate?: boolean }
): Promise<AgentAccountPublic> {
  const validationError = validateAgentPassword(newPassword);
  if (validationError) {
    const err = new Error(validationError);
    (err as Error & { code?: string }).code = 'INVALID_PASSWORD';
    throw err;
  }
  const passwordHash = await hashPassword(newPassword);
  const account = await db.agentAccount.update({
    where: { id: accountId },
    data: {
      passwordHash,
      passwordChangedAt: new Date(),
      failedLoginCount: 0,
      lockedUntil: null,
      ...(opts?.activate ? { status: 'active' as const } : {}),
    },
  });
  return toPublicAccount(account);
}

/** Enable or disable an account. Disabled accounts fail authentication. */
export async function setAgentAccountStatus(
  accountId: string,
  status: AgentAccountStatus
): Promise<AgentAccountPublic> {
  const account = await db.agentAccount.update({
    where: { id: accountId },
    data: { status },
  });
  return toPublicAccount(account);
}

/**
 * Verify a login attempt (used by POST /api/agent/login in Phase 3; exposed
 * here now so the account service is fully testable in Phase 1).
 *
 * Returns either a verified session context or a uniform failure — the caller
 * maps BOTH to the same HTTP 401 so account existence is never leaked.
 */
export async function verifyAgentCredential(input: {
  agentId: string;
  password: string;
}): Promise<
  | { ok: true; account: AgentAccountPublic; employee: { id: string; employeeId: string; organizationId: string; status: string } }
  | { ok: false; locked: boolean; retryAfterSeconds: number | null }
> {
  const account = await db.agentAccount.findUnique({
    where: { agentId: input.agentId },
    include: {
      employee: { select: { id: true, employeeId: true, organizationId: true, status: true } },
    },
  });

  // Uniform failure — same response whether the account exists or not.
  const fail = (locked: boolean, retryAfterSeconds: number | null = null) =>
    ({ ok: false as const, locked, retryAfterSeconds });

  if (!account) return fail(false);

  // Disabled account: no password check, no counter change.
  if (account.status !== 'active') return fail(false);

  // Locked out: reject without consuming the password.
  if (isLocked(account)) {
    const retryAfterSeconds = Math.max(1, Math.ceil((account.lockedUntil!.getTime() - Date.now()) / 1000));
    return fail(true, retryAfterSeconds);
  }

  // Verify the password. bcrypt hashes verify directly. Legacy plaintext
  // (copied by the migration) is upgraded to bcrypt in place on success.
  const stored = account.passwordHash;
  let valid = false;
  if (stored.startsWith('$2')) {
    valid = await verifyPassword(input.password, stored);
  } else {
    valid = stored === input.password;
  }

  if (!valid) {
    // Increment the failure counter; lock the account at the threshold.
    const failedLoginCount = account.failedLoginCount + 1;
    const lockedUntil = failedLoginCount >= AGENT_ACCOUNT.MAX_FAILED_LOGINS ? new Date(Date.now() + AGENT_ACCOUNT.LOCKOUT_MS) : null;
    await db.agentAccount.update({
      where: { id: account.id },
      data: { failedLoginCount, lockedUntil },
    });
    return fail(lockedUntil !== null, lockedUntil ? Math.ceil(AGENT_ACCOUNT.LOCKOUT_MS / 1000) : null);
  }

  // Success: upgrade legacy plaintext in place, reset the counter, record login.
  // The returned account is RE-READ after the update so it never carries stale
  // counter/lastLogin values (the pre-update row would report the old count).
  if (!stored.startsWith('$2')) {
    const upgraded = await hashPassword(input.password);
    await db.agentAccount.update({
      where: { id: account.id },
      data: { passwordHash: upgraded, failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
  } else {
    await db.agentAccount.update({
      where: { id: account.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
  }

  const fresh = await db.agentAccount.findUniqueOrThrow({ where: { id: account.id } });
  const { passwordHash: _hash, ...rest } = fresh;
  return {
    ok: true,
    account: { ...rest, status: rest.status as AgentAccountStatus },
    employee: { id: account.employee.id, employeeId: account.employee.employeeId, organizationId: account.employee.organizationId, status: account.employee.status },
  };
}
