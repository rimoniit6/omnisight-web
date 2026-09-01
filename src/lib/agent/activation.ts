// OmniSight — Single-Active-Device activation authority (Phase 5, STEP 4).
//
// ONE EMPLOYEE MAY HAVE MANY REGISTERED DEVICES, BUT ONLY ONE DEVICE MAY
// HOLD A VALID ACTIVE AGENTTOKEN AT A TIME.
//
// This module is the SINGLE serialization/enforcement point for device
// activation. Every token-issuing path (PATH A (device credential), PATH B (legacy))
// MUST flow through acquireActiveSlot() inside a db.$transaction():
//
//   SELECT "Employee" ... FOR UPDATE
//     → re-read the employee under the lock
//     → re-verify employee / AgentAccount / Organization status (fail closed)
//     → resolve the requesting device
//     → verify device ownership + eligibility
//     → find valid, eligible AgentTokens for the employee
//     → another eligible device owns the slot ⇒ ActiveDeviceConflictError
//       (mapped to HTTP 409 ACTIVE_DEVICE_EXISTS; the transaction rolls back
//        with ZERO mutation — no kick, no token deletion, no status change)
//     → the same device owns it ⇒ its own token(s) are deleted, a fresh
//       token is issued (re-login)
//     → nobody owns it ⇒ a fresh token is issued
//
// The database row lock (SELECT ... FOR UPDATE) provides the serialization —
// never a JS mutex, never in-memory state, and never Device.status alone as
// proof of an active connection. A token blocks ONLY while it belongs to the
// same employee, is unexpired, and its device still exists, is owned by the
// same employee + organization, and is eligible (online|offline). Expired,
// orphaned, revoked/disabled-device and unowned tokens never block and never
// trigger ACTIVE_DEVICE_EXISTS.

import type { Prisma } from '@prisma/client';

/** Device operational states that permit authentication. */
export const DEVICE_ELIGIBLE_STATUSES = ['online', 'offline'] as const;

export function isDeviceEligible(status: string): boolean {
  return (DEVICE_ELIGIBLE_STATUSES as readonly string[]).includes(status);
}

/**
 * Raised when another eligible device already holds the employee's active
 * slot. The route layer maps this to `409 { error: 'ACTIVE_DEVICE_EXISTS' }`.
 * The enclosing transaction MUST roll back — no mutation may survive.
 */
export class ActiveDeviceConflictError extends Error {
  constructor() {
    super('ACTIVE_DEVICE_EXISTS');
    this.name = 'ActiveDeviceConflictError';
  }
}

/** Employee-level ineligibility discovered under the lock (fail closed). */
export class EmployeeNotEligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeNotEligibleError';
  }
}

/** Device-level ineligibility discovered under the lock (fail closed). */
export class DeviceNotEligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceNotEligibleError';
  }
}

export interface ResolvedDevice {
  id: string;
  status: string;
  employeeId: string | null;
  organizationId: string;
}

export interface AcquireActiveSlotInput {
  /** Employee whose active slot is being claimed (row is locked FOR UPDATE). */
  employeeId: string;
  /**
   * Resolve the requesting device INSIDE the transaction. PATH A returns the
   * claim-bound device; PATH B finds-or-creates by (employeeId, hostname).
   * Running inside the tx means a conflict rollback also rolls back any
   * device row created here.
   */
  resolveDevice: (tx: Prisma.TransactionClient) => Promise<ResolvedDevice>;
  /** Test seam; defaults to the current time. */
  now?: Date;
}

export interface AcquireActiveSlotResult {
  /** The resolved requesting device (post-eligibility verification). */
  device: ResolvedDevice;
  /** Token ids revoked because they belonged to the SAME requesting device. */
  replacedTokenIds: string[];
}

/**
 * Claim the employee's single active-device slot inside an open transaction.
 *
 * - MUST be called inside `db.$transaction(...)`.
 * - Locks the Employee row FOR UPDATE before any check.
 * - Throws `ActiveDeviceConflictError` when another eligible device holds the
 *   slot — the caller (and only the caller) maps it to HTTP 409.
 * - On grant, revokes the requesting device's own prior token(s) (same-device
 *   re-login) and returns; the caller creates the fresh token.
 */
