-- OmniSight hardening — DeviceClaim "one pending claim per device" DB guard
-- (hardening area 2).
--
-- The claim-history model lifted the old single-row unique constraint, so
-- cross-process correctness now rests on a SELECT ... FOR UPDATE device-row
-- lock plus a careful state machine in discover/approve/cancel. This migration
-- adds a PARTIAL UNIQUE INDEX that makes the documented invariant —
--
--     One PENDING claim exists at a time per device
--
-- — a DATABASE-FACT (fail-fast) rather than a code-obligation. Pure concurrency
-- hardening: it never changes the history model, and terminal/expired claims
-- are untouched by the predicate so the history array is preserved.
--
-- NOTE on the dedupe DELETE below: the state machine is supposed to close a
-- stale pending claim (status='expired') before issuing a fresh one in the
-- same transaction, so duplicates should not exist. The delete is a
-- belt-and-suspenders migration guard for any historical drift: it expires
-- all but the NEWEST pending row per device BEFORE the index can be created.
-- It only fires on actual duplicate groups; a clean table is untouched.

DELETE FROM "DeviceClaim" a
USING "DeviceClaim" b
WHERE a."status" = 'pending'
  AND b."status" = 'pending'
  AND a."deviceId" = b."deviceId"
  AND (a."createdAt" < b."createdAt"
       OR (a."createdAt" = b."createdAt" AND a."id" < b."id"));

CREATE UNIQUE INDEX IF NOT EXISTS "DeviceClaim_one_pending_per_device"
  ON "DeviceClaim"("deviceId")
  WHERE "status" = 'pending';