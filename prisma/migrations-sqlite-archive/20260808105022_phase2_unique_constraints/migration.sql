-- Phase 2: Unique constraints
-- 1. Enforce one department name per organization (prevents import races / dupes)
-- 2. Enforce one email per organization (prevents duplicate employee accounts)
-- 3. Drop the redundant unique index on Employee(employeeId, organizationId) -
--    employeeId is already globally unique, so the composite adds no value.

CREATE UNIQUE INDEX "Department_organizationId_name_key" ON "Department"("organizationId", "name");

CREATE UNIQUE INDEX "Employee_email_organizationId_key" ON "Employee"("email", "organizationId");

DROP INDEX "Employee_employeeId_organizationId_key";
