-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Activity" (
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
    CONSTRAINT "Activity_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Activity_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Activity" ("applicationName", "category", "createdAt", "deviceId", "duration", "employeeId", "id", "timestamp", "title", "type", "url") SELECT "applicationName", "category", "createdAt", "deviceId", "duration", "employeeId", "id", "timestamp", "title", "type", "url" FROM "Activity";
DROP TABLE "Activity";
ALTER TABLE "new_Activity" RENAME TO "Activity";
CREATE INDEX "Activity_employeeId_idx" ON "Activity"("employeeId");
CREATE INDEX "Activity_deviceId_idx" ON "Activity"("deviceId");
CREATE INDEX "Activity_timestamp_idx" ON "Activity"("timestamp");
CREATE INDEX "Activity_employeeId_timestamp_idx" ON "Activity"("employeeId", "timestamp");
CREATE INDEX "Activity_employeeId_category_idx" ON "Activity"("employeeId", "category");
CREATE INDEX "Activity_category_timestamp_idx" ON "Activity"("category", "timestamp");
CREATE TABLE "new_AgentRegistration" (
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
    CONSTRAINT "AgentRegistration_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentRegistration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentRegistration" ("agentVersion", "createdAt", "deviceName", "employeeId", "hostname", "id", "ipAddress", "macAddress", "memory", "operatingSystem", "organizationId", "osVersion", "processor", "rejectionReason", "status", "updatedAt") SELECT "agentVersion", "createdAt", "deviceName", "employeeId", "hostname", "id", "ipAddress", "macAddress", "memory", "operatingSystem", "organizationId", "osVersion", "processor", "rejectionReason", "status", "updatedAt" FROM "AgentRegistration";
DROP TABLE "AgentRegistration";
ALTER TABLE "new_AgentRegistration" RENAME TO "AgentRegistration";
CREATE UNIQUE INDEX "AgentRegistration_employeeId_key" ON "AgentRegistration"("employeeId");
CREATE INDEX "AgentRegistration_organizationId_idx" ON "AgentRegistration"("organizationId");
CREATE INDEX "AgentRegistration_status_idx" ON "AgentRegistration"("status");
CREATE TABLE "new_AgentToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "lastUsedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentToken_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AgentToken" ("createdAt", "deviceId", "employeeId", "expiresAt", "id", "ipAddress", "lastUsedAt", "token", "userAgent") SELECT "createdAt", "deviceId", "employeeId", "expiresAt", "id", "ipAddress", "lastUsedAt", "token", "userAgent" FROM "AgentToken";
DROP TABLE "AgentToken";
ALTER TABLE "new_AgentToken" RENAME TO "AgentToken";
CREATE UNIQUE INDEX "AgentToken_token_key" ON "AgentToken"("token");
CREATE INDEX "AgentToken_employeeId_idx" ON "AgentToken"("employeeId");
CREATE TABLE "new_AiInsight" (
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
    CONSTRAINT "AiInsight_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AiInsight" ("actionTaken", "category", "confidence", "content", "createdAt", "id", "metadata", "organizationId", "status", "title", "type", "updatedAt") SELECT "actionTaken", "category", "confidence", "content", "createdAt", "id", "metadata", "organizationId", "status", "title", "type", "updatedAt" FROM "AiInsight";
DROP TABLE "AiInsight";
ALTER TABLE "new_AiInsight" RENAME TO "AiInsight";
CREATE INDEX "AiInsight_organizationId_idx" ON "AiInsight"("organizationId");
CREATE TABLE "new_Alert" (
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
    CONSTRAINT "Alert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Alert" ("createdAt", "description", "id", "metadata", "organizationId", "severity", "source", "status", "title", "type", "updatedAt") SELECT "createdAt", "description", "id", "metadata", "organizationId", "severity", "source", "status", "title", "type", "updatedAt" FROM "Alert";
DROP TABLE "Alert";
ALTER TABLE "new_Alert" RENAME TO "Alert";
CREATE INDEX "Alert_organizationId_idx" ON "Alert"("organizationId");
CREATE INDEX "Alert_status_idx" ON "Alert"("status");
CREATE INDEX "Alert_createdAt_idx" ON "Alert"("createdAt");
CREATE TABLE "new_Anomaly" (
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
    CONSTRAINT "Anomaly_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Anomaly" ("aiAnalysis", "confidence", "createdAt", "description", "deviceId", "employeeId", "id", "metadata", "organizationId", "resolvedAt", "resolvedBy", "score", "severity", "status", "title", "type", "updatedAt") SELECT "aiAnalysis", "confidence", "createdAt", "description", "deviceId", "employeeId", "id", "metadata", "organizationId", "resolvedAt", "resolvedBy", "score", "severity", "status", "title", "type", "updatedAt" FROM "Anomaly";
DROP TABLE "Anomaly";
ALTER TABLE "new_Anomaly" RENAME TO "Anomaly";
CREATE INDEX "Anomaly_organizationId_idx" ON "Anomaly"("organizationId");
CREATE INDEX "Anomaly_employeeId_idx" ON "Anomaly"("employeeId");
CREATE INDEX "Anomaly_deviceId_idx" ON "Anomaly"("deviceId");
CREATE INDEX "Anomaly_employeeId_createdAt_idx" ON "Anomaly"("employeeId", "createdAt");
CREATE INDEX "Anomaly_organizationId_status_idx" ON "Anomaly"("organizationId", "status");
CREATE TABLE "new_AuditLog" (
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
    CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AuditLog" ("action", "createdAt", "description", "id", "ipAddress", "metadata", "organizationId", "resource", "resourceId", "userId") SELECT "action", "createdAt", "description", "id", "ipAddress", "metadata", "organizationId", "resource", "resourceId", "userId" FROM "AuditLog";
DROP TABLE "AuditLog";
ALTER TABLE "new_AuditLog" RENAME TO "AuditLog";
CREATE INDEX "AuditLog_organizationId_idx" ON "AuditLog"("organizationId");
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");
CREATE TABLE "new_Consent" (
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
    CONSTRAINT "Consent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Consent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Consent" ("consentType", "consentVersion", "createdAt", "employeeId", "expiresAt", "grantedAt", "id", "ipAddress", "notes", "organizationId", "revokedAt", "status", "updatedAt", "userAgent") SELECT "consentType", "consentVersion", "createdAt", "employeeId", "expiresAt", "grantedAt", "id", "ipAddress", "notes", "organizationId", "revokedAt", "status", "updatedAt", "userAgent" FROM "Consent";
DROP TABLE "Consent";
ALTER TABLE "new_Consent" RENAME TO "Consent";
CREATE INDEX "Consent_organizationId_idx" ON "Consent"("organizationId");
CREATE INDEX "Consent_status_idx" ON "Consent"("status");
CREATE UNIQUE INDEX "Consent_employeeId_consentType_key" ON "Consent"("employeeId", "consentType");
CREATE TABLE "new_ConsentLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "consentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "performedBy" TEXT,
    "ipAddress" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsentLog_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "Consent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ConsentLog" ("action", "consentId", "createdAt", "description", "id", "ipAddress", "organizationId", "performedBy") SELECT "action", "consentId", "createdAt", "description", "id", "ipAddress", "organizationId", "performedBy" FROM "ConsentLog";
DROP TABLE "ConsentLog";
ALTER TABLE "new_ConsentLog" RENAME TO "ConsentLog";
CREATE INDEX "ConsentLog_consentId_idx" ON "ConsentLog"("consentId");
CREATE INDEX "ConsentLog_organizationId_idx" ON "ConsentLog"("organizationId");
CREATE TABLE "new_Department" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "organizationId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "managerId" TEXT,
    CONSTRAINT "Department_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Department_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Department" ("createdAt", "description", "id", "managerId", "name", "organizationId", "status", "updatedAt") SELECT "createdAt", "description", "id", "managerId", "name", "organizationId", "status", "updatedAt" FROM "Department";
DROP TABLE "Department";
ALTER TABLE "new_Department" RENAME TO "Department";
CREATE INDEX "Department_organizationId_idx" ON "Department"("organizationId");
CREATE INDEX "Department_managerId_idx" ON "Department"("managerId");
CREATE TABLE "new_Device" (
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
    CONSTRAINT "Device_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Device_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Device" ("agentVersion", "employeeId", "hostname", "id", "ipAddress", "lastHeartbeat", "macAddress", "memory", "name", "operatingSystem", "organizationId", "osVersion", "processor", "registeredAt", "status", "updatedAt") SELECT "agentVersion", "employeeId", "hostname", "id", "ipAddress", "lastHeartbeat", "macAddress", "memory", "name", "operatingSystem", "organizationId", "osVersion", "processor", "registeredAt", "status", "updatedAt" FROM "Device";
DROP TABLE "Device";
ALTER TABLE "new_Device" RENAME TO "Device";
CREATE INDEX "Device_organizationId_idx" ON "Device"("organizationId");
CREATE INDEX "Device_employeeId_idx" ON "Device"("employeeId");
CREATE INDEX "Device_status_idx" ON "Device"("status");
CREATE TABLE "new_Employee" (
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
    CONSTRAINT "Employee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Employee" ("agentApproved", "agentPassword", "avatar", "createdAt", "departmentId", "designation", "email", "employeeId", "firstName", "id", "joinDate", "lastName", "leaveDate", "organizationId", "phone", "status", "updatedAt") SELECT "agentApproved", "agentPassword", "avatar", "createdAt", "departmentId", "designation", "email", "employeeId", "firstName", "id", "joinDate", "lastName", "leaveDate", "organizationId", "phone", "status", "updatedAt" FROM "Employee";
DROP TABLE "Employee";
ALTER TABLE "new_Employee" RENAME TO "Employee";
CREATE UNIQUE INDEX "Employee_employeeId_key" ON "Employee"("employeeId");
CREATE INDEX "Employee_organizationId_idx" ON "Employee"("organizationId");
CREATE INDEX "Employee_departmentId_idx" ON "Employee"("departmentId");
CREATE INDEX "Employee_status_idx" ON "Employee"("status");
CREATE UNIQUE INDEX "Employee_employeeId_organizationId_key" ON "Employee"("employeeId", "organizationId");
CREATE TABLE "new_MonitoringPolicy" (
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
    CONSTRAINT "MonitoringPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_MonitoringPolicy" ("appTrackingEnabled", "createdAt", "description", "id", "idleDetectionEnabled", "idleTimeoutMinutes", "name", "organizationId", "screenshotEnabled", "screenshotFrequency", "screenshotRetentionDays", "updatedAt", "websiteTrackingEnabled", "workEndTime", "workStartTime", "workingHoursOnly") SELECT "appTrackingEnabled", "createdAt", "description", "id", "idleDetectionEnabled", "idleTimeoutMinutes", "name", "organizationId", "screenshotEnabled", "screenshotFrequency", "screenshotRetentionDays", "updatedAt", "websiteTrackingEnabled", "workEndTime", "workStartTime", "workingHoursOnly" FROM "MonitoringPolicy";
DROP TABLE "MonitoringPolicy";
ALTER TABLE "new_MonitoringPolicy" RENAME TO "MonitoringPolicy";
CREATE INDEX "MonitoringPolicy_organizationId_idx" ON "MonitoringPolicy"("organizationId");
CREATE TABLE "new_Notification" (
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
    CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Notification" ("actionUrl", "createdAt", "entityId", "entityType", "id", "message", "organizationId", "priority", "readAt", "status", "title", "type", "updatedAt") SELECT "actionUrl", "createdAt", "entityId", "entityType", "id", "message", "organizationId", "priority", "readAt", "status", "title", "type", "updatedAt" FROM "Notification";
DROP TABLE "Notification";
ALTER TABLE "new_Notification" RENAME TO "Notification";
CREATE INDEX "Notification_organizationId_idx" ON "Notification"("organizationId");
CREATE INDEX "Notification_status_idx" ON "Notification"("status");
CREATE INDEX "Notification_organizationId_status_createdAt_idx" ON "Notification"("organizationId", "status", "createdAt");
CREATE TABLE "new_Project" (
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
    CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Project_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("budgetType", "color", "createdAt", "deadline", "departmentId", "description", "estimatedHours", "hourlyRate", "id", "name", "organizationId", "priority", "startDate", "status", "tags", "updatedAt") SELECT "budgetType", "color", "createdAt", "deadline", "departmentId", "description", "estimatedHours", "hourlyRate", "id", "name", "organizationId", "priority", "startDate", "status", "tags", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_organizationId_idx" ON "Project"("organizationId");
CREATE INDEX "Project_departmentId_idx" ON "Project"("departmentId");
CREATE INDEX "Project_status_idx" ON "Project"("status");
CREATE TABLE "new_ProjectMember" (
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
    CONSTRAINT "ProjectMember_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ProjectMember" ("createdAt", "employeeId", "hoursPerWeek", "id", "joinedAt", "leftAt", "organizationId", "projectId", "role", "updatedAt") SELECT "createdAt", "employeeId", "hoursPerWeek", "id", "joinedAt", "leftAt", "organizationId", "projectId", "role", "updatedAt" FROM "ProjectMember";
DROP TABLE "ProjectMember";
ALTER TABLE "new_ProjectMember" RENAME TO "ProjectMember";
CREATE INDEX "ProjectMember_organizationId_idx" ON "ProjectMember"("organizationId");
CREATE INDEX "ProjectMember_projectId_idx" ON "ProjectMember"("projectId");
CREATE INDEX "ProjectMember_employeeId_idx" ON "ProjectMember"("employeeId");
CREATE UNIQUE INDEX "ProjectMember_projectId_employeeId_key" ON "ProjectMember"("projectId", "employeeId");
CREATE TABLE "new_Report" (
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
    CONSTRAINT "Report_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Report" ("createdAt", "data", "filePath", "format", "generatedBy", "id", "organizationId", "periodEnd", "periodStart", "status", "title", "type", "updatedAt") SELECT "createdAt", "data", "filePath", "format", "generatedBy", "id", "organizationId", "periodEnd", "periodStart", "status", "title", "type", "updatedAt" FROM "Report";
DROP TABLE "Report";
ALTER TABLE "new_Report" RENAME TO "Report";
CREATE INDEX "Report_organizationId_idx" ON "Report"("organizationId");
CREATE TABLE "new_Screenshot" (
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
    CONSTRAINT "Screenshot_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Screenshot" ("aiAnalysis", "appWindow", "blurScore", "capturedAt", "createdAt", "deviceId", "employeeId", "fileName", "filePath", "fileSize", "flagReason", "flagged", "height", "id", "mimeType", "ocrText", "organizationId", "width") SELECT "aiAnalysis", "appWindow", "blurScore", "capturedAt", "createdAt", "deviceId", "employeeId", "fileName", "filePath", "fileSize", "flagReason", "flagged", "height", "id", "mimeType", "ocrText", "organizationId", "width" FROM "Screenshot";
DROP TABLE "Screenshot";
ALTER TABLE "new_Screenshot" RENAME TO "Screenshot";
CREATE INDEX "Screenshot_organizationId_idx" ON "Screenshot"("organizationId");
CREATE INDEX "Screenshot_employeeId_idx" ON "Screenshot"("employeeId");
CREATE INDEX "Screenshot_deviceId_idx" ON "Screenshot"("deviceId");
CREATE INDEX "Screenshot_employeeId_capturedAt_idx" ON "Screenshot"("employeeId", "capturedAt");
CREATE INDEX "Screenshot_flagged_idx" ON "Screenshot"("flagged");
CREATE TABLE "new_SentimentRecord" (
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
    CONSTRAINT "SentimentRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SentimentRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SentimentRecord" ("aiModel", "aiProviderUsed", "createdAt", "employeeId", "id", "insight", "mood", "organizationId", "periodEnd", "periodStart", "recommendation", "riskFactors", "score", "signals", "updatedAt") SELECT "aiModel", "aiProviderUsed", "createdAt", "employeeId", "id", "insight", "mood", "organizationId", "periodEnd", "periodStart", "recommendation", "riskFactors", "score", "signals", "updatedAt" FROM "SentimentRecord";
DROP TABLE "SentimentRecord";
ALTER TABLE "new_SentimentRecord" RENAME TO "SentimentRecord";
CREATE INDEX "SentimentRecord_organizationId_idx" ON "SentimentRecord"("organizationId");
CREATE INDEX "SentimentRecord_employeeId_idx" ON "SentimentRecord"("employeeId");
CREATE INDEX "SentimentRecord_employeeId_periodStart_idx" ON "SentimentRecord"("employeeId", "periodStart");
CREATE TABLE "new_TimeEntry" (
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
    CONSTRAINT "TimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TimeEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TimeEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_TimeEntry" ("billable", "category", "createdAt", "date", "description", "employeeId", "hours", "id", "organizationId", "projectId", "updatedAt") SELECT "billable", "category", "createdAt", "date", "description", "employeeId", "hours", "id", "organizationId", "projectId", "updatedAt" FROM "TimeEntry";
DROP TABLE "TimeEntry";
ALTER TABLE "new_TimeEntry" RENAME TO "TimeEntry";
CREATE INDEX "TimeEntry_organizationId_idx" ON "TimeEntry"("organizationId");
CREATE INDEX "TimeEntry_projectId_idx" ON "TimeEntry"("projectId");
CREATE INDEX "TimeEntry_employeeId_idx" ON "TimeEntry"("employeeId");
CREATE INDEX "TimeEntry_projectId_date_idx" ON "TimeEntry"("projectId", "date");
CREATE INDEX "TimeEntry_employeeId_date_idx" ON "TimeEntry"("employeeId", "date");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AppListEntry_organizationId_idx" ON "AppListEntry"("organizationId");

-- CreateIndex
CREATE INDEX "AppUser_organizationId_idx" ON "AppUser"("organizationId");

-- CreateIndex
CREATE INDEX "AppUser_role_idx" ON "AppUser"("role");

-- CreateIndex
CREATE INDEX "UsbEvent_organizationId_idx" ON "UsbEvent"("organizationId");

-- CreateIndex
CREATE INDEX "UsbEvent_employeeId_idx" ON "UsbEvent"("employeeId");

-- CreateIndex
CREATE INDEX "UsbEvent_deviceId_idx" ON "UsbEvent"("deviceId");

-- CreateIndex
CREATE INDEX "UsbEvent_organizationId_createdAt_idx" ON "UsbEvent"("organizationId", "createdAt");
