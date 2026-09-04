// OmniSight Subscription Utilities
// Server-side helpers for plan/subscription checks. Used by API routes and
// the agent config endpoint.

import { db } from '@/lib/db';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse the Plan.features JSON column into a string array.
 * Returns [] on null/invalid values — never throws.
 */
export function parsePlanFeatures(features: unknown): string[] {
  if (!features) return [];
  if (Array.isArray(features)) return features.map(String);
  if (typeof features === 'string') {
    try {
      const parsed = JSON.parse(features);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Check whether a subscription is currently considered active.
 * Active means status=ACTIVE AND (endDate is null OR endDate > now).
 */
function isActive(sub: { status: string; endDate: Date | null }): boolean {
  if (sub.status !== 'ACTIVE') return false;
  if (sub.endDate && sub.endDate <= new Date()) return false;
  return true;
}

/**
 * Check whether an organization is within a valid trial window.
 */
export function hasValidTrial(org: { trialEndsAt: Date | null }): boolean {
  return org.trialEndsAt !== null && org.trialEndsAt > new Date();
}

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Return the active subscription (with plan) for an organization, or null.
 * An expired endDate is treated as inactive even if status is still ACTIVE
 * (the cron job catches up asynchronously).
 */
export async function getActiveSubscription(organizationId: string) {
  const sub = await db.subscription.findFirst({
    where: {
      organizationId,
      status: 'ACTIVE',
      OR: [
        { endDate: null },
        { endDate: { gt: new Date() } },
      ],
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });

  return sub || null;
}

/**
 * Check whether an organization has a specific feature enabled by its
 * active subscription plan. Returns false when there is no subscription
 * or the plan does not include the feature. Trial orgs are treated as
 * having full access to all features.
 */
export async function hasFeature(organizationId: string, featureKey: string): Promise<boolean> {
  // Trial orgs get full features
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { trialEndsAt: true },
  });
  if (org && hasValidTrial(org)) return true;

  const sub = await getActiveSubscription(organizationId);
  if (!sub) return false;

  const features = parsePlanFeatures(sub.plan.features);
  return features.includes(featureKey);
}

/**
 * Return the plan limits for an organization. Falls back to sensible
 * defaults when there is no active subscription.
 */
export async function getPlanLimits(
  organizationId: string,
): Promise<{ maxDevices: number; retentionDays: number; planName: string }> {
  const sub = await getActiveSubscription(organizationId);
  if (!sub) {
    return { maxDevices: 5, retentionDays: 90, planName: 'Free' };
  }
  return {
    maxDevices: sub.plan.maxDevices,
    retentionDays: sub.plan.retentionDays,
    planName: sub.plan.name,
  };
}

/**
 * Check whether adding another device would exceed the plan limit.
 * Returns the current count, max limit, and whether it is allowed.
 */
export async function checkDeviceLimit(
  organizationId: string,
): Promise<{ allowed: boolean; currentCount: number; maxDevices: number }> {
  const limits = await getPlanLimits(organizationId);
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { activeDeviceCount: true },
  });
  const currentCount = org?.activeDeviceCount ?? 0;

  // maxDevices <= 0 means unlimited
  const allowed = limits.maxDevices <= 0 || currentCount < limits.maxDevices;

  return { allowed, currentCount, maxDevices: limits.maxDevices };
}

/**
 * Determine whether an organization has a valid subscription or trial.
 * Returns an object indicating the access state and any trial metadata.
 */
export async function getOrgAccessState(
  organizationId: string,
): Promise<{
  hasAccess: boolean;
  isTrial: boolean;
  isSubscribed: boolean;
  planName: string;
  trialEndsAt: Date | null;
}> {
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { trialEndsAt: true },
  });

  if (org && hasValidTrial(org)) {
    return {
      hasAccess: true,
      isTrial: true,
      isSubscribed: false,
      planName: 'Trial',
      trialEndsAt: org.trialEndsAt,
    };
  }

  const sub = await getActiveSubscription(organizationId);
  if (sub) {
    return {
      hasAccess: true,
      isTrial: false,
      isSubscribed: true,
      planName: sub.plan.name,
      trialEndsAt: null,
    };
  }

  // No subscription and no trial — check if there is a legacy org with
  // no subscription (pre-SaaS). Give read-only access so existing orgs
  // are not locked out immediately after migration.
  return {
    hasAccess: false,
    isTrial: false,
    isSubscribed: false,
    planName: 'None',
    trialEndsAt: null,
  };
}
