-- ── PurchaseRequest manual payment record (additive, nullable) ─────────────
-- Captured at payment verification (§10): method, amount received, payment
-- date and note. The price snapshot columns stay untouched — the requested
-- price remains immutable; paymentAmount is what was actually received.
ALTER TABLE "PurchaseRequest" ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "paymentAmount" DOUBLE PRECISION,
ADD COLUMN     "paymentDate" TIMESTAMP(3),
ADD COLUMN     "paymentNote" TEXT;

-- Reverse FK for the activation chain (request → subscription → org).
ALTER TABLE "PurchaseRequest" ADD CONSTRAINT "PurchaseRequest_activatedSubscriptionId_fkey" FOREIGN KEY ("activatedSubscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;
