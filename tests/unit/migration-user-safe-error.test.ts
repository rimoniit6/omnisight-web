// Migration error-surfacing + destination connection-string unit tests.
// No DB required — these exercise the exact helpers that control (a) what the
// status card / start route report as the REAL failure reason, and (b) how the
// migration copy client connects to the approved destination.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  userSafeError,
  buildDestinationConnectionString,
} from '../../src/lib/migration/db-migrate';

// The real P1017 dump shape (from dev-server.log on the Supabase pooler
// destination): an invocation snippet whose meaning is buried at the END.
const P1017_DUMP = [
  '',
  'Invalid `destination[t.model].create()` invocation in',
  'E:\\app\\.next\\server\\chunks\\[root-of-the-server]__x.js:1345:40',
  '',
  '  1342 };',
  '  1343 // Org-internal FK targets are guaranteed present (copied earlier in',
  '  1344 // MIGRATION_TABLES order) — their values are preserved untouched.',
  '  → 1345 await destination[t.model].create(',
  '    {',
  '      data: { id: "cm-test", organizationId: "org-1" }',
  '    }',
  '  )',
  '',
  'Server has closed the connection.',
  '',
  'Error code: P1017',
  '    Context:',
  '    Server has closed the connection.',
  '    (ERR_P1017)',
].join('\n');

test('userSafeError keeps the meaning, not the noisy head (Prisma dump)', () => {
  const out = userSafeError({ message: P1017_DUMP });
  assert.match(out, /Server has closed the connection/);
  assert.match(out, /P1017/);
  assert.ok(!out.includes('1345'), 'no source-snippet noise in the surfaced reason');
  assert.ok(!out.includes('await destination'), 'no invocation noise in the surfaced reason');
});

test('userSafeError redacts any embedded connection URL (credentials never leak)', () => {
  const out = userSafeError({ message: 'probe failed: postgresql://postgres.jgfgskdbijeznuplaggh:s3cr3t@aws-0-us-east-1.pooler.supabase.com:5432/postgres' });
  assert.ok(!out.includes('s3cr3t'), 'password must never reach the message');
  assert.ok(!out.includes('postgresql://'), 'connection URL must never reach the message');
  assert.match(out, /REDACTED_URL/);
});

test('userSafeError falls back to the first line for plain driver errors', () => {
  const out = userSafeError({ message: 'connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect' });
  assert.equal(out, 'connect ECONNREFUSED 127.0.0.1:5432');
});

test('userSafeError has a safe fallback for non-Error throws', () => {
  assert.equal(userSafeError(undefined), 'Unknown destination failure');
  assert.equal(userSafeError('bogus'), 'bogus');
});

test('buildDestinationConnectionString: dataCopy pins ONE connection + timeout', () => {
  const url = buildDestinationConnectionString(
    { host: 'aws-0-us-east-1.pooler.supabase.com', port: 5432, name: 'postgres', user: 'postgres.jgfgskdbijeznuplaggh', ssl: true },
    { dataCopy: true }
  );
  assert.match(url, /^postgresql:\/\//);
  assert.match(url, /sslmode=require/);
  assert.match(url, /connection_limit=1/);
  assert.match(url, /connect_timeout=10/);
  const query = url.split('?')[1];
  assert.equal(query, 'sslmode=require&connection_limit=1&connect_timeout=10');
});

test('buildDestinationConnectionString: schema-sync URL has no single-connection pin', () => {
  const url = buildDestinationConnectionString(
    { host: 'localhost', port: 5432, name: 'dest', user: 'postgres', password: '123456', ssl: false }
  );
  assert.equal(url, 'postgresql://postgres:123456@localhost:5432/dest');
});

test('buildDestinationConnectionString: user/password with special chars are encoded', () => {
  const url = buildDestinationConnectionString(
    { host: 'db.example.com', port: null, name: 'app', user: 'user:1', password: 'p@ss w!', ssl: true },
    { dataCopy: true }
  );
  assert.match(url, /user%3A1/);
  assert.match(url, /p%40ss%20w!/);
  assert.match(url, /db\.example\.com:5432/);
});

test('buildDestinationConnectionString: port defaults to 5432 when null', () => {
  const url = buildDestinationConnectionString({ host: 'db.example.com', port: null, name: 'app', user: 'u', ssl: false });
  assert.equal(url, 'postgresql://u:@db.example.com:5432/app');
});