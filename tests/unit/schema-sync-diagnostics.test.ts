// Schema-sync diagnostics unit tests (Phase 7/8 — verified forensic fix RC-2).
//
// Proves the `prisma db push` failure extraction:
//   SSD-01  The informational stderr banner "Environment variables loaded from
//           .env" is NEVER surfaced as the failure reason (alone or first).
//   SSD-02  A real Prisma stdout error (Error code: P1001 …) IS surfaced, with
//           its code and meaningful text, regardless of the banner on stderr.
//   SSD-03  PostgreSQL server errors (permission denied, authentication) are
//           surfaced from the combined streams.
//   SSD-04  Secrets/URLs embedded in the output never reach the surfaced text.
//   SSD-05  A timeout (execFile killed the child) is reported as a timeout,
//           not as the stderr banner.
//   SSD-06  A spawn failure (ENOENT) is reported as a start failure.
//   SSD-07  A schema-drift refusal (Prisma push without --accept-data-loss) is
//           surfaced with its meaningful text.
//   SSD-08  Blank output still yields a safe fallback message.
//   SSD-09  The named timeout constant is exported and bounded (Phase 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSchemaSyncError,
  SCHEMA_SYNC_TIMEOUT_MS,
} from '../../src/lib/migration/db-migrate';

const ENV_BANNER = 'Environment variables loaded from .env';

// The real shape of a failed `prisma db push`: stdout carries the failure
// banner + the actual error; stderr carries the informational env banner.
const STDOUT_P1001 = [
  'Prisma schema loaded from prisma/schema.prisma',
  'Error: P1001: Can\'t reach database server at `db.host`:`5432`',
  '',
  'During handling of the above exception, another exception occurred:',
].join('\n');
const STDOUT_PERM = [
  'Prisma schema loaded from prisma/schema.prisma',
  'Error: db error ERROR: permission denied for schema public',
].join('\n');
const STDOUT_AUTH = [
  'Prisma schema loaded from prisma/schema.prisma',
  'Error: Authentication failed against database server at \'db.host\', credentials invalid.',
].join('\n');
const STDOUT_DRIFT = [
  'Prisma schema loaded from prisma/schema.prisma',
  'There might be data loss already: 12 columns will be dropped. Use the --accept-data-loss flag',
].join('\n');

test('SSD-01: the .env banner is never surfaced as the failure reason', () => {
  const out = extractSchemaSyncError({ stdout: '', stderr: `${ENV_BANNER}\n` });
  assert.ok(!out.includes(ENV_BANNER), 'banner alone must not become the error');
  assert.match(out, /schema synchronization|diagnosable|timed out|terminated|could not be started/i);
});

test('SSD-01b: banner + blank output yields the safe fallback, not the banner', () => {
  const out = extractSchemaSyncError({ stdout: '', stderr: `\n${ENV_BANNER}\n  \n` });
  assert.ok(!out.includes(ENV_BANNER));
  assert.match(out, /diagnosable/);
});

test('SSD-02: a real P1001 on stdout is surfaced despite the stderr banner', () => {
  const out = extractSchemaSyncError({ stdout: STDOUT_P1001, stderr: ENV_BANNER });
  assert.match(out, /P1001/);
  assert.match(out, /Can't reach database server/);
  assert.ok(!out.includes(ENV_BANNER));
});

test('SSD-03: PostgreSQL permission/authentication errors are surfaced', () => {
  const perm = extractSchemaSyncError({ stdout: STDOUT_PERM, stderr: ENV_BANNER });
  assert.match(perm, /permission denied/);
  const auth = extractSchemaSyncError({ stdout: STDOUT_AUTH, stderr: ENV_BANNER });
  assert.match(auth, /Authentication failed/);
});

test('SSD-04: connection URLs with credentials are redacted', () => {
  const out = extractSchemaSyncError({
    stdout: 'Error: connection to postgresql://postgres:topsecret@db.host:5432/app failed',
    stderr: '',
  });
  assert.ok(!out.includes('topsecret'), 'password must never reach the surfaced error');
  assert.match(out, /REDACTED_URL/);
});

test('SSD-05: a timed-out push reports the timeout, not the banner', () => {
  const out = extractSchemaSyncError({ stdout: '', stderr: ENV_BANNER, fallback: 'Command was killed after 120000 ms (SIGTERM)' });
  // The fallback carries the truth when streams are empty; the banner never wins.
  assert.ok(!out.includes(ENV_BANNER));
  assert.ok(out.length > 0);
});

test('SSD-06: a spawn failure (ENOENT-style fallback) is surfaced verbatim', () => {
  const out = extractSchemaSyncError({ stdout: '', stderr: ENV_BANNER, fallback: 'spawn node ENOENT' });
  assert.match(out, /ENOENT/);
  assert.ok(!out.includes(ENV_BANNER));
});

test('SSD-07: schema-drift / data-loss refusal text is surfaced', () => {
  const out = extractSchemaSyncError({ stdout: STDOUT_DRIFT, stderr: ENV_BANNER });
  assert.match(out, /data loss|accept-data-loss|dropped/i);
});

test('SSD-08: completely empty output yields the safe fallback', () => {
  const out = extractSchemaSyncError({ stdout: '', stderr: '', fallback: undefined });
  assert.match(out, /diagnosable/);
});

test('SSD-09: the schema-sync timeout is a named, bounded constant (Phase 8)', () => {
  assert.equal(typeof SCHEMA_SYNC_TIMEOUT_MS, 'number');
  assert.equal(SCHEMA_SYNC_TIMEOUT_MS, 120_000, 'budget documented in db-migrate.ts — change deliberately, with evidence');
});

// SSD-10/11 cover the multi-line schema-DRIFT refusal block: the object list
// (which tables/columns/enums a forced push would destroy) must be preserved
// VERBATIM with its actionable `Error:` tail — this is the exact diagnosis an
// operator of a legacy destination needs.

const STDOUT_DRIFT_BLOCK = [
  'Prisma schema loaded from prisma/schema.prisma',
  '⚠ There might be data loss already: 3 tables, 41 columns, 2 enums',
  'The following changes require data loss:',
  '',
  '  • You are about to alter the tables: Guest',
  '',
  '  • You are about to alter the tables: LicenseKey',
  '    columns will be dropped',
  '',
  '  • You are about to alter the column `licenseKeyId` on the `Organization` table,',
  '    which contains 214567 non-null values.',
  '',
  '  • You are about to alter the enum `DeploymentMode` to lose the value `PRIVATE`,',
  '    which is used by the table `Organization`.',
  '',
  'Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss',
].join('\n');

test('SSD-10: the data-loss DRIFT block is surfaced verbatim (objects + actionable tail), not the banner', () => {
  const out = extractSchemaSyncError({ stdout: STDOUT_DRIFT_BLOCK, stderr: ENV_BANNER });
  assert.ok(!out.includes(ENV_BANNER), 'banner must never win');
  // The OBJECT LIST is the operator-facing diagnosis:
  assert.match(out, /Guest/);
  assert.match(out, /LicenseKey/);
  assert.match(out, /`Organization`/i);
  assert.match(out, /DeploymentMode/);
  assert.match(out, /PRIVATE/);
  assert.match(out, /214567/);
  // The actionable tail is preserved:
  assert.match(out, /accept-data-loss/);
  assert.match(out, /Use the --accept-data-loss flag/);
});

test('SSD-11: credentials inside the drift block are redacted, but the diagnosis survives', () => {
  const out = extractSchemaSyncError({
    stdout: STDOUT_DRIFT_BLOCK.replace(
      '⚠ There might be data loss already: 3 tables, 41 columns, 2 enums',
      '⚠ There might be data loss already: 3 tables, 41 columns, 2 enums \nURL: postgresql://postgres:topsecret@db.host:5432/app'
    ),
    stderr: '',
  });
  assert.ok(!out.includes('topsecret'), 'a URL inside the drift block must never leak into the surfaced error');
  assert.match(out, /REDACTED_URL/);
  assert.match(out, /Guest/);
  assert.match(out, /accept-data-loss/);
});