export async function acquireActiveSlot(
  tx: Prisma.TransactionClient,
  input: AcquireActiveSlotInput
): Promise<AcquireActiveSlotResult> {
  const now = input.now ?? new Date();

  // 1. Lock the Employee row — the single serialization point for this
  //    employee's active slot (same proven pattern as device-claims approve).
  await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${input.employeeId} FOR UPDATE`;

  // 2. Re-read the employee under the lock: READ COMMITTED takes a fresh
  //    snapshot after the lock wait, so this observes the latest committed
  //    state (e.g. a concurrent disable or a concurrent activation).
  const employee = await tx.employee.findUnique({
    where: { id: input.employeeId },
    select: { id: true, status: true, agentApproved: true, organizationId: true },
  });
  if (!employee) throw new EmployeeNotEligibleError('Employee not found');
  if (employee.status !== 'active') throw new EmployeeNotEligibleError('Employee is not active');
  if (!employee.agentApproved) throw new EmployeeNotEligibleError('Employee not approved by admin');

  // 3. AgentAccount fail-closed rule (mirrors validateAgentToken /
  //    validateAgentSession): an ABSENT account is fine — device credential PATH A
  //    and legacy PATH B onboarding never create an AgentAccount row
  //    (CRITICAL-01 regression). Only a present-but-disabled account fails
  //    closed, even if it was disabled mid-request.
  const account = await tx.agentAccount.findUnique({
    where: { employeeId: employee.id },
    select: { status: true },
  });
  if (account && account.status !== 'active') {
    throw new EmployeeNotEligibleError('Agent account is disabled');
  }

  // 4. Organization must exist and be active.
  const org = await tx.organization.findUnique({
    where: { id: employee.organizationId },
    select: { status: true },
  });
  if (!org || org.status !== 'active') {
    throw new EmployeeNotEligibleError('Organization is not active');
  }

  // 5. Resolve the requesting device inside the tx, then verify ownership and
  //    eligibility under the lock.
  const device = await input.resolveDevice(tx);
  if (device.employeeId !== employee.id || device.organizationId !== employee.organizationId) {
    throw new DeviceNotEligibleError('Device is not active');
  }
  if (!isDeviceEligible(device.status)) {
    throw new DeviceNotEligibleError('Device is not active');
  }

  // 6. Find the employee's unexpired tokens. A token is BLOCKING only when
  //    its device still exists, is eligible (online|offline), and is still
  //    owned by this employee in this organization. Expired tokens, orphaned
  //    tokens (device deleted), tokens of revoked/disabled/ineligible devices
  //    and unbound tokens NEVER block and NEVER trigger ACTIVE_DEVICE_EXISTS.
  const tokens = await tx.agentToken.findMany({
    where: { employeeId: employee.id, expiresAt: { gt: now } },
    select: { id: true, deviceId: true },
  });
  const deviceIds = [
    ...new Set(tokens.map((t) => t.deviceId).filter((d): d is string => Boolean(d))),
  ];
  const devices = deviceIds.length
    ? await tx.device.findMany({
        where: { id: { in: deviceIds } },
        select: { id: true, status: true, employeeId: true, organizationId: true },
      })
    : [];
  const deviceById = new Map(devices.map((d) => [d.id, d]));

  const blocking = tokens.filter((t) => {
    if (!t.deviceId) return false;
    const d = deviceById.get(t.deviceId);
    if (!d) return false;
    if (!isDeviceEligible(d.status)) return false;
    if (d.employeeId !== employee.id) return false;
    if (d.organizationId !== employee.organizationId) return false;
    return true;
  });

  // 7. Another eligible device owns the slot → 409. Throwing here aborts the
  //    transaction: nothing was deleted, created, or updated. No kick.
  const otherDeviceTokens = blocking.filter((t) => t.deviceId !== device.id);
  if (otherDeviceTokens.length > 0) {
    throw new ActiveDeviceConflictError();
  }

  // 8. Same-device re-login: revoke ONLY this device's own token(s). Another
  //    device's token is never touched — the silent-kick path no longer exists.
  const sameDeviceTokens = blocking.filter((t) => t.deviceId === device.id);
  let replacedTokenIds: string[] = [];
  if (sameDeviceTokens.length > 0) {
    replacedTokenIds = sameDeviceTokens.map((t) => t.id);
    await tx.agentToken.deleteMany({ where: { id: { in: replacedTokenIds } } });
  }

  return { device, replacedTokenIds };
}
