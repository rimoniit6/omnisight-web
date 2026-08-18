-- WorkLensAI — Remove artificial seat limit
-- The 50-seat license concept is not part of the current product model.
-- maxSeats / currentSeats existed only for the obsolete seat-usage UI and
-- enforcement; they are removed. Employee capacity is unlimited (bounded only
-- by the database/infrastructure).

ALTER TABLE "Organization" DROP COLUMN "maxSeats";
ALTER TABLE "Organization" DROP COLUMN "currentSeats";
