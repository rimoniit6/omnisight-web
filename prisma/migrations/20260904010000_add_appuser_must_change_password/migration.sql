-- Backfill AppUser.mustChangePassword (schema drift fix, Phase 1 Step 1)
-- Schema already declares `mustChangePassword Boolean @default(false)` with
-- first-login enforcement logic, but no migration ever created the column.
-- This migration synchronizes migration state with the intended schema.
ALTER TABLE "AppUser" ADD COLUMN IF NOT EXISTS "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
