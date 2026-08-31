-- AlterTable
ALTER TABLE "UserSession" ADD COLUMN     "activeOrganizationId" TEXT;

-- CreateTable
CREATE TABLE "OrganizationMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioRecording" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT,
    "deviceId" TEXT,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "duration" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "language" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioRecording_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioTranscription" (
    "id" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "segments" TEXT,
    "language" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "model" TEXT NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "wordCount" INTEGER NOT NULL,
    "processingMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudioTranscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrganizationMembership_userId_idx" ON "OrganizationMembership"("userId");

-- CreateIndex
CREATE INDEX "OrganizationMembership_organizationId_idx" ON "OrganizationMembership"("organizationId");

-- CreateIndex
CREATE INDEX "OrganizationMembership_status_idx" ON "OrganizationMembership"("status");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_userId_organizationId_key" ON "OrganizationMembership"("userId", "organizationId");

-- CreateIndex
CREATE INDEX "AudioRecording_organizationId_idx" ON "AudioRecording"("organizationId");

-- CreateIndex
CREATE INDEX "AudioRecording_employeeId_idx" ON "AudioRecording"("employeeId");

-- CreateIndex
CREATE INDEX "AudioRecording_deviceId_idx" ON "AudioRecording"("deviceId");

-- CreateIndex
CREATE INDEX "AudioRecording_status_idx" ON "AudioRecording"("status");

-- CreateIndex
CREATE INDEX "AudioRecording_createdAt_idx" ON "AudioRecording"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AudioTranscription_recordingId_key" ON "AudioTranscription"("recordingId");

-- CreateIndex
CREATE INDEX "AudioTranscription_organizationId_idx" ON "AudioTranscription"("organizationId");

-- CreateIndex
CREATE INDEX "AudioTranscription_createdAt_idx" ON "AudioTranscription"("createdAt");

-- CreateIndex
CREATE INDEX "Device_organizationId_status_idx" ON "Device"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Device_organizationId_updatedAt_idx" ON "Device"("organizationId", "updatedAt");

-- CreateIndex
CREATE INDEX "Screenshot_organizationId_capturedAt_idx" ON "Screenshot"("organizationId", "capturedAt");

-- CreateIndex
CREATE INDEX "UserSession_activeOrganizationId_idx" ON "UserSession"("activeOrganizationId");

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AppUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_activeOrganizationId_fkey" FOREIGN KEY ("activeOrganizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioRecording" ADD CONSTRAINT "AudioRecording_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioRecording" ADD CONSTRAINT "AudioRecording_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioRecording" ADD CONSTRAINT "AudioRecording_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioTranscription" ADD CONSTRAINT "AudioTranscription_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "AudioRecording"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioTranscription" ADD CONSTRAINT "AudioTranscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
