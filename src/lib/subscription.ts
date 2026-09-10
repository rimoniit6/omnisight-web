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
 * The subscription states that grant the Agent operational access.
 * PAUSED and EXPIRED/CANCELLED do NOT grant access — the Agent must
 * stop collecting telemetry when the subscription is not active.
 */
const AGENT_ENTITLEMENT_STATUSES = ['ACTIVE'] as const;

/**
 * Subscription entitlement result for Agent authorization.
 * Used by validateAgentToken() and the Agent config endpoint to make a
 * single authoritative decision about whether the Agent may operate.
 */
export interface AgentEntitlement {
  /** Whether the Agent is authorized to operate (collect telemetry). */
  allowed: boolean;
  /** The current subscription status (null = no subscription). */
  subscriptionStatus: string | null;
  /** The plan name (null = no subscription). */
  planName: string | null;
  /** Human-readable reason when not allowed. */
  reason?: string;
}

/**
 * Centralized server-authoritative Agent entitlement check.
 *
 * The Agent must NEVER become the authority for subscription validity.
 * This function is the SINGLE source of truth for whether an Agent
 * attached to the given organization may continue operating.
 *
 * Resolution order (PRD §46):
 *   Authentication → Role → Organization → Organization Status →
 *   Subscription Status → Package Entitlement → Service Model
 *
 * This function covers Subscription Status and Package Entitlement.
 * Organization status is checked separately in validateAgentToken().
 *
 * Trial organizations (trialEndsAt > now) are treated as having full
 * access — same as the existing hasFeature() behavior.
 */
export async function checkAgentEntitlement(
  organizationId: string,
): Promise<AgentEntitlement> {
  // 1. Check trial — trial orgs have full access.
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { trialEndsAt: true },
  });
  if (org && hasValidTrial(org)) {
    return { allowed: true, subscriptionStatus: 'TRIAL', planName: 'Trial' };
  }

  // 2. Find the subscription (most recent, any status).
  const sub = await db.subscription.findFirst({
    where: { organizationId },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });

  if (!sub) {
    return {
      allowed: false,
      subscriptionStatus: null,
      planName: null,
      reason: 'No subscription found',
    };
  }

  // 3. Check subscription status.
  const now = new Date();
  const endDateValid = !sub.endDate || sub.endDate > now;

  if (sub.status === 'ACTIVE' && endDateValid) {
    return {
      allowed: true,
      subscriptionStatus: 'ACTIVE',
      planName: sub.plan.name,
    };
  }

  if (sub.status === 'PAUSED') {
    return {
      allowed: false,
      subscriptionStatus: 'PAUSED',
      planName: sub.plan.name,
      reason: 'Subscription is paused',
    };
  }

  if (sub.status === 'EXPIRED' || (sub.status === 'ACTIVE' && !endDateValid)) {
    return {
      allowed: false,
      subscriptionStatus: 'EXPIRED',
      planName: sub.plan.name,
      reason: 'Subscription has expired',
    };
  }

  if (sub.status === 'CANCELLED') {
    return {
      allowed: false,
      subscriptionStatus: 'CANCELLED',
      planName: sub.plan.name,
      reason: 'Subscription has been cancelled',
    };
  }

  if (sub.status === 'PENDING') {
    return {
      allowed: false,
      subscriptionStatus: 'PENDING',
      planName: sub.plan.name,
      reason: 'Subscription is pending payment verification',
    };
  }

  // Unknown status — fail closed.
  return {
    allowed: false,
    subscriptionStatus: sub.status,
    planName: sub.plan.name,
    reason: `Unknown subscription status: ${sub.status}`,
  };
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
