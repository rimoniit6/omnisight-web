/**
 * P1-2 — canonical client-IP resolver (`src/lib/client-ip.ts`).
 *
 * Every rate-limit/audit/device-metadata path must agree on the client IP.
 * The resolver must be robust against header spoofing by untrusted clients:
 * the right-most proxy-appended `x-forwarded-for` entry (or `x-real-ip`) is
 * authoritative; prepended entries are attacker-controlled and ignored.
 *
 * Cases covered (per the remediation spec):
 *   1. direct request (no proxy headers)      → 'unknown'
 *   2. single trusted proxy                    → the single XFF entry
 *   3. multiple proxy hops                     → the RIGHT-MOST entry
 *   4. spoofed XFF (prepended entries)         → prepended values ignored
 *   5. malformed header (empty segments)       → skipped, falls through
 *   6. missing header                          → 'unknown'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function resolver(): Promise<(h: Headers) => string> {
  const mod = await import('../src/lib/client-ip');
  return mod.getClientIpFromHeaders;
}

const h = (init: Record<string, string> = {}) => new Headers(init);

test('IP-1: direct request without proxy headers resolves to unknown', async () => {
  const getClientIp = await resolver();
  assert.equal(getClientIp(h()), 'unknown');
  assert.equal(getClientIp(h({ 'x-custom-thing': '1.2.3.4' })), 'unknown', 'unrelated headers are not trusted');
});

test('IP-2: single trusted proxy — one XFF entry is used verbatim', async () => {
  const getClientIp = await resolver();
  assert.equal(getClientIp(h({ 'x-forwarded-for': '203.0.113.9' })), '203.0.113.9');
  // x-real-ip wins when present (it is per-hop overwritten, never appended to).
  assert.equal(
    getClientIp(h({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '198.51.100.7' })),
    '198.51.100.7'
  );
});

test('IP-3: multiple proxy hops — the RIGHT-MOST entry is authoritative', async () => {
  const getClientIp = await resolver();
  // client → proxy1 → proxy2: the last entry is the one appended by the last
  // trusted hop; the earlier entries may include spoofed values.
  assert.equal(getClientIp(h({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.9' })), '203.0.113.9');
  assert.equal(getClientIp(h({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3, 203.0.113.9' })), '203.0.113.9');
});

test('IP-4: spoofed prepended XFF entries are ignored', async () => {
  const getClientIp = await resolver();
  // Attacker prepends their own IPs to dodge per-IP rate limits.
  assert.equal(getClientIp(h({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 8.8.8.8, 203.0.113.9' })), '203.0.113.9');
  // Extremely long forged chain still resolves to the proxy-appended tail.
  const forged = Array.from({ length: 60 }, (_, i) => `10.0.0.${i}`).join(', ') + ', 203.0.113.9';
  assert.equal(getClientIp(h({ 'x-forwarded-for': forged })), '203.0.113.9');
});

test('IP-5: malformed header — empty/whitespace segments are skipped', async () => {
  const getClientIp = await resolver();
  assert.equal(getClientIp(h({ 'x-forwarded-for': '  203.0.113.9  ' })), '203.0.113.9');
  assert.equal(getClientIp(h({ 'x-forwarded-for': '1.1.1.1, , 203.0.113.9, ' })), '203.0.113.9');
  // All-empty chain falls through to 'unknown' (no crash, no bogus value).
  assert.equal(getClientIp(h({ 'x-forwarded-for': ' , , ' })), 'unknown');
});

test('IP-6: missing header falls back through cf-connecting-ip then unknown', async () => {
  const getClientIp = await resolver();
  assert.equal(getClientIp(h({})), 'unknown');
  assert.equal(getClientIp(h({ 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7');
});

test('IP-7: the rate limiter and agent auth resolve IP through the same resolver', async () => {
  const rateLimit = await import('../src/lib/rate-limit');
  const agentAuth = await import('../src/lib/agent/auth');
  const clientIp = await import('../src/lib/client-ip');
  const headers = h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' });
  assert.equal(rateLimit.getClientIpFromHeaders(headers), clientIp.getClientIpFromHeaders(headers));
  assert.equal(agentAuth.getClientIp({ headers } as unknown as Request), clientIp.getClientIpFromHeaders(headers));
});
