import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireActiveSessionOrg, apiError } from '@/lib/api';
import { parsePlanFeatures } from '@/lib/subscription';
import { resolveActorDbRole, roleLevel } from '@/lib/org-members';
import { log, requestContext } from '@/lib/logger';

const MONTH_DAYS = 30;
const YEAR_DAYS = 365;
const INVOICE_DUE_DAYS = 7;

function serializeSubscription(
  sub: {
    id: string;
    status: string;
    startDate: Date;
    endDate: Date | null;
    trialEndDate: Date | null;
    plan: {
      id: string;
      name: string;
      currency: string;
      priceMonthly: number;
      priceYearly: number | null;
      maxDevices: number;
      retentionDays: number;
      features: unknown;
      isSelfHosted: boolean;
    };
  },
  orgTrialEndsAt: Date | null
) {
  return {
    id: sub.id,
    status: sub.status,
    startDate: sub.startDate.toISOString(),
    endDate: sub.endDate ? sub.endDate.toISOString() : null,
    trialEndDate: sub.trialEndDate ? sub.trialEndDate.toISOString() : null,
    trialEndsAt: orgTrialEndsAt ? orgTrialEndsAt.toISOString() : null,
    plan: {
      id: sub.plan.id,
      name: sub.plan.name,
      currency: sub.plan.currency,
      priceMonthly: sub.plan.priceMonthly,
      priceYearly: sub.plan.priceYearly,
      maxDevices: sub.plan.maxDevices,
      retentionDays: sub.plan.retentionDays,
      features: parsePlanFeatures(sub.plan.features),
      isSelfHosted: sub.plan.isSelfHosted,
    },
  };
}

