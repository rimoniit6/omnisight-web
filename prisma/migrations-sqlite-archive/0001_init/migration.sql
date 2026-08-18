-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "industry" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'Professional',
    "seats" INTEGER NOT NULL DEFAULT 50,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "contactName" TEXT,
    "contactEmail" TEXT,
    "country" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "twoFactorSecret" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ssoProvider" TEXT,
    "ssoProviderId" TEXT,
    "role" TEXT NOT NULL DEFAULT 'Employee',
    "department" TEXT,
    "team" TEXT,
    "title" TEXT,
    "manager" TEXT,
    "employmentStatus" TEXT NOT NULL DEFAULT 'Full-time',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Dhaka',
    "workSchedule" TEXT NOT NULL DEFAULT 'Mon-Fri 9:00-18:00',
    "status" TEXT NOT NULL DEFAULT 'Active',
    "productivity" INTEGER NOT NULL DEFAULT 0,
    "activityScore" INTEGER NOT NULL DEFAULT 0,
    "focusScore" INTEGER NOT NULL DEFAULT 0,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "burnoutScore" INTEGER NOT NULL DEFAULT 0,
    "avatarColor" TEXT NOT NULL DEFAULT 'amber',
    "organizationId" TEXT,
    "deviceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "User_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT,
    "hostname" TEXT NOT NULL,
    "os" TEXT NOT NULL DEFAULT 'Windows 11',
    "osVersion" TEXT,
    "cpu" TEXT,
    "ram" INTEGER,
    "diskSpace" INTEGER,
    "ipAddress" TEXT,
    "macAddress" TEXT,
    "agentVersion" TEXT NOT NULL DEFAULT '1.0.3',
    "status" TEXT NOT NULL DEFAULT 'Online',
    "lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "location" TEXT,
    "domainJoined" BOOLEAN NOT NULL DEFAULT true,
    "deviceType" TEXT NOT NULL DEFAULT 'Corporate',
    "organizationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Device_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "deviceId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "windowTitle" TEXT,
    "processName" TEXT,
    "category" TEXT,
    "duration" INTEGER NOT NULL DEFAULT 0,
    "focusTime" INTEGER NOT NULL DEFAULT 0,
    "backgroundTime" INTEGER NOT NULL DEFAULT 0,
    "productive" BOOLEAN NOT NULL DEFAULT true,
    "version" TEXT,
    "url" TEXT,
    "domain" TEXT,
    "browser" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActivityLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ActivityLog_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Screenshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "deviceId" TEXT,
    "ocrText" TEXT,
    "ocrKeywords" TEXT,
    "ocrConfidence" INTEGER NOT NULL DEFAULT 0,
    "sensitiveDataDetected" BOOLEAN NOT NULL DEFAULT false,
    "aiSummary" TEXT,
    "productivity" INTEGER NOT NULL DEFAULT 0,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "multiMonitor" BOOLEAN NOT NULL DEFAULT false,
    "blurSensitive" BOOLEAN NOT NULL DEFAULT true,
    "watermark" BOOLEAN NOT NULL DEFAULT true,
    "compression" TEXT NOT NULL DEFAULT 'WebP',
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Screenshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Screenshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoginSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "loginTime" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "logoutTime" DATETIME,
    "lockScreen" DATETIME,
    "unlockScreen" DATETIME,
    "sessionDuration" INTEGER NOT NULL DEFAULT 0,
    "idleDuration" INTEGER NOT NULL DEFAULT 0,
    "activeDuration" INTEGER NOT NULL DEFAULT 0,
    "breakDuration" INTEGER NOT NULL DEFAULT 0,
    "overtime" INTEGER NOT NULL DEFAULT 0,
    "workingHours" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LoginSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FileActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileExtension" TEXT,
    "folderPath" TEXT,
    "fileSize" INTEGER,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FileActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MouseStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "mouseClicks" INTEGER NOT NULL DEFAULT 0,
    "mouseDistance" INTEGER NOT NULL DEFAULT 0,
    "scrollCount" INTEGER NOT NULL DEFAULT 0,
    "rightClicks" INTEGER NOT NULL DEFAULT 0,
    "doubleClicks" INTEGER NOT NULL DEFAULT 0,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MouseStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KeyboardStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "totalKeystrokes" INTEGER NOT NULL DEFAULT 0,
    "shortcutCount" INTEGER NOT NULL DEFAULT 0,
    "typingSpeed" INTEGER NOT NULL DEFAULT 0,
    "deleteCount" INTEGER NOT NULL DEFAULT 0,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KeyboardStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClipboardEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClipboardEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsbActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "deviceName" TEXT,
    "vendor" TEXT,
    "serial" TEXT,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsbActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NetworkActivity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "networkType" TEXT NOT NULL,
    "networkName" TEXT,
    "connected" BOOLEAN NOT NULL DEFAULT true,
    "offlineTime" INTEGER NOT NULL DEFAULT 0,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetworkActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'Medium',
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Alert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AIProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'openai',
    "apiKey" TEXT,
    "baseUrl" TEXT,
    "model" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "usageTokens" INTEGER NOT NULL DEFAULT 0,
    "costSaved" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SecurityPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'Medium',
    "status" TEXT NOT NULL DEFAULT 'Active',
    "rules" TEXT NOT NULL DEFAULT '[]',
    "triggeredCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT,
    "policyName" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'Medium',
    "user" TEXT,
    "device" TEXT,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "License" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "organizationId" TEXT,
    "edition" TEXT NOT NULL DEFAULT 'Professional',
    "seats" INTEGER NOT NULL DEFAULT 50,
    "activatedSeats" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "validFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "License_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Plugin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "author" TEXT,
    "category" TEXT NOT NULL DEFAULT 'Analytics',
    "installed" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "rating" REAL NOT NULL DEFAULT 0,
    "price" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Completed',
    "createdBy" TEXT NOT NULL DEFAULT 'Admin',
    "summary" TEXT,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "License_key_key" ON "License"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Plugin_slug_key" ON "Plugin"("slug");

