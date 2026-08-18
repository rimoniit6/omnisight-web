-- CreateTable
CREATE TABLE "UserDailySummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "activeSec" INTEGER NOT NULL DEFAULT 0,
    "focusSec" INTEGER NOT NULL DEFAULT 0,
    "idleSec" INTEGER NOT NULL DEFAULT 0,
    "backgroundSec" INTEGER NOT NULL DEFAULT 0,
    "sessionCount" INTEGER NOT NULL DEFAULT 0,
    "productiveSec" INTEGER NOT NULL DEFAULT 0,
    "neutralSec" INTEGER NOT NULL DEFAULT 0,
    "distractingSec" INTEGER NOT NULL DEFAULT 0,
    "topApps" TEXT,
    "topDomains" TEXT,
    "appCount" INTEGER NOT NULL DEFAULT 0,
    "websiteCount" INTEGER NOT NULL DEFAULT 0,
    "keystrokes" INTEGER NOT NULL DEFAULT 0,
    "mouseClicks" INTEGER NOT NULL DEFAULT 0,
    "contextSwitches" INTEGER NOT NULL DEFAULT 0,
    "productivity" INTEGER NOT NULL DEFAULT 0,
    "focusScore" INTEGER NOT NULL DEFAULT 0,
    "activityScore" INTEGER NOT NULL DEFAULT 0,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "burnoutScore" INTEGER NOT NULL DEFAULT 0,
    "flaggedScreenshots" INTEGER NOT NULL DEFAULT 0,
    "summaryState" TEXT NOT NULL DEFAULT 'draft',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserDailySummary_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AnalyticsJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobType" TEXT NOT NULL DEFAULT 'rollup',
    "mode" TEXT NOT NULL DEFAULT 'incremental',
    "status" TEXT NOT NULL DEFAULT 'running',
    "fromDate" DATETIME,
    "toDate" DATETIME,
    "rowsProcessed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RollupCheckpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "lastDate" DATETIME,
    "lastRunAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "UserDailySummary_date_idx" ON "UserDailySummary"("date");

-- CreateIndex
CREATE INDEX "UserDailySummary_userId_date_idx" ON "UserDailySummary"("userId", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "UserDailySummary_userId_date_key" ON "UserDailySummary"("userId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RollupCheckpoint_key_key" ON "RollupCheckpoint"("key");

-- CreateIndex
CREATE INDEX "ActivityEvent_userId_timestamp_idx" ON "ActivityEvent"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "ActivityEvent_category_timestamp_idx" ON "ActivityEvent"("category", "timestamp");

-- CreateIndex
CREATE INDEX "ActivityEvent_domain_idx" ON "ActivityEvent"("domain");

-- CreateIndex
CREATE INDEX "LoginSession_userId_loginTime_idx" ON "LoginSession"("userId", "loginTime");
