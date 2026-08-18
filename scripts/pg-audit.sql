-- OmniSight PostgreSQL post-migration audit (G5)
\echo '=== 1. Timestamp round-trip spot checks ==='
SELECT 'org.createdAt=' || to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') FROM "Organization" LIMIT 1;
SELECT 'activity.timestamp=' || to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') FROM "Activity" ORDER BY "timestamp" LIMIT 1;
SELECT 'device.lastHeartbeat=' || coalesce(to_char("lastHeartbeat" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'null') FROM "Device" LIMIT 1;
SELECT 'consent.grantedAt=' || coalesce(to_char("grantedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'), 'null') FROM "Consent" LIMIT 1;
SELECT 'claim.createdAt=' || to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') FROM "DeviceClaim" LIMIT 1;

\echo '=== 2. Foreign keys ==='
SELECT 'FK total=' || count(*) FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace;

\echo '=== 3. Unique constraints (must include critical ones) ==='
SELECT conrelid::regclass || ': ' || pg_get_constraintdef(oid)
FROM pg_constraint
WHERE contype = 'u' AND connamespace = 'public'::regnamespace
ORDER BY 1;

\echo '=== 4. Critical indexes present ==='
SELECT 'Device.agentKey unique -> ' || count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='Device_agentKey_key';
SELECT 'DeviceClaim.deviceId unique -> ' || count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='DeviceClaim_deviceId_key';
SELECT 'ProjectMember(projectId,employeeId) unique -> ' || count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='ProjectMember_projectId_employeeId_key';
SELECT 'Consent(employeeId,consentType) unique -> ' || count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='Consent_employeeId_consentType_key';
SELECT 'Employee.employeeId unique -> ' || count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='Employee_employeeId_key';
SELECT 'Organization.slug unique -> ' || count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='Organization_slug_key';
SELECT 'AppUser.email unique -> ' || count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='AppUser_email_key';
SELECT 'Activity(employeeId,timestamp) idx -> ' || count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='Activity_employeeId_timestamp_idx';
SELECT 'Device.organizationId idx -> ' || count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='Device_organizationId_idx';
SELECT 'AuditLog(organizationId,createdAt) idx -> ' || count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='AuditLog_organizationId_createdAt_idx';

\echo '=== 5. Index total ==='
SELECT 'index total=' || count(*) FROM pg_indexes WHERE schemaname='public';
