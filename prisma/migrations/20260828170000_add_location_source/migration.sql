-- AlterTable: Add source column to LocationEvent
-- 'native' = Windows/device GPS, 'ip' = IP-based geolocation fallback
-- Default 'ip' for backward compatibility with existing rows
ALTER TABLE "LocationEvent" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'ip';
