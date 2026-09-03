-- Phase 4 — WorkDaySummary (additive, org-scoped daily rollup)
-- One row per (organizationId, employeeId, workDate); workDate is the
-- YYYY-MM-DD calendar day in the ORGANIZATION's timezone. Raw Activity rows
-- remain authoritative; this is a deterministic, rebuildable projection for
-- dashboard/report consumption. No existing table or row is modified.

CREATE TABLE "WorkDaySummary" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" TEXT NOT NULL,
    "productiveSeconds" INTEGER NOT NULL DEFAULT 0,
    "neutralSeconds" INTEGER NOT NULL DEFAULT 0,
    "unproductiveSeconds" INTEGER NOT NULL DEFAULT 0,
    "idleSeconds" INTEGER NOT NULL DEFAULT 0,
    "activeSeconds" INTEGER NOT NULL DEFAULT 0,
    "workingSeconds" INTEGER NOT NULL DEFAULT 0,
    "outsideHoursSeconds" INTEGER NOT NULL DEFAULT 0,
    "breakSeconds" INTEGER NOT NULL DEFAULT 0,
    "activityCount" INTEGER NOT NULL DEFAULT 0,
    "websiteActivityCount" INTEGER NOT NULL DEFAULT 0,
    "applicationActivityCount" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WorkDaySummary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkDaySummary_organizationId_employeeId_workDate_key"
    ON "WorkDaySummary"("organizationId", "employeeId", "workDate");

CREATE INDEX "WorkDaySummary_organizationId_workDate_idx"
    ON "WorkDaySummary"("organizationId", "workDate");

CREATE INDEX "WorkDaySummary_employeeId_workDate_idx"
    ON "WorkDaySummary"("employeeId", "workDate");

ALTER TABLE "WorkDaySummary" ADD CONSTRAINT "WorkDaySummary_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkDaySummary" ADD CONSTRAINT "WorkDaySummary_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