// GET /api/organizations/[orgId]/subscription
// Return the org's CURRENT subscription with its plan, plus trial metadata.
// Org-bound session (enforced via requireActiveSessionOrg). Super Admin can
// inspect other orgs through the same session check.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId } = await params;

    // Verify the caller is an authenticated member of the org (org status
    // active enforced). Super Admin bypasses the membership requirement.
    const session = await requireActiveSessionOrg(req, { allowGlobal: false });
    if (!session.ok) {
      return apiError(session.status === 401 ? 'Unauthorized. Please sign in.' : 'Insufficient permissions', session.status);
    }
    if (session.organizationId !== null && session.organizationId !== orgId) {
      return apiError('Forbidden: not a member of this organization', 403);
    }
    if (session.organizationId === null && session.role !== 'super_admin') {
      return apiError('Forbidden', 403);
    }

    const org = await db.organization.findUnique({
      where: { id: orgId },
      select: { trialEndsAt: true, activeDeviceCount: true },
    });
    if (!org) return apiError('Organization not found', 404);

    // Current subscription = org.subscriptionId pointer, else the most recent
    // active/pending one.
    const current = await db.subscription.findFirst({
      where: {
        organizationId: orgId,
        OR: [{ status: 'ACTIVE' }, { status: 'PENDING' }, { status: 'EXPIRED' }],
      },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });

    // Remaining trial days (0 when none/expired).
    const trialRemainingDays = org.trialEndsAt
      ? Math.max(0, Math.ceil((org.trialEndsAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : 0;

    return NextResponse.json({
      subscription: current ? serializeSubscription(current, org.trialEndsAt) : null,
      isOnTrial: org.trialEndsAt !== null && org.trialEndsAt > new Date(),
      trialEndsAt: org.trialEndsAt ? org.trialEndsAt.toISOString() : null,
      trialRemainingDays,
      activeDeviceCount: org.activeDeviceCount,
    });
  } catch (error) {
    log.error('api.org.subscription.get', { error: String(error) }, requestContext(req));
    return apiError('Failed to fetch subscription', 500);
  }
}

// POST /api/organizations/[orgId]/subscription
// Subscribe (or re-subscribe) an org to a plan via manual payment. Creates a
// PENDING subscription + PENDING invoice. Org Admin+.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> }
) {
  try {
    const { orgId } = await params;

    const session = await requireActiveSessionOrg(req, { allowGlobal: false });
    if (!session.ok) {
      return apiError(session.status === 401 ? 'Unauthorized. Please sign in.' : 'Insufficient permissions', session.status);
    }
    if (session.organizationId !== orgId) {
      return apiError('Forbidden: not a member of this organization', 403);
    }
    // Org Admin or higher. Authoritative check is the DB membership role
    // (never the JWT), so stale/forged roles can't elevate. super_admin is
    // platform authority and may subscribe any org.
    const actorRole = await resolveActorDbRole(req, orgId);
    if (!actorRole) return apiError('Insufficient permissions', 403);
    if (actorRole !== 'super_admin' && roleLevel(actorRole) < roleLevel('org_admin')) {
      return apiError('Only an organization admin can subscribe', 403);
    }

    const org = await db.organization.findUnique({ where: { id: orgId } });
    if (!org) return apiError('Organization not found', 404);

    const body = (await req.json().catch(() => ({}))) as {
      planId?: unknown;
      billingPeriod?: unknown;
    };
    const planId = typeof body.planId === 'string' ? body.planId : '';
    const billingPeriod = body.billingPeriod === 'YEARLY' ? 'YEARLY' : body.billingPeriod === 'MONTHLY' ? 'MONTHLY' : null;

    if (!planId) return apiError('planId is required', 400);
    if (!billingPeriod) return apiError("billingPeriod must be 'MONTHLY' or 'YEARLY'", 400);

    const plan = await db.plan.findUnique({ where: { id: planId } });
    if (!plan || !plan.isActive) return apiError('Selected plan is not available', 400);

    // Reject if the org already has an ACTIVE or PENDING subscription.
    const existing = await db.subscription.findFirst({
      where: {
        organizationId: orgId,
        status: { in: ['ACTIVE', 'PENDING'] },
      },
      select: { id: true, status: true },
    });
    if (existing) {
      return NextResponse.json(
        {
          error: 'This organization already has an active or pending subscription. Please resolve it before subscribing again.',
          code: 'ALREADY_ACTIVE',
          existingStatus: existing.status,
        },
        { status: 409 }
      );
    }

    // Atomic creation: sequential invoice number + subscription + invoice.
    const now = new Date();
    const endDate = new Date(now);
    endDate.setDate(endDate.getDate() + (billingPeriod === 'YEARLY' ? YEAR_DAYS : MONTH_DAYS));
    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + INVOICE_DUE_DAYS);

    const amount = billingPeriod === 'YEARLY' && plan.priceYearly != null ? plan.priceYearly : plan.priceMonthly;

    const created = await db.$transaction(async (tx) => {
      // Sequential invoice number: INV-YYYY-XXXX
      const year = now.getFullYear();
      const last = await tx.invoice.findFirst({
        where: { invoiceNumber: { startsWith: `INV-${year}-` } },
        orderBy: { createdAt: 'desc' },
      });
      const lastSeq = last ? parseInt(last.invoiceNumber.split('-').pop() ?? '0', 10) || 0 : 0;
      const invoiceNumber = `INV-${year}-${String(lastSeq + 1).padStart(4, '0')}`;

      const subscription = await tx.subscription.create({
        data: {
          organizationId: orgId,
          planId: plan.id,
          status: 'PENDING',
          startDate: now,
          endDate,
          notes: `Manual subscription to ${plan.name} (${billingPeriod})`,
        },
      });

      const invoice = await tx.invoice.create({
        data: {
          subscriptionId: subscription.id,
          organizationId: orgId,
          invoiceNumber,
          amount,
          currency: plan.currency || 'BDT',
          status: 'PENDING',
          dueDate,
          notes: `Subscription to ${plan.name} (${billingPeriod})`,
        },
      });

      // Point the org's current-subscription pointer at the new subscription.
      await tx.organization.update({
        where: { id: orgId },
        data: { subscriptionId: subscription.id },
      });

      // Phase 2 §21: audit the subscription request (was missing).
      await tx.auditLog.create({
        data: {
          action: 'create',
          resource: 'subscription',
          resourceId: subscription.id,
          description: `${actorRole} requested ${billingPeriod} subscription to ${plan.name} for org (${invoiceNumber})`,
          userId: session.userId,
          organizationId: orgId,
        },
      });

      return { subscription, invoice };
    });

    return NextResponse.json(
      {
        success: true,
        subscriptionId: created.subscription.id,
        invoiceId: created.invoice.id,
        invoiceNumber: created.invoice.invoiceNumber,
        status: created.subscription.status,
      },
      { status: 201 }
    );
  } catch (error) {
    log.error('api.org.subscription.post', { error: String(error) }, requestContext(req));
    return apiError('Failed to create subscription', 500);
  }
}
