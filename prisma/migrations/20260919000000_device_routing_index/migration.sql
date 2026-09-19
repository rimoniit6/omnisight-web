-- OmniSight hardening — Global Device Routing Index (hardening area 1).
--
-- Entity: DeviceRouting
-- Platform/control-plane: agentKey -> deviceId -> organizationId + dbMode.
--     agentKey  UNIQUE (nullable — admin-created devices may have no machine
--                       identity yet; Postgres allows multiple NULLs)
--     deviceId  UNIQUE
--     dbMode    'cloud' | 'own'  = which database holds the authoritative
--                                 Device row (platform DB vs org's own DB).
--     lastSeenAt/updatedAt       = idle-target for the daily backfill sweep.
--
-- Purpose: eliminate the "bounded scan" of up to 25 activated org databases
-- used to locate a device across custom-DB tenants. The routing index turns a
-- multi-tenant fan-out into ONE indexed platform lookup, then a single read
-- of the authoritative org database. It is write-through (upserted on device
-- creation and on every Database cutover flip) and self-heals via the daily
-- data-integrity backfill.
--
-- Note: this table has no ApiVendor/Prisma foreign-key footguns; the serial
-- id + two unique indexes are all that is needed. The Organization row it
-- references is CASCADE-deleted with its tenant.

CREATE TABLE "DeviceRouting" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "agentKey" TEXT,
    "organizationId" TEXT NOT NULL,
    "dbMode" TEXT NOT NULL DEFAULT 'cloud',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceRouting_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeviceRouting_deviceId_key" ON "DeviceRouting"("deviceId");
CREATE UNIQUE INDEX "DeviceRouting_agentKey_key" ON "DeviceRouting"("agentKey");
CREATE INDEX "DeviceRouting_organizationId_idx" ON "DeviceRouting"("organizationId");
CREATE INDEX "DeviceRouting_updatedAt_idx" ON "DeviceRouting"("updatedAt");

ALTER TABLE "DeviceRouting"
    ADD CONSTRAINT "DeviceRouting_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the index from the platform Device table (the authoritative home for
-- every org that has not cut over). Devices that only exist inside a custom
-- org database are backfilled lazily by the first lookup miss and by the
-- daily data-integrity backfill — see src/lib/device-index.ts.
INSERT INTO "DeviceRouting" ("id", "deviceId", "agentKey", "organizationId", "dbMode", "lastSeenAt", "createdAt", "updatedAt")
SELECT 'drtx_' || d."id", d."id", d."agentKey", d."organizationId", 'cloud', d."updatedAt", d."registeredAt", d."updatedAt"
FROM "Device" d
ON CONFLICT ("deviceId") DO NOTHING;