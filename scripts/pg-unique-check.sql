\echo '=== unique constraints on Organization ==='
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public."Organization"'::regclass AND contype = 'u';

\echo '=== unique constraints on Device ==='
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public."Device"'::regclass AND contype = 'u';

\echo '=== unique constraints on DeviceClaim ==='
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public."DeviceClaim"'::regclass AND contype = 'u';

\echo '=== unique constraints on ProjectMember ==='
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public."ProjectMember"'::regclass AND contype = 'u';

\echo '=== unique constraints on Consent ==='
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public."Consent"'::regclass AND contype = 'u';

\echo '=== existing slug values ==='
SELECT slug FROM "Organization";
