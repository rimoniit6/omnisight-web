-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "managerId" TEXT,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "avatar" TEXT,
    "designation" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "joinDate" TIMESTAMP(3),
    "leaveDate" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "departmentId" TEXT,
    "agentPassword" TEXT,
    "agentApproved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
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
    "lastHeartbeat" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT,
    "agentKey" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceClaim" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "claimSecretHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "employeeId" TEXT,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "url" TEXT,
    "applicationName" TEXT,
    "category" TEXT,
    "duration" INTEGER NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringPolicy" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonitoringPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'unread',
    "actionUrl" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" TEXT,
    "metadata" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "description" TEXT NOT NULL,
    "userId" TEXT,
    "ipAddress" TEXT,
    "metadata" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'pdf',
    "status" TEXT NOT NULL DEFAULT 'completed',
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "data" TEXT,
    "filePath" TEXT,
    "organizationId" TEXT NOT NULL,
    "generatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiInsight" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL,
    "category" TEXT,
    "confidence" DOUBLE PRECISION DEFAULT 0.0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "actionTaken" TEXT,
    "metadata" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password" TEXT,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "avatar" TEXT,
    "organizationId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLogin" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "category" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRegistration" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Screenshot" (
    "id" TEXT NOT NULL,
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
    "blurScore" DOUBLE PRECISION,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "flagReason" TEXT,
    "organizationId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Screenshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppListEntry" (
    "id" TEXT NOT NULL,
    "appName" TEXT NOT NULL,
    "executableName" TEXT,
    "category" TEXT,
    "listType" TEXT NOT NULL,
    "reason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsbEvent" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "deviceName" TEXT,
    "vendorName" TEXT,
    "serialNumber" TEXT,
    "filePath" TEXT,
    "employeeId" TEXT,
    "deviceId" TEXT,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsbEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Anomaly" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'detected',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "employeeId" TEXT,
    "deviceId" TEXT,
    "metadata" TEXT,
    "aiAnalysis" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Anomaly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentPolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "consentType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "effectiveAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishedBy" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsentPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "consentType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "grantedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "consentVersion" TEXT NOT NULL DEFAULT 'v1',
    "policyId" TEXT,
    "notes" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentLog" (
    "id" TEXT NOT NULL,
    "consentId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "performedBy" TEXT,
    "ipAddress" TEXT,
    "organizationId" TEXT NOT NULL,
    "anonymizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSetting" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "category" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastDurationMs" INTEGER,
    "lastError" TEXT,
    "lastResult" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "startDate" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "estimatedHours" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "color" TEXT NOT NULL DEFAULT '#10b981',
    "tags" TEXT,
    "budgetType" TEXT,
    "hourlyRate" DOUBLE PRECISION,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "departmentId" TEXT,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "hoursPerWeek" DOUBLE PRECISION NOT NULL DEFAULT 40.0,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "hours" DOUBLE PRECISION NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SentimentRecord" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 50.0,
    "mood" TEXT NOT NULL DEFAULT 'neutral',
    "signals" TEXT,
    "insight" TEXT,
    "riskFactors" TEXT,
    "recommendation" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "aiProviderUsed" TEXT,
    "aiModel" TEXT,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SentimentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Department_organizationId_idx" ON "Department"("organizationId");

-- CreateIndex
CREATE INDEX "Department_managerId_idx" ON "Department"("managerId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_organizationId_name_key" ON "Department"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_employeeId_key" ON "Employee"("employeeId");

-- CreateIndex
CREATE INDEX "Employee_organizationId_idx" ON "Employee"("organizationId");

-- CreateIndex
CREATE INDEX "Employee_departmentId_idx" ON "Employee"("departmentId");

-- CreateIndex
CREATE INDEX "Employee_status_idx" ON "Employee"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_email_organizationId_key" ON "Employee"("email", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_agentKey_key" ON "Device"("agentKey");

-- CreateIndex
CREATE INDEX "Device_organizationId_idx" ON "Device"("organizationId");

-- CreateIndex
CREATE INDEX "Device_employeeId_idx" ON "Device"("employeeId");

-- CreateIndex
CREATE INDEX "Device_status_idx" ON "Device"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceClaim_deviceId_key" ON "DeviceClaim"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceClaim_organizationId_idx" ON "DeviceClaim"("organizationId");

-- CreateIndex
CREATE INDEX "DeviceClaim_status_idx" ON "DeviceClaim"("status");

-- CreateIndex
CREATE INDEX "DeviceClaim_employeeId_idx" ON "DeviceClaim"("employeeId");

-- CreateIndex
CREATE INDEX "Activity_employeeId_idx" ON "Activity"("employeeId");

-- CreateIndex
CREATE INDEX "Activity_deviceId_idx" ON "Activity"("deviceId");

-- CreateIndex
CREATE INDEX "Activity_timestamp_idx" ON "Activity"("timestamp");

-- CreateIndex
CREATE INDEX "Activity_employeeId_timestamp_idx" ON "Activity"("employeeId", "timestamp");

-- CreateIndex
CREATE INDEX "Activity_employeeId_category_idx" ON "Activity"("employeeId", "category");

-- CreateIndex
CREATE INDEX "Activity_category_timestamp_idx" ON "Activity"("category", "timestamp");

-- CreateIndex
CREATE INDEX "MonitoringPolicy_organizationId_idx" ON "MonitoringPolicy"("organizationId");

-- CreateIndex
CREATE INDEX "Notification_organizationId_idx" ON "Notification"("organizationId");

-- CreateIndex
CREATE INDEX "Notification_status_idx" ON "Notification"("status");

-- CreateIndex
CREATE INDEX "Notification_organizationId_status_createdAt_idx" ON "Notification"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Alert_organizationId_idx" ON "Alert"("organizationId");

-- CreateIndex
CREATE INDEX "Alert_status_idx" ON "Alert"("status");

-- CreateIndex
CREATE INDEX "Alert_createdAt_idx" ON "Alert"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_idx" ON "AuditLog"("organizationId");

-- CreateIndex
CREATE INDEX "AuditLog_organizationId_createdAt_idx" ON "AuditLog"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Report_organizationId_idx" ON "Report"("organizationId");

-- CreateIndex
CREATE INDEX "AiInsight_organizationId_idx" ON "AiInsight"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "AppUser_email_key" ON "AppUser"("email");

-- CreateIndex
CREATE INDEX "AppUser_organizationId_idx" ON "AppUser"("organizationId");

-- CreateIndex
CREATE INDEX "AppUser_role_idx" ON "AppUser"("role");

-- CreateIndex
CREATE UNIQUE INDEX "SystemSetting_key_key" ON "SystemSetting"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRegistration_employeeId_key" ON "AgentRegistration"("employeeId");

-- CreateIndex
CREATE INDEX "AgentRegistration_organizationId_idx" ON "AgentRegistration"("organizationId");

-- CreateIndex
CREATE INDEX "AgentRegistration_status_idx" ON "AgentRegistration"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AgentToken_token_key" ON "AgentToken"("token");

-- CreateIndex
CREATE INDEX "AgentToken_employeeId_idx" ON "AgentToken"("employeeId");

-- CreateIndex
CREATE INDEX "Screenshot_organizationId_idx" ON "Screenshot"("organizationId");

-- CreateIndex
CREATE INDEX "Screenshot_employeeId_idx" ON "Screenshot"("employeeId");

-- CreateIndex
CREATE INDEX "Screenshot_deviceId_idx" ON "Screenshot"("deviceId");

-- CreateIndex
CREATE INDEX "Screenshot_employeeId_capturedAt_idx" ON "Screenshot"("employeeId", "capturedAt");

-- CreateIndex
CREATE INDEX "Screenshot_capturedAt_idx" ON "Screenshot"("capturedAt");

-- CreateIndex
CREATE INDEX "Screenshot_flagged_idx" ON "Screenshot"("flagged");

-- CreateIndex
CREATE INDEX "AppListEntry_organizationId_idx" ON "AppListEntry"("organizationId");

-- CreateIndex
CREATE INDEX "UsbEvent_organizationId_idx" ON "UsbEvent"("organizationId");

-- CreateIndex
CREATE INDEX "UsbEvent_employeeId_idx" ON "UsbEvent"("employeeId");

-- CreateIndex
CREATE INDEX "UsbEvent_deviceId_idx" ON "UsbEvent"("deviceId");

-- CreateIndex
CREATE INDEX "UsbEvent_organizationId_createdAt_idx" ON "UsbEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "Anomaly_organizationId_idx" ON "Anomaly"("organizationId");

-- CreateIndex
CREATE INDEX "Anomaly_employeeId_idx" ON "Anomaly"("employeeId");

-- CreateIndex
CREATE INDEX "Anomaly_deviceId_idx" ON "Anomaly"("deviceId");

-- CreateIndex
CREATE INDEX "Anomaly_employeeId_createdAt_idx" ON "Anomaly"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "Anomaly_organizationId_status_idx" ON "Anomaly"("organizationId", "status");

-- CreateIndex
CREATE INDEX "ConsentPolicy_organizationId_consentType_status_idx" ON "ConsentPolicy"("organizationId", "consentType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ConsentPolicy_organizationId_consentType_version_key" ON "ConsentPolicy"("organizationId", "consentType", "version");

-- CreateIndex
CREATE INDEX "Consent_organizationId_idx" ON "Consent"("organizationId");

-- CreateIndex
CREATE INDEX "Consent_status_idx" ON "Consent"("status");

-- CreateIndex
CREATE INDEX "Consent_policyId_idx" ON "Consent"("policyId");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_employeeId_consentType_key" ON "Consent"("employeeId", "consentType");

-- CreateIndex
CREATE INDEX "ConsentLog_consentId_idx" ON "ConsentLog"("consentId");

-- CreateIndex
CREATE INDEX "ConsentLog_organizationId_idx" ON "ConsentLog"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationSetting_organizationId_idx" ON "OrganizationSetting"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSetting_organizationId_key_key" ON "OrganizationSetting"("organizationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_job_key" ON "JobRun"("job");

-- CreateIndex
CREATE INDEX "Project_organizationId_idx" ON "Project"("organizationId");

-- CreateIndex
CREATE INDEX "Project_departmentId_idx" ON "Project"("departmentId");

-- CreateIndex
CREATE INDEX "Project_status_idx" ON "Project"("status");

-- CreateIndex
CREATE INDEX "ProjectMember_organizationId_idx" ON "ProjectMember"("organizationId");

-- CreateIndex
CREATE INDEX "ProjectMember_projectId_idx" ON "ProjectMember"("projectId");

-- CreateIndex
CREATE INDEX "ProjectMember_employeeId_idx" ON "ProjectMember"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_projectId_employeeId_key" ON "ProjectMember"("projectId", "employeeId");

-- CreateIndex
CREATE INDEX "TimeEntry_organizationId_idx" ON "TimeEntry"("organizationId");

-- CreateIndex
CREATE INDEX "TimeEntry_projectId_idx" ON "TimeEntry"("projectId");

-- CreateIndex
CREATE INDEX "TimeEntry_employeeId_idx" ON "TimeEntry"("employeeId");

-- CreateIndex
CREATE INDEX "TimeEntry_projectId_date_idx" ON "TimeEntry"("projectId", "date");

-- CreateIndex
CREATE INDEX "TimeEntry_employeeId_date_idx" ON "TimeEntry"("employeeId", "date");

-- CreateIndex
CREATE INDEX "SentimentRecord_organizationId_idx" ON "SentimentRecord"("organizationId");

-- CreateIndex
CREATE INDEX "SentimentRecord_employeeId_idx" ON "SentimentRecord"("employeeId");

-- CreateIndex
CREATE INDEX "SentimentRecord_employeeId_periodStart_idx" ON "SentimentRecord"("employeeId", "periodStart");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceClaim" ADD CONSTRAINT "DeviceClaim_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceClaim" ADD CONSTRAINT "DeviceClaim_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceClaim" ADD CONSTRAINT "DeviceClaim_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringPolicy" ADD CONSTRAINT "MonitoringPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiInsight" ADD CONSTRAINT "AiInsight_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppUser" ADD CONSTRAINT "AppUser_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRegistration" ADD CONSTRAINT "AgentRegistration_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRegistration" ADD CONSTRAINT "AgentRegistration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentToken" ADD CONSTRAINT "AgentToken_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Screenshot" ADD CONSTRAINT "Screenshot_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Screenshot" ADD CONSTRAINT "Screenshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Screenshot" ADD CONSTRAINT "Screenshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Anomaly" ADD CONSTRAINT "Anomaly_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Anomaly" ADD CONSTRAINT "Anomaly_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Anomaly" ADD CONSTRAINT "Anomaly_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentPolicy" ADD CONSTRAINT "ConsentPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ConsentPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentLog" ADD CONSTRAINT "ConsentLog_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "Consent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationSetting" ADD CONSTRAINT "OrganizationSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SentimentRecord" ADD CONSTRAINT "SentimentRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SentimentRecord" ADD CONSTRAINT "SentimentRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
