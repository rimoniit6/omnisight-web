// Device-count sync job for the SaaS layer.
//
// Keeps Organization.activeDeviceCount in sync with the real number of ACTIVE
// (heartbeat-fresh, non-lifecycle) devices so plan enforcement
// (checkDeviceLimit → maxDevices) and the billing UI read accurate numbers
// without per-request scans.
//
// The count uses the centralized presence semantics (src/lib/presence.ts +
// src/lib/device-status.ts): a device is "active" when it has a heartbeat
// within EMPLOYEE_ONLINE_THRESHOLD_MS AND is not in a lifecycle-pinned status
// (maintenance/inactive/retired). Lifecycle statuses are admin-pinned and
// never derived from heartbeats.
//
// Licensed as a lease-guarded job ('sync_device_count') from run.ts. Scheduled
// via instrumentation.ts on a ~30-minute cadence plus the hourly run.

import { db } from '@/lib/db';
import { effectiveLiveStatus } from '@/lib/presence';

export interface SyncDeviceCountResult {
  organizations: number;
  activeDevices: number;
  updated: number;
  errors: string[];
}

/**
 * Recompute activeDeviceCount for every organization from its currently-active
 * devices and persist the result. Single batched read, batched write — no
 * per-org N+1.
 *
 * @param now injection point for tests / scheduler runs.
 */
export async function syncDeviceCounts(now = new Date()): Promise<SyncDeviceCountResult> {
  const result: SyncDeviceCountResult = { organizations: 0, activeDevices: 0, updated: 0, errors: [] };

  // One batched read of every device's presence-relevant columns.
  const devices = await db.device.findMany({
    select: { organizationId: true, status: true, lastHeartbeat: true },
  });

  const activeByOrg = new Map<string, number>();
  const orgIds = new Set<string>();
  for (const device of devices) {
    orgIds.add(device.organizationId);
    if (effectiveLiveStatus(device.status, device.lastHeartbeat, now) === 'online') {
      activeByOrg.set(device.organizationId, (activeByOrg.get(device.organizationId) ?? 0) + 1);
    }
  }

  result.activeDevices = activeByOrg.size
    ? [...activeByOrg.values()].reduce((a, b) => a + b, 0)
    : 0;

  const toUpdate = [...orgIds].map((orgId) => ({
    id: orgId,
    activeDeviceCount: activeByOrg.get(orgId) ?? 0,
  }));

  // Persist per-org (activates the @updatedAt column automatically). Skipping
  // orgs not present in the device projection is correct: syncDeviceCounts only
  // writes orgs that currently have at least one Device row; an org with zero
  // devices keeps whatever count the write path left it (baseline 0).
  try {
    for (const org of toUpdate) {
      await db.organization.updateMany({
        where: { id: org.id },
        data: { activeDeviceCount: org.activeDeviceCount },
      });
      result.updated += 1;
    }
  } catch (error) {
    result.errors.push(String(error));
  }

  result.organizations = orgIds.size;
  return result;
}
