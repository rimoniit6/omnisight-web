/**
 * Phase 0 — regression guard for the shared test request helper.
 *
 * Next.js 16 / undici reject constructing a Request with a GET/HEAD method AND
 * a body (`TypeError: Request with GET/HEAD method cannot have body.`). The
 * old per-file `req()` helpers defaulted to GET whenever `method` was omitted,
 * so any setup call that supplied a `body` without an explicit method crashed.
 *
 * This suite proves the canonical helper (tests/helpers/request.ts — imported
 * by 28+ agent/admin suites) can never produce a GET request carrying a body:
 *   - body present + method omitted → POST (explicit method always wins)
 *   - no body + method omitted → GET
 *   - an explicit GET without a body still works (read helpers unchanged)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { req } from './helpers/request';

test('RH-1: no body and no method → GET (read default preserved)', () => {
  const r = req(null);
  assert.equal(r.method, 'GET');
  assert.equal(r.body, null, 'no body attached');
});

test('RH-2: body present and no method → POST (never GET+body)', async () => {
  const r = req(null, { body: { a: 1 } });
  assert.equal(r.method, 'POST');
  assert.ok(r.body, 'body attached');
  const parsed = JSON.parse(await r.text());
  assert.deepEqual(parsed, { a: 1 });
});

test('RH-3: constructing with body and no method does NOT throw', () => {
  // Regression: Next 16 throws for GET+body — the helper must default to POST
  // so every historical call site (login, approve, discover, upload) works.
  assert.doesNotThrow(() => req(null, { body: { agentId: 'x', password: 'y' } }));
});

test('RH-4: explicit method always wins', () => {
  const post = req(null, { method: 'POST', body: {} });
  assert.equal(post.method, 'POST');
  const put = req(null, { method: 'PUT', body: {} });
  assert.equal(put.method, 'PUT');
  // Explicit GET without a body stays a plain read.
  const get = req(null, { method: 'GET' });
  assert.equal(get.method, 'GET');
  assert.equal(get.body, null);
});

test('RH-5: auth, ip and user-agent headers are attached', () => {
  const r = req('tok-123', { ip: '203.0.113.9', ua: 'omnisight-agent/1.2.0', body: { x: 1 } });
  assert.equal(r.headers.get('authorization'), 'Bearer tok-123');
  assert.equal(r.headers.get('x-forwarded-for'), '203.0.113.9');
  assert.equal(r.headers.get('user-agent'), 'omnisight-agent/1.2.0');
  assert.equal(r.headers.get('content-type'), 'application/json');
});

test('RH-6: default URL is the canonical test endpoint', () => {
  const r = req(null);
  assert.equal(r.url, 'http://localhost:3000/api/test');
});

test('RH-7: no helper in the migrated suites can still produce GET+body', () => {
  // Belt-and-braces static guard: every migrated suite must import the shared
  // helper, and no test file may contain the old buggy default.
  const dir = join(import.meta.dirname, '.');
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
  const offenders: string[] = [];
  for (const f of files) {
    if (f === 'request-helper.test.ts') continue; // self-guard: file contains the pattern literally
    const src = readFileSync(join(dir, f), 'utf8');
    if (src.includes("method: opts.method || 'GET'")) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, [], `old GET-default helpers remain in: ${offenders.join(', ')}`);
});