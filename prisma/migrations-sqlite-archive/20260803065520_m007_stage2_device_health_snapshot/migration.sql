-- CreateTable
CREATE TABLE "DeviceHealthSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "ts" DATETIME NOT NULL,
    "cpuPct" INTEGER,
    "ramPct" INTEGER,
    "diskFreeGB" INTEGER,
    "batteryPct" INTEGER,
    "network" TEXT,
    "osVersion" TEXT,
    "patches" TEXT,
    "avName" TEXT,
    "avEnabled" BOOLEAN,
    "agentMemMB" INTEGER,
    "agentUptimeS" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeviceHealthSnapshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DeviceHealthSnapshot_deviceId_ts_idx" ON "DeviceHealthSnapshot"("deviceId", "ts");
