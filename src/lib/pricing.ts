// ─── V1 Central Pricing Calculator ─────────────────────────────────────────
// THE single source of truth for commercial price calculation:
//   landing page · public pricing · purchase request · Super Admin review ·
//   invoice creation · price validation.
// UI components must NEVER duplicate pricing formulas — they call
// resolvePrice (server) or display the resolver's breakdown via /api/plans
// and /api/pricing/preview.
//
// Precedence rules (deterministic, never ambiguous):
//   1. A PlanPricing row that is active for the exact (plan, mode, period)
//      is authoritative. Without one the resolver throws (legacy Plan
//      columns are NOT used as fallback).
//   2. At most ONE offer is applied. When several active+valid offers match,
//      the winner is the one with the LARGEST effective discount (percentage
//      offers valued against the base amount, fixed offers by absolute
//      amount), ties broken by earliest createdAt then lexicographic id.
//   3. Final price is clamped at >= 0 (an offer can never produce a negative
//      price). isFree offers resolve to 0.
//
// Both deployment modes (MANAGED and CUSTOMER_DB) use device-based
// entitlement: includedDevices + additionalDevicePrice per extra device.
// There are no "unlimited devices" in the V1 commercial model.

import { db } from '@/lib/db';
import type { Prisma } from '@prisma/client';

export type PricingDeploymentMode = 'MANAGED' | 'CUSTOMER_DB';
export type PricingBillingPeriod = 'MONTHLY' | 'YEARLY';

export const V1_PRICING_MODES: readonly PricingDeploymentMode[] = ['MANAGED', 'CUSTOMER_DB'];

export function isPricingMode(value: unknown): value is PricingDeploymentMode {
  return value === 'MANAGED' || value === 'CUSTOMER_DB';
}

export function isPricingPeriod(value: unknown): value is PricingBillingPeriod {
  return value === 'MONTHLY' || value === 'YEARLY';
}

export interface PricingOfferInput {
  id: string;
  name: string;
  discountType: string;
  discountValue: number;
  isFree: boolean;
}

export interface PriceBreakdown {
  planId: string;
  planName: string;
  deploymentMode: PricingDeploymentMode;
  billingPeriod: PricingBillingPeriod;
  currency: string;
  basePrice: number;
  deviceQuantity: number;
  includedDevices: number;
  additionalDevicePrice: number;
  extraDevices: number;
  deviceCharge: number;
  offerId: string | null;
  offerName: string | null;
  discountAmount: number;
  finalPrice: number;
  pricingSource: 'PRICING_CONFIG' | 'LEGACY_PLAN';
}

interface OfferRow {
  id: string;
  name: string;
  discountType: string;
  discountValue: number;
  isFree: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  planId: string | null;
  deploymentMode: string | null;
  billingPeriod: string | null;
  pricingId: string | null;
  createdAt: Date;
}

function offerMatches(offer: OfferRow, ctx: { planId: string; deploymentMode: PricingDeploymentMode; billingPeriod: PricingBillingPeriod; pricingId: string | null }): boolean {
  if (offer.planId !== null && offer.planId !== ctx.planId) return false;
  if (offer.deploymentMode !== null && offer.deploymentMode !== ctx.deploymentMode) return false;
  if (offer.billingPeriod !== null && offer.billingPeriod !== ctx.billingPeriod) return false;
  if (offer.pricingId !== null && offer.pricingId !== ctx.pricingId) return false;
  return true;
}

function offerValidNow(offer: OfferRow, now: Date): boolean {
  if (offer.startsAt && offer.startsAt > now) return false;
  if (offer.endsAt && offer.endsAt <= now) return false;
  return true;
}

