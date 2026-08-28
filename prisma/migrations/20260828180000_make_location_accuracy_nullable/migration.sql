-- AlterTable: Make accuracy nullable for IP-based fallback locations.
-- Native (GPS) locations retain their accuracy value; IP-based locations
-- receive NULL to indicate "no reliable accuracy metric available."
ALTER TABLE "LocationEvent" ALTER COLUMN "accuracy" DROP NOT NULL;
