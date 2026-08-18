-- CreateTable
CREATE TABLE "BreakSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "source" TEXT NOT NULL,
    "startedBy" TEXT,
    "endedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BreakSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BreakSession_organizationId_idx" ON "BreakSession"("organizationId");

-- CreateIndex
CREATE INDEX "BreakSession_employeeId_idx" ON "BreakSession"("employeeId");

-- CreateIndex
CREATE INDEX "BreakSession_employeeId_startedAt_idx" ON "BreakSession"("employeeId", "startedAt");

-- CreateIndex
CREATE INDEX "BreakSession_employeeId_endedAt_idx" ON "BreakSession"("employeeId", "endedAt");

-- CreateIndex
CREATE INDEX "BreakSession_organizationId_startedAt_idx" ON "BreakSession"("organizationId", "startedAt");

-- CreateIndex
CREATE INDEX "BreakSession_organizationId_endedAt_idx" ON "BreakSession"("organizationId", "endedAt");

-- CreateIndex
CREATE INDEX "BreakSession_startedAt_idx" ON "BreakSession"("startedAt");

-- AddForeignKey
ALTER TABLE "BreakSession" ADD CONSTRAINT "BreakSession_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakSession" ADD CONSTRAINT "BreakSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BreakSession" ADD CONSTRAINT "BreakSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Single-active-break invariant (DB-level concurrency safety): at most ONE
-- open break per employee. Prisma cannot express partial unique indexes in
-- the schema, so this lives here in the migration. Postgres treats NULL
-- `endedAt` values as distinct in a plain unique index, hence the partial
-- predicate `WHERE "endedAt" IS NULL`. Concurrent start requests race on
-- this index: only one insert commits, the loser rolls back and returns the
-- winner's session (see src/lib/breaks/service.ts).
CREATE UNIQUE INDEX "BreakSession_one_active_per_employee" ON "BreakSession"("employeeId") WHERE "endedAt" IS NULL;
