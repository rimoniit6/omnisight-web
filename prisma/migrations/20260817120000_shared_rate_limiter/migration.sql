-- Shared topology-independent rate limiter (Phase R1).
-- Token-bucket counters keyed by `label:identifier`; the atomic upsert in
-- src/lib/rate-limit.ts serializes concurrent requests on the row lock.

CREATE TABLE "RateLimitCounter" (
    "key" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "lastRefill" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("key")
);
