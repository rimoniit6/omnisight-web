// OmniSight — Organization policy versioning.
//
// A DB-backed monotonically increasing version stored in OrganizationSetting
// (`app_policy_version`). Bumped inside the SAME transaction as every policy
// write (POST/DELETE), so the version can never drift from the actual policy
// rows. Agents compare this version against their local cache to decide
// unchanged / new / stale without comparing full lists.

import type { Prisma } from '@prisma/client';
import { APP_POLICY_VERSION_SETTING_KEY, DEFAULT_POLICY_VERSION } from './constants';

type DbTx = Prisma.TransactionClient;

/**
 * Read the current policy version for an organization (outside a write
 * transaction). Never throws on a missing row — defaults to '0'.
 */
export async function readPolicyVersion(orgId: string): Promise<string> {
  const row = await (await import('@/lib/db')).db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgId, key: APP_POLICY_VERSION_SETTING_KEY } },
  });
  return row?.value ?? DEFAULT_POLICY_VERSION;
}

/**
 * Bump the org policy version by one, atomically, inside the caller's write
 * transaction. Uses an upsert keyed on the composite unique so concurrent
 * writes serialize on the row lock; the read-then-write is inside the
 * transaction, so the returned version is authoritative for that transaction.
 */
export async function bumpPolicyVersion(tx: DbTx, orgId: string): Promise<string> {
  const current = await tx.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgId, key: APP_POLICY_VERSION_SETTING_KEY } },
  });
  // First write on an org with no version row yet = version 1 (the agent
  // treats a missing row / DEFAULT_POLICY_VERSION '0' as "no policy"); every
  // subsequent bump increments by exactly one.
  let next = 1;
  if (current) {
    const parsed = parseInt(current.value, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) next = parsed + 1;
  }
  const version = String(next);
  await tx.organizationSetting.upsert({
    where: { organizationId_key: { organizationId: orgId, key: APP_POLICY_VERSION_SETTING_KEY } },
    create: { organizationId: orgId, key: APP_POLICY_VERSION_SETTING_KEY, value: version },
    update: { value: version },
  });
  return version;
}
