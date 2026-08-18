-- ============================================================
-- BASELINE RECONCILIATION (phase 3 hardening)
--
-- `_ok` is a full snapshot of the current schema. On a FRESH
-- database it historically FAILED because 0001_init (and the
-- intermediate stage migrations) already created these tables,
-- so CREATE TABLE collided. `_ok` has never applied successfully
-- anywhere (no checksum is anchored), so making it deterministic
-- is the safe reconciliation: drop every table it is about to
-- recreate, then rebuild the current schema from scratch.
--
-- Tables are empty at this point on a fresh deploy, so drop
-- order is irrelevant. Existing databases are unaffected (they
-- are db-push managed and never run migrations).
-- ============================================================
DROP TABLE IF EXISTS "Organization";
DROP TABLE IF EXISTS "Department";
DROP TABLE IF EXISTS "Employee";
DROP TABLE IF EXISTS "Device";
DROP TABLE IF EXISTS "Activity";
DROP TABLE IF EXISTS "MonitoringPolicy";
DROP TABLE IF EXISTS "Notification";
DROP TABLE IF EXISTS "Alert";
DROP TABLE IF EXISTS "AuditLog";
DROP TABLE IF EXISTS "Report";
DROP TABLE IF EXISTS "AiInsight";
DROP TABLE IF EXISTS "AppUser";
DROP TABLE IF EXISTS "SystemSetting";
DROP TABLE IF EXISTS "AgentRegistration";
DROP TABLE IF EXISTS "AgentToken";
DROP TABLE IF EXISTS "Screenshot";
DROP TABLE IF EXISTS "AppListEntry";
DROP TABLE IF EXISTS "UsbEvent";
DROP TABLE IF EXISTS "Anomaly";
DROP TABLE IF EXISTS "Consent";
DROP TABLE IF EXISTS "ConsentLog";
DROP TABLE IF EXISTS "Project";
DROP TABLE IF EXISTS "ProjectMember";
DROP TABLE IF EXISTS "TimeEntry";
DROP TABLE IF EXISTS "SentimentRecord";
-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "language" TEXT NOT NULL DEFAULT 'en',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "maxSeats" INTEGER NOT NULL DEFAULT 50,
    "currentSeats" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "managerId" TEXT,
    CONSTRAINT "Department_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Department_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "avatar" TEXT,
    "designation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "joinDate" DATETIME,
    "leaveDate" DATETIME,
    "organizationId" TEXT NOT NULL,
    "departmentId" TEXT,
    "agentPassword" TEXT,
    "agentApproved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Employee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "hostname" TEXT,
    "operatingSystem" TEXT,
    "osVersion" TEXT,
    "processor" TEXT,
    "memory" TEXT,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "agentVersion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'online',
    "lastHeartbeat" DATETIME,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT,
    "registeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Device_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Device_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "url" TEXT,
    "applicationName" TEXT,
    "category" TEXT,
    "duration" INTEGER NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Activity_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Activity_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MonitoringPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "screenshotEnabled" BOOLEAN NOT NULL DEFAULT false,
    "screenshotFrequency" INTEGER NOT NULL DEFAULT 10,
    "screenshotRetentionDays" INTEGER NOT NULL DEFAULT 30,
    "appTrackingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "websiteTrackingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "idleDetectionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "idleTimeoutMinutes" INTEGER NOT NULL DEFAULT 5,
    "workingHoursOnly" BOOLEAN NOT NULL DEFAULT true,
    "workStartTime" TEXT NOT NULL DEFAULT '09:00',
    "workEndTime" TEXT NOT NULL DEFAULT '18:00',
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MonitoringPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'unread',
    "actionUrl" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" DATETIME,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" TEXT,
    "metadata" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Alert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "description" TEXT NOT NULL,
    "userId" TEXT,
    "ipAddress" TEXT,
    "metadata" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'pdf',
    "status" TEXT NOT NULL DEFAULT 'completed',
    "periodStart" DATETIME,
    "periodEnd" DATETIME,
    "data" TEXT,
    "filePath" TEXT,
    "organizationId" TEXT NOT NULL,
    "generatedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Report_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiInsight" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL,
    "category" TEXT,
    "confidence" REAL DEFAULT 0.0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "actionTaken" TEXT,
    "metadata" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AiInsight_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password" TEXT,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "avatar" TEXT,
    "organizationId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLogin" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AppUser_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "category" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentRegistration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "operatingSystem" TEXT,
    "osVersion" TEXT,
    "processor" TEXT,
    "memory" TEXT,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "agentVersion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "deviceName" TEXT,
    "rejectionReason" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRegistration_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AgentRegistration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentToken_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Screenshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/png',
    "width" INTEGER,
    "height" INTEGER,
    "appWindow" TEXT,
    "ocrText" TEXT,
    "aiAnalysis" TEXT,
    "blurScore" REAL,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flagReason" TEXT,
    "organizationId" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Screenshot_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppListEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "appName" TEXT NOT NULL,
    "executableName" TEXT,
    "category" TEXT,
    "listType" TEXT NOT NULL,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UsbEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "deviceName" TEXT,
    "vendorName" TEXT,
    "serialNumber" TEXT,
    "filePath" TEXT,
    "employeeId" TEXT,
    "deviceId" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Anomaly" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'detected',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "score" REAL NOT NULL DEFAULT 0.0,
    "confidence" REAL NOT NULL DEFAULT 0.0,
    "employeeId" TEXT,
    "deviceId" TEXT,
    "metadata" TEXT,
    "aiAnalysis" TEXT,
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Anomaly_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Anomaly_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Anomaly_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "consentType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "grantedAt" DATETIME,
    "revokedAt" DATETIME,
    "expiresAt" DATETIME,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "consentVersion" TEXT NOT NULL DEFAULT 'v1',
    "notes" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Consent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Consent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ConsentLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "consentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "performedBy" TEXT,
    "ipAddress" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsentLog_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "Consent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "startDate" DATETIME,
    "deadline" DATETIME,
    "estimatedHours" REAL NOT NULL DEFAULT 0.0,
    "color" TEXT NOT NULL DEFAULT '#10b981',
    "tags" TEXT,
    "budgetType" TEXT,
    "hourlyRate" REAL,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "departmentId" TEXT,
    CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Project_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "hoursPerWeek" REAL NOT NULL DEFAULT 40.0,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" DATETIME,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectMember_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProjectMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "hours" REAL NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TimeEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TimeEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SentimentRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT NOT NULL,
    "score" REAL NOT NULL DEFAULT 50.0,
    "mood" TEXT NOT NULL DEFAULT 'neutral',
    "signals" TEXT,
    "insight" TEXT,
    "riskFactors" TEXT,
    "recommendation" TEXT,
    "periodStart" DATETIME NOT NULL,
    "periodEnd" DATETIME NOT NULL,
    "aiProviderUsed" TEXT,
    "aiModel" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SentimentRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SentimentRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeId_key" ON "Employee"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeId_organizationId_key" ON "Employee"("employeeId", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_email_key" ON "AppUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRegistration_employeeId_key" ON "AgentRegistration"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentToken_token_key" ON "AgentToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_employeeId_key" ON "ProjectMember"("projectId", "employeeId");
