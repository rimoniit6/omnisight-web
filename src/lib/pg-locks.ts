// OmniSight — advisory-lock transaction serialization (hardening area 2).
//
// Cross-process mutual exclusion for state-machine transitions that spread
// across row locks in MULTIPLE tenants (platform control-plane + org DB):
//
//   • Device activation (single-active-device rule) — Employee row locked in
//     the PLATFORM proxy while the authoritative employee lives in the org DB.
//   • Agent discovery fresh-claim issuance and admin approve/cancel — the
//     device row lock alone cannot serialize transitions that swap WHICH
//     database a merge-with-branch falls into.
//   • Anomaly persistence — unique dedupeKey already idempotently guards the
//     row, but an advisory lock around persist keeps the batch writer from
//     400s on two workers persisting the same batch (F-14).
//
// PostgreSQL's session-advisory locks are FAIR and correct under retry:
// pg_advisory_xact_lock blocks until acquired, then auto-releases at
// transaction end (no explicit unlock, no leak on crash). The lock key is
// derived from a stable string via hashtextextended (64-bit namespace per
// lock class, seed 0).

import type { Prisma } from '@prisma/client';

/**
 * Run `fn` inside a transaction holding an advisory lock for `lockKey`. The
 * lock lives inside the SAME transaction as `fn`'s writes so rollback
 * releases it automatically. Works with the platform `db` or any org-data
 * PrismaClient (their $transaction callback supplies the tx).
 */
export async function withTxAdvisoryLock<T>(
  txClient: {
    $transaction: <R>(fn: (tx: Prisma.TransactionClient) => Promise<R>) => Promise<R>;
  },
  lockKey: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return txClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    return fn(tx);
  });
}

export function deviceClaimLockKey(deviceId: string): string {
  return `device-claim:${deviceId}`;
}

export function employeeActivationLockKey(employeeId: string): string {
  return `employee-activation:${employeeId}`;
}

export function anomalyBatchLockKey(orgId: string, batchId: string): string {
  return `anomaly-persist:${orgId}:${batchId}`;
}