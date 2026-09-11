-- V1 Commercial Pricing + Purchase Request (additive, forward-only, non-destructive)
-- Reuses the existing BillingPeriod enum. PRIVATE deployment mode is NOT
-- seeded and must never receive PlanPricing rows (legacy self-hosted path).

-- ── PlanPricing ─────────────────────────────────────────────────────────────
CREATE TABLE "PlanPricing" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "deploymentMode" "DeploymentMode" NOT NULL,
    "billingPeriod" "BillingPeriod" NOT NULL,
    "basePrice" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "includedDevices" INTEGER NOT NULL DEFAULT 5,
    "additionalDevicePrice" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanPricing_pkey" PRIMARY KEY ("id")
);

-- ── Offer ───────────────────────────────────────────────────────────────────
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "discountType" TEXT NOT NULL,
    "discountValue" DOUBLE PRECISION NOT NULL,
    "isFree" BOOLEAN NOT NULL DEFAULT false,
    "freeTrialDays" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "planId" TEXT,
    "deploymentMode" "DeploymentMode",
    "billingPeriod" "BillingPeriod",
    "pricingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- ── PurchaseRequest ─────────────────────────────────────────────────────────
CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL,
    "requestNumber" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT,
    "notes" TEXT,
    "planId" TEXT NOT NULL,
    "deploymentMode" "DeploymentMode" NOT NULL,
    "billingPeriod" "BillingPeriod" NOT NULL,
    "deviceQuantity" INTEGER,
    "basePrice" DOUBLE PRECISION NOT NULL,
    "deviceCharge" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "finalPrice" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BDT',
    "offerId" TEXT,
    "offerName" TEXT,
    "priceSnapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "statusHistory" JSONB,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "paymentVerifiedById" TEXT,
    "paymentVerifiedAt" TIMESTAMP(3),
    "paymentReference" TEXT,
    "activatedSubscriptionId" TEXT,
    "activatedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id")
);

-- ── Subscription commercial snapshot columns (additive, nullable) ──────────
ALTER TABLE "Subscription" ADD COLUMN     "billingPeriod" "BillingPeriod",
ADD COLUMN     "deviceQuantity" INTEGER,
ADD COLUMN     "deploymentModeSnapshot" "DeploymentMode",
ADD COLUMN     "priceSnapshot" JSONB;

-- ── Foreign keys ────────────────────────────────────────────────────────────
ALTER TABLE "PlanPricing" ADD CONSTRAINT "PlanPricing_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_pricingId_fkey" FOREIGN KEY ("pricingId") REFERENCES "PlanPricing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "PlanPricing_planId_deploymentMode_billingPeriod_key" ON "PlanPricing"("planId", "deploymentMode", "billingPeriod");
CREATE INDEX "PlanPricing_planId_isActive_idx" ON "PlanPricing"("planId", "isActive");
CREATE INDEX "PlanPricing_isActive_idx" ON "PlanPricing"("isActive");
CREATE INDEX "Offer_isActive_startsAt_endsAt_idx" ON "Offer"("isActive", "startsAt", "endsAt");
CREATE INDEX "Offer_planId_idx" ON "Offer"("planId");
CREATE UNIQUE INDEX "PurchaseRequest_requestNumber_key" ON "PurchaseRequest"("requestNumber");
CREATE INDEX "PurchaseRequest_status_createdAt_idx" ON "PurchaseRequest"("status", "createdAt");
CREATE INDEX "PurchaseRequest_contactEmail_idx" ON "PurchaseRequest"("contactEmail");
CREATE INDEX "PurchaseRequest_planId_idx" ON "PurchaseRequest"("planId");
CREATE UNIQUE INDEX "PurchaseRequest_activatedSubscriptionId_key" ON "PurchaseRequest"("activatedSubscriptionId");
