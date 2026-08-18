/**
 * M005 Stage-2 — Agent Authentication Layer — Automated Verification
 *
 * Exercises the composed one-call verifier `authenticateAgentRequest`
 * (src/lib/agent-auth/context.ts) with fake loaders + real HMAC signing.
 * No server or DB needed.
 *
 * Run:      bun scripts/verify-m005s2.mjs
 *
 * Covers the mission's 8 cases + extras:
 *   valid request · invalid signature · invalid timestamp · invalid nonce
 *   revoked token · disabled installation · disabled device · malformed headers
 *   + X-Agent-Timestamp/X-Agent-Nonce aliases · unknown token · hashed-at-rest
 *   · expired token · device/installation mismatch
 */

import { authenticateAgentRequest } from '../src/lib/agent-auth/context'
import { AgentAuthError, isAgentAuthError } from '../src/lib/agent-auth/errors'
import { InMemoryNonceStore } from '../src/lib/agent-auth/nonce-store'
import { randomBytes } from 'node:crypto'
import { signAgentRequest } from '../src/lib/agent-auth/signature'
import { generateAgentToken, sha256Hex } from '../src/lib/agent-auth/tokens'

let passed = 0
let failed = 0
const failures = []

function check(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ❌ ${name} ${extra}`)
  }
}

/** Capture the tokenHash the loaders were asked to resolve (hash-at-rest proof). */
const capturedTokenHashes = []
function makeLoaders(overrides = {}) {
  const token = overrides.token ?? generateAgentToken()
  const state = {
    credential: {
      id: 'cred_1',
      deviceId: 'dev_1',
      tokenHash: sha256Hex(token),
      expiresAt: Date.now() + 180 * 86400000,
      revokedAt: null,
      revokeReason: null,
      ...(overrides.credential ?? {}),
    },
    device: { id: 'dev_1', status: 'Active', installationId: 'inst_1', ...(overrides.device ?? {}) },
    installation: overrides.installation ?? { id: 'inst_1', status: 'Active' },
  }
  const loaders = {
    loadCredentialByTokenHash: async (tokenHash) => {
      capturedTokenHashes.push(tokenHash)
      return state.credential.tokenHash === tokenHash ? state.credential : null
    },
    loadDeviceById: async (id) => (state.device.id === id ? state.device : null),
    loadInstallationById: async (id) =>
      state.installation && state.installation.id === id ? state.installation : null,
  }
  return { token, state, loaders }
}

const NONCE = () => Buffer.from(randomBytes(16)).toString('base64url')
const BODY = JSON.stringify({ hello: 'agent' })
const PATH = '/api/agent/v1/heartbeat'
const METHOD = 'POST'

function buildHeaders({ token, ts = Date.now(), nonce, body = BODY, alias = false, extra = {} }) {
  // Lowercase keys: readHeader on a plain object matches exact/lowercase names;
  // real req.headers is a Headers instance (case-insensitive) — equivalent.
  const headers = {
    authorization: `Bearer ${token}`,
    'x-installation-id': 'inst_1',
    'x-device-id': 'dev_1',
    'x-agent-version': '0.1.0',
    [alias ? 'x-agent-timestamp' : 'x-timestamp']: String(ts),
    [alias ? 'x-agent-nonce' : 'x-nonce']: nonce,
    'x-agent-signature': signAgentRequest({
      key: token,
      method: METHOD,
      path: PATH,
      timestamp: ts,
      nonce,
      body,
    }),
    'x-request-id': 'req-' + Math.random().toString(36).slice(2),
    ...extra,
  }
  return headers
}

async function attempt(input) {
  try {
    const ctx = await authenticateAgentRequest(input)
    return { ok: true, ctx }
  } catch (err) {
    return { ok: false, err }
  }
}

function authInput({ loaders, headers, nonceStore, body = BODY, now }) {
  return {
    method: METHOD,
    pathname: PATH,
    search: '',
    body,
    headers,
    loaders,
    nonceStore,
    ...(now !== undefined ? { now } : {}),
  }
}

console.log('\n=== M005 Stage-2 — Agent Authentication Layer — Automated Verification ===\n')

// ── 1. Valid request ─────────────────────────────────────────────────────
console.log('1) Valid request')
{
  const { token, loaders } = makeLoaders()
  const store = new InMemoryNonceStore()
  const nonce = NONCE()
  const r = await attempt(authInput({ loaders, headers: buildHeaders({ token, nonce }), nonceStore: store }))
  check('authenticates → context returned', r.ok)
  check('context has credential/device/installation/headers', r.ok && r.ctx.credential.id === 'cred_1' && r.ctx.device.id === 'dev_1' && r.ctx.installation.id === 'inst_1' && r.ctx.headers.deviceId === 'dev_1')
  check('nonce consumed (replay would fail)', (await store.isUsed('dev_1', nonce)) === true)
  const second = await attempt(authInput({ loaders, headers: buildHeaders({ token, nonce }), nonceStore: store }))
  check('same nonce replayed → 409 AGENT_REPLAY', !second.ok && second.err.code === 'AGENT_REPLAY' && second.err.status === 409)
}

// ── 2. Invalid signature (tampered body) ─────────────────────────────────
console.log('\n2) Invalid signature')
{
  const { token, loaders } = makeLoaders()
  const headers = buildHeaders({ token, nonce: NONCE(), body: BODY })
  // Tamper: body differs from what was signed
  const r = await attempt(authInput({ loaders, headers, nonceStore: new InMemoryNonceStore(), body: BODY + 'X' }))
  check('tampered body → 401 AGENT_SIGNATURE_INVALID', !r.ok && r.err.code === 'AGENT_SIGNATURE_INVALID' && r.err.status === 401)
}

// ── 3. Invalid timestamp (outside ±300 s window) ─────────────────────────
console.log('\n3) Invalid timestamp')
{
  const { token, loaders } = makeLoaders()
  const now = Date.now()
  const stale = now - 400_000 // 400 s in the past
  const r = await attempt(
    authInput({ loaders, headers: buildHeaders({ token, ts: stale, nonce: NONCE() }), nonceStore: new InMemoryNonceStore(), now })
  )
  check('stale timestamp → 429 AGENT_CLOCK_SKEW', !r.ok && r.err.code === 'AGENT_CLOCK_SKEW' && r.err.status === 429)
  const r2 = await attempt(
    authInput({ loaders, headers: buildHeaders({ token, ts: now + 400_000, nonce: NONCE() }), nonceStore: new InMemoryNonceStore(), now })
  )
  check('future timestamp → 429 AGENT_CLOCK_SKEW', !r2.ok && r2.err.code === 'AGENT_CLOCK_SKEW')
}

// ── 4. Invalid nonce ─────────────────────────────────────────────────────
console.log('\n4) Invalid nonce')
{
  const { token, loaders } = makeLoaders()
  const headers = buildHeaders({ token, nonce: 'tooshort' })
  const r = await attempt(authInput({ loaders, headers, nonceStore: new InMemoryNonceStore() }))
  // Malformed nonce is a malformed REQUIRED header → rejected by the header schema as 401
  // (AGENT_NONCE_INVALID 400 remains a defense-in-depth path in assertValidNonce).
  check('malformed nonce → 401 (malformed required header)', !r.ok && r.err.status === 401)
}

// ── 5. Revoked token ─────────────────────────────────────────────────────
console.log('\n5) Revoked token')
{
  const { token, loaders } = makeLoaders({
    credential: { revokedAt: new Date(Date.now() - 1000), revokeReason: 'suspicious' },
  })
  const r = await attempt(authInput({ loaders, headers: buildHeaders({ token, nonce: NONCE() }), nonceStore: new InMemoryNonceStore() }))
  check('revoked credential → 401 AGENT_TOKEN_EXPIRED', !r.ok && r.err.code === 'AGENT_TOKEN_EXPIRED' && r.err.status === 401)
  check('revoke reason surfaced in details', !r.ok && r.err.details?.revokeReason === 'suspicious')
}

// ── 5b. Expired token ────────────────────────────────────────────────────
console.log('\n5b) Expired token')
{
  const { token, loaders } = makeLoaders({
    credential: { expiresAt: Date.now() - 1000, revokedAt: null },
  })
  const r = await attempt(authInput({ loaders, headers: buildHeaders({ token, nonce: NONCE() }), nonceStore: new InMemoryNonceStore() }))
  check('expired credential → 401 AGENT_TOKEN_EXPIRED', !r.ok && r.err.code === 'AGENT_TOKEN_EXPIRED')
}

// ── 6. Disabled installation ─────────────────────────────────────────────
console.log('\n6) Disabled installation')
{
  const { token, loaders } = makeLoaders({ installation: { id: 'inst_1', status: 'Disabled' } })
  const r = await attempt(authInput({ loaders, headers: buildHeaders({ token, nonce: NONCE() }), nonceStore: new InMemoryNonceStore() }))
  check('disabled installation → 403 AGENT_INSTALLATION_DISABLED', !r.ok && r.err.code === 'AGENT_INSTALLATION_DISABLED' && r.err.status === 403)
}

// ── 7. Disabled device ───────────────────────────────────────────────────
console.log('\n7) Disabled device')
{
  const { token, loaders } = makeLoaders({ device: { status: 'Suspended' } })
  const r = await attempt(authInput({ loaders, headers: buildHeaders({ token, nonce: NONCE() }), nonceStore: new InMemoryNonceStore() }))
  check('suspended device → 403 AGENT_DEVICE_REVOKED', !r.ok && r.err.code === 'AGENT_DEVICE_REVOKED' && r.err.status === 403)

  const l2 = makeLoaders({ device: { status: 'Retired' } })
  const r2 = await attempt(authInput({ loaders: l2.loaders, headers: buildHeaders({ token: l2.token, nonce: NONCE() }), nonceStore: new InMemoryNonceStore() }))
  check('retired device → 403 AGENT_DEVICE_REVOKED', !r2.ok && r2.err.code === 'AGENT_DEVICE_REVOKED')

  const l3 = makeLoaders({ device: { status: 'Pending' } })
  const r3 = await attempt(authInput({ loaders: l3.loaders, headers: buildHeaders({ token: l3.token, nonce: NONCE() }), nonceStore: new InMemoryNonceStore() }))
  check('pending device → 403 AGENT_DEVICE_PENDING', !r3.ok && r3.err.code === 'AGENT_DEVICE_PENDING')

  const l4 = makeLoaders({ device: { status: 'Offline' } })
  const r4 = await attempt(authInput({ loaders: l4.loaders, headers: buildHeaders({ token: l4.token, nonce: NONCE() }), nonceStore: new InMemoryNonceStore() }))
  check('offline device still authenticates (connectivity ≠ rejection)', r4.ok)
}

// ── 8. Malformed / missing headers ───────────────────────────────────────
console.log('\n8) Malformed headers')
{
  const { token, loaders } = makeLoaders()
  const base = buildHeaders({ token, nonce: NONCE() })

  const noAuth = { ...base }
  delete noAuth.authorization
  const r1 = await attempt(authInput({ loaders, headers: noAuth, nonceStore: new InMemoryNonceStore() }))
  check('missing Authorization → 401 AGENT_UNAUTHORIZED', !r1.ok && r1.err.code === 'AGENT_UNAUTHORIZED' && r1.err.status === 401)

  const noTs = { ...base }
  delete noTs['x-timestamp']
  const r2 = await attempt(authInput({ loaders, headers: noTs, nonceStore: new InMemoryNonceStore() }))
  check('missing timestamp → 401', !r2.ok && r2.err.status === 401)

  const noNonce = { ...base }
  delete noNonce['x-nonce']
  const r3 = await attempt(authInput({ loaders, headers: noNonce, nonceStore: new InMemoryNonceStore() }))
  check('missing nonce → 401', !r3.ok && r3.err.status === 401)

  const noSig = { ...base }
  delete noSig['x-agent-signature']
  const r4 = await attempt(authInput({ loaders, headers: noSig, nonceStore: new InMemoryNonceStore() }))
  check('missing signature → 401 AGENT_SIGNATURE_INVALID', !r4.ok && r4.err.code === 'AGENT_SIGNATURE_INVALID')

  const noDevice = { ...base }
  delete noDevice['x-device-id']
  const r5 = await attempt(authInput({ loaders, headers: noDevice, nonceStore: new InMemoryNonceStore() }))
  check('missing X-Device-ID → 401', !r5.ok && r5.err.status === 401)
}

// ── 9. Header aliases (X-Agent-Timestamp / X-Agent-Nonce) ────────────────
console.log('\n9) Header aliases')
{
  const { token, loaders } = makeLoaders()
  const r = await attempt(
    authInput({ loaders, headers: buildHeaders({ token, nonce: NONCE(), alias: true }), nonceStore: new InMemoryNonceStore() })
  )
  check('X-Agent-Timestamp + X-Agent-Nonce accepted → authenticates', r.ok)
}

// ── 10. Unknown token ────────────────────────────────────────────────────
console.log('\n10) Unknown token')
{
  const { loaders } = makeLoaders()
  const r = await attempt(
    authInput({ loaders, headers: buildHeaders({ token: generateAgentToken(), nonce: NONCE() }), nonceStore: new InMemoryNonceStore() })
  )
  check('unknown token → 401 AGENT_UNAUTHORIZED', !r.ok && r.err.code === 'AGENT_UNAUTHORIZED')
}

// ── 11. Hash at rest (never plaintext) ───────────────────────────────────
console.log('\n11) Token hashing')
{
  const { token, loaders } = makeLoaders()
  capturedTokenHashes.length = 0
  await attempt(authInput({ loaders, headers: buildHeaders({ token, nonce: NONCE() }), nonceStore: new InMemoryNonceStore() }))
  check('loaders receive SHA-256 hash, never the plaintext token', capturedTokenHashes.length > 0 && capturedTokenHashes.every((h) => h === sha256Hex(token) && h !== token))
  check('hash is 64-char hex', capturedTokenHashes.every((h) => /^[0-9a-f]{64}$/.test(h)))
}

// ── 12. Device / installation mismatch (per-device scoping) ──────────────
console.log('\n12) Per-device scoping')
{
  const { token, loaders } = makeLoaders()
  const r = await attempt(
    authInput({
      loaders,
      headers: buildHeaders({ token, nonce: NONCE(), extra: { 'x-device-id': 'dev_other' } }),
      nonceStore: new InMemoryNonceStore(),
    })
  )
  check('X-Device-ID mismatch → 403 AGENT_DEVICE_MISMATCH', !r.ok && r.err.code === 'AGENT_DEVICE_MISMATCH' && r.err.status === 403)

  const r2 = await attempt(
    authInput({
      loaders,
      headers: buildHeaders({ token, nonce: NONCE(), extra: { 'x-installation-id': 'inst_other' } }),
      nonceStore: new InMemoryNonceStore(),
    })
  )
  check('X-Installation-ID mismatch → 403 AGENT_INSTALLATION_MISMATCH', !r2.ok && r2.err.code === 'AGENT_INSTALLATION_MISMATCH')
}

// ── 13. Error envelope consistency ───────────────────────────────────────
console.log('\n13) Error envelope')
{
  const { token, loaders } = makeLoaders({ device: { status: 'Retired' } })
  const r = await attempt(authInput({ loaders, headers: buildHeaders({ token, nonce: NONCE() }), nonceStore: new InMemoryNonceStore() }))
  check('errors are AgentAuthError (serialize to contract envelope)', r.err instanceof AgentAuthError && isAgentAuthError(r.err))
  const body = r.err.toBody()
  check('envelope has code+message (+details)', body.code === 'AGENT_DEVICE_REVOKED' && typeof body.message === 'string' && body.details?.status === 'Retired')
  check('envelope status is 403', r.err.status === 403)
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`)
if (failed > 0) {
  console.log('Failed:', failures.join(', '))
  process.exit(1)
}
process.exit(0)
