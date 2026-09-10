// Database connection-test error classification unit tests (no DB required).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyPgError,
  PROBE_CODES,
  UNKNOWN_PROBE_MESSAGE,
  sanitizeProbeErrorForLog,
} from '../../src/lib/infra-connect';

function pgErr(code: string | undefined, message: string): Error & { code?: string } {
  return Object.assign(new Error(message), code ? { code } : {});
}

test('28P01 / password message → AUTHENTICATION_FAILED', () => {
  const r = classifyPgError(pgErr('28P01', 'password authentication failed for user "postgres"'));
  assert.equal(r.code, PROBE_CODES.AUTHENTICATION_FAILED);
  assert.match(r.message, /username or password/);
});

test('P1000 (Prisma auth) → AUTHENTICATION_FAILED', () => {
  const r = classifyPgError(pgErr('P1000', 'Authentication failed against database server at `db.example.com:5432`'));
  assert.equal(r.code, PROBE_CODES.AUTHENTICATION_FAILED);
});

test('3D000 / "database ... does not exist" → DATABASE_NOT_FOUND', () => {
  for (const e of [pgErr('3D000', 'database "nope" does not exist'), pgErr(undefined, 'database "nope" does not exist')]) {
    const r = classifyPgError(e);
    assert.equal(r.code, PROBE_CODES.DATABASE_NOT_FOUND);
    assert.match(r.message, /database name/);
  }
});

test('ENOTFOUND → HOST_NOT_FOUND', () => {
  const r = classifyPgError(pgErr('ENOTFOUND', 'getaddrinfo ENOTFOUND no-such-host.invalid'));
  assert.equal(r.code, PROBE_CODES.HOST_NOT_FOUND);
  assert.match(r.message, /host address/);
});

test('EAI_AGAIN → HOST_NOT_FOUND', () => {
  const r = classifyPgError(pgErr('EAI_AGAIN', 'getaddrinfo EAI_AGAIN db.example.com'));
  assert.equal(r.code, PROBE_CODES.HOST_NOT_FOUND);
});

test('ECONNREFUSED → CONNECTION_REFUSED', () => {
  const r = classifyPgError(pgErr('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5433'));
  assert.equal(r.code, PROBE_CODES.CONNECTION_REFUSED);
  assert.match(r.message, /host, port, and network/);
});

test('ECONNRESET / EHOSTUNREACH → CONNECTION_REFUSED', () => {
  assert.equal(classifyPgError(pgErr('ECONNRESET', 'socket hang up')).code, PROBE_CODES.CONNECTION_REFUSED);
  assert.equal(classifyPgError(pgErr('EHOSTUNREACH', 'No route to host')).code, PROBE_CODES.CONNECTION_REFUSED);
});

test('P1001 (Prisma unreachable) → CONNECTION_REFUSED', () => {
  const r = classifyPgError(pgErr('P1001', "Can't reach database server at `db.example.com:5432`"));
  assert.equal(r.code, PROBE_CODES.CONNECTION_REFUSED);
});

test('ETIMEDOUT / timeout message → CONNECTION_TIMEOUT', () => {
  assert.equal(classifyPgError(pgErr('ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.1:5432')).code, PROBE_CODES.CONNECTION_TIMEOUT);
  const r2 = classifyPgError(pgErr(undefined, 'Connection terminated due to connection timeout'));
  assert.equal(r2.code, PROBE_CODES.CONNECTION_TIMEOUT);
  assert.match(r2.message, /did not respond in time/);
});

test('SSL/TLS/certificate → SSL_ERROR', () => {
  for (const e of [
    pgErr('EPROTO', 'write EPROTO 140735495192384:error:14094410:SSL routines:ssl3_read_bytes:sslv3 alert handshake failure'),
    pgErr(undefined, 'unable to verify the first certificate'),
    pgErr(undefined, 'The server does not support SSL connections'),
  ]) {
    assert.equal(classifyPgError(e).code, PROBE_CODES.SSL_ERROR);
  }
});

test('permission denied → PERMISSION_DENIED', () => {
  const r = classifyPgError(pgErr('42501', 'permission denied for schema public'));
  assert.equal(r.code, PROBE_CODES.PERMISSION_DENIED);
  assert.match(r.message, /permissions/);
});

test('unknown error → UNKNOWN with safe generic message (no raw echo)', () => {
  const raw = 'connection failed: SELECT is not allowed 42P09 special-details-xyz';
  const r = classifyPgError(pgErr('42P09', raw));
  assert.equal(r.code, PROBE_CODES.UNKNOWN);
  assert.equal(r.message, UNKNOWN_PROBE_MESSAGE);
  assert.ok(!r.message.includes('42P09'), 'raw code must not leak');
  assert.ok(!r.message.includes('special-details-xyz'), 'raw message must not leak');
});

test('a leaked connection URL in a raw error never reaches the client', () => {
  const leaky = pgErr(undefined, 'connect failed for postgres://user:supersecret@aws-0-us-east-1.pooler.supabase.com:5432/postgres');
  const r = classifyPgError(leaky);
  assert.equal(r.code, PROBE_CODES.UNKNOWN);
  assert.ok(!r.message.includes('postgres://'), 'connection URL must not leak');
  assert.ok(!r.message.includes('supersecret'), 'credentials must not leak');
});

test('sanitizeProbeErrorForLog strips connection URLs for server logs', () => {
  const out = sanitizeProbeErrorForLog(pgErr(undefined, 'failed at postgres://u:p@host:5432/db and more'));
  assert.ok(!out.includes('postgres://'));
  assert.ok(!out.includes(':p@'));
  assert.ok(out.includes('failed at'));
});
