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
import { getPrismaForOrg } from '@/lib/org-db';
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

  // Device is org-owned (copied at activation) — read each ACTIVE org's
  // devices from ITS OWN database; a global platform scan would miss
  // post-cutover rows entirely. Organization.activeDeviceCount is a
  // platform-owned control-plane column — the update stays on the platform DB.
  const orgs = await db.organization.findMany({ where: { status: 'active' }, select: { id: true } });
  const activeByOrg = new Map<string, number>();
  for (const org of orgs) {
    const orgData = (await getPrismaForOrg(org.id)).client;
    // Org filter: on a shared platform client (org not yet activated) this
    // restricts the scan to THIS org's devices — otherwise every iteration
    // would count the entire platform device set for every org.
    const devices = await orgData.device.findMany({
      where: { organizationId: org.id },
      select: { status: true, lastHeartbeat: true },
    });
    let active = 0;
    for (const device of devices) {
      if (effectiveLiveStatus(device.status, device.lastHeartbeat, now) === 'online') {
        active += 1;
      }
    }
    activeByOrg.set(org.id, active);
  }

  result.activeDevices = activeByOrg.size
    ? [...activeByOrg.values()].reduce((a, b) => a + b, 0)
    : 0;

  // Persist per-org on the platform control plane (activates @updatedAt). An
  // org with zero devices stores 0 explicitly (the write path's baseline).
  try {
    for (const [orgId, count] of activeByOrg) {
      await db.organization.updateMany({
        where: { id: orgId },
        data: { activeDeviceCount: count },
      });
      result.updated += 1;
    }
  } catch (error) {
    result.errors.push(String(error));
  }

  result.organizations = activeByOrg.size;
  return result;
}
