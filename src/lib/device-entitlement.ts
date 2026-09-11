// ─── Device Entitlement (V1 commercial) ────────────────────────────────────
// Server-authoritative device limit enforcement, wired onto the EXISTING
// checkDeviceLimit()/activeDeviceCount infrastructure (no new counting).
//
//   MANAGED:     entitlement = active subscription snapshot (deviceQuantity)
//                falling back to PlanPricing/Plan limits. Enrollment is
//                rejected when the authoritative active-device count has
//                reached the entitlement.
//   CUSTOMER_DB: ALWAYS unlimited — this function can never reject a
//                CUSTOMER_DB organization, regardless of device count.
//   PRIVATE:     legacy self-hosted path — unlimited (Plan.maxDevices <= 0
//                semantics preserved; no V1 enforcement is introduced here).
//
// Callers (server-side enforcement points, never UI):
//   - POST /api/device-claims/[id]/approve   (the authoritative enrollment act)
//   - POST /api/devices                      (manual admin device creation)
//
// The count source is Organization.activeDeviceCount, maintained by the
// existing lease-guarded sync-device-count job — this keeps enforcement and
// the billing UI consistent without per-request scans.

import { db } from '@/lib/db';
import { getOrganizationDeploymentMode } from '@/lib/deployment-mode';
import { checkDeviceLimit } from '@/lib/subscription';
import type { DeploymentMode } from '@/lib/deployment-mode';

export interface DeviceEntitlement {
  mode: DeploymentMode;
  allowed: boolean;
  currentCount: number;
  limit: number | null; // null = unlimited
  reason?: string;
}

/**
 * Decide whether the organization may add ONE more active device.
 * Fails CLOSED for unresolvable modes (isDeploymentMode contract).
 */
export async function checkDeviceEntitlement(organizationId: string): Promise<DeviceEntitlement> {
  const mode = await getOrganizationDeploymentMode(organizationId);

  // Customer Database and legacy PRIVATE deployments are NEVER capped.
  if (mode !== 'MANAGED') {
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { activeDeviceCount: true },
    });
    return { mode, allowed: true, currentCount: org?.activeDeviceCount ?? 0, limit: null };
  }

  // MANAGED — resolve the entitlement ceiling:
  //   1) active subscription snapshot deviceQuantity (purchased terms)
  //   2) active subscription plan.maxDevices
  //   3) no subscription → the legacy getPlanLimits() fallback
  //      (plan defaults / Free limits — NOT unlimited)
  const { getActiveSubscription, checkDeviceLimit } = await import('@/lib/subscription');
  const sub = await getActiveSubscription(organizationId);
  const snapshotQty = sub?.deviceQuantity ?? null;
  const planMax = sub?.plan.maxDevices ?? null;

  // The effective ceiling is the subscription snapshot when present; then the
  // subscription plan's maxDevices (<= 0 = unlimited).
  const effectiveLimit =
    snapshotQty !== null
      ? snapshotQty
      : planMax !== null
        ? (planMax > 0 ? planMax : null)
        : undefined; // undefined → no subscription, delegate to legacy path

  if (effectiveLimit === undefined) {
    // Legacy fallback — reuse the existing check semantics exactly.
    const legacy = await checkDeviceLimit(organizationId);
    return {
      mode,
      allowed: legacy.allowed,
      currentCount: legacy.currentCount,
      limit: legacy.maxDevices > 0 ? legacy.maxDevices : null,
      reason: legacy.allowed ? undefined : `Device limit reached (${legacy.currentCount}/${legacy.maxDevices}).`,
    };
  }

  if (effectiveLimit === null) {
    const org = await db.organization.findUnique({
      where: { id: organizationId },
      select: { activeDeviceCount: true },
    });
    return { mode, allowed: true, currentCount: org?.activeDeviceCount ?? 0, limit: null };
  }

  // Reuse the EXISTING check (activeDeviceCount vs limit) — same semantics,
  // same count source, now actually enforced.
  const legacy = await checkDeviceLimit(organizationId);
  return {
    mode,
    allowed: legacy.allowed && legacy.currentCount < effectiveLimit,
    currentCount: legacy.currentCount,
    limit: effectiveLimit,
    reason: legacy.allowed && legacy.currentCount >= effectiveLimit
      ? `Device entitlement reached (${legacy.currentCount}/${effectiveLimit}). Increase the subscription's device quantity to enroll more devices.`
      : undefined,
  };
}