/** Effective discount amount of an offer against a base amount. */
function effectiveDiscount(offer: OfferRow, baseAmount: number): number {
  if (offer.isFree) return baseAmount; // full discount → price 0
  if (offer.discountType === 'PERCENTAGE') {
    return round2((Math.min(Math.max(offer.discountValue, 0), 100) / 100) * baseAmount);
  }
  if (offer.discountType === 'FIXED') {
    return Math.min(Math.max(offer.discountValue, 0), baseAmount);
  }
  return 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Select the single winning offer among candidates. Largest effective
 * discount wins; ties break by earliest createdAt, then id (deterministic).
 */
export function selectOffer(
  candidates: OfferRow[],
  baseAmount: number,
): OfferRow | null {
  let winner: OfferRow | null = null;
  let winnerAmount = -1;
  for (const offer of candidates) {
    const amount = effectiveDiscount(offer, baseAmount);
    if (
      amount > winnerAmount ||
      (amount === winnerAmount && winner !== null && (offer.createdAt.getTime() < winner.createdAt.getTime() ||
        (offer.createdAt.getTime() === winner.createdAt.getTime() && offer.id < winner.id)))
    ) {
      winner = offer;
      winnerAmount = amount;
    }
  }
  return winner;
}

export interface ResolvePriceArgs {
  planId: string;
  deploymentMode: PricingDeploymentMode;
  billingPeriod: PricingBillingPeriod;
  /** Device quantity for both MANAGED and CUSTOMER_DB deployments. */
  deviceQuantity?: number | null;
  /** Explicit offer pin (Super Admin preview). Otherwise auto-selected. */
  offerId?: string | null;
  /** When true, offers are NOT auto-applied (used for base-price previews). */
  excludeOffers?: boolean;
  now?: Date;
}

/**
 * THE pricing resolver. Reads the active PlanPricing row for the exact
 * (plan, deploymentMode, billingPeriod); falls back to legacy Plan columns
 * when no V1 pricing config exists. Applies at most one offer (§ rules above).
 */
export async function resolvePrice(args: ResolvePriceArgs): Promise<PriceBreakdown> {
  const { planId, deploymentMode, billingPeriod } = args;
  const now = args.now ?? new Date();

  if (!isPricingMode(deploymentMode)) {
    throw new Error('INVALID_DEPLOYMENT_MODE');
  }
  if (!isPricingPeriod(billingPeriod)) {
    throw new Error('INVALID_BILLING_PERIOD');
  }

  const plan = await db.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) throw new Error('PLAN_NOT_AVAILABLE');

  const pricing = await db.planPricing.findUnique({
    where: { planId_deploymentMode_billingPeriod: { planId, deploymentMode, billingPeriod } },
  });

  let basePrice: number;
  let currency: string;
  let includedDevices: number;
  let additionalDevicePrice: number;
  let pricingSource: PriceBreakdown['pricingSource'];

  if (pricing && pricing.isActive) {
    basePrice = pricing.basePrice;
    currency = pricing.currency || plan.currency;
    pricingSource = 'PRICING_CONFIG';
    includedDevices = pricing.includedDevices;
    additionalDevicePrice = pricing.additionalDevicePrice;
  } else {
    // No active PlanPricing row for this (plan, mode, period).
    // This is a configuration error — Super Admin must configure pricing
    // via Packages & Pricing before this plan can be used commercially.
    throw new Error(
      `PRICING_NOT_CONFIGURED: No active PlanPricing row for plan=${planId} mode=${deploymentMode} period=${billingPeriod}. ` +
      `Configure this in Super Admin → Packages & Pricing.`
    );
  }

  // Device pricing — both MANAGED and CUSTOMER_DB use device-based entitlement.
  const requestedQty = Math.max(0, Math.floor(args.deviceQuantity ?? 0));
  let deviceQuantity = requestedQty;
  let deviceCharge = 0;
  let extraDevices = 0;
  if (includedDevices !== null) {
    extraDevices = Math.max(0, requestedQty - includedDevices);
    deviceCharge = round2(extraDevices * additionalDevicePrice);
  }

  const baseAmount = round2(basePrice + deviceCharge);

  // Offer resolution — at most one winner.
  let offer: OfferRow | null = null;
  if (!args.excludeOffers) {
    if (args.offerId) {
      const pinned = await db.offer.findUnique({ where: { id: args.offerId } });
      if (
        pinned && pinned.isActive && offerValidNow(pinned as OfferRow, now) &&
        offerMatches(pinned as OfferRow, { planId, deploymentMode, billingPeriod, pricingId: pricing?.id ?? null })
      ) {
        offer = pinned as OfferRow;
      }
    } else {
      const candidates = await db.offer.findMany({ where: { isActive: true } });
      const matching = candidates.filter(
        (o) => offerValidNow(o, now) && offerMatches(o, { planId, deploymentMode, billingPeriod, pricingId: pricing?.id ?? null }),
      );
      offer = selectOffer(matching, baseAmount);
    }
  }

  const discountAmount = offer ? effectiveDiscount(offer, baseAmount) : 0;
  const finalPrice = Math.max(0, round2(baseAmount - discountAmount));

  return {
    planId,
    planName: plan.name,
    deploymentMode,
    billingPeriod,
    currency,
    basePrice: round2(basePrice),
    deviceQuantity,
    includedDevices,
    additionalDevicePrice,
    extraDevices,
    deviceCharge,
    offerId: offer?.id ?? null,
    offerName: offer?.name ?? null,
    discountAmount: round2(discountAmount),
    finalPrice,
    pricingSource,
  };
}

/** Snapshot shape persisted on PurchaseRequest and Subscription. */
export type PriceSnapshot = PriceBreakdown;

export function toPriceSnapshot(breakdown: PriceBreakdown): Prisma.InputJsonValue {
  return breakdown as unknown as Prisma.InputJsonValue;
}
