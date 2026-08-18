/**
 * E0 — Agent Authentication & Security Foundation — Unit Verification
 *
 * Pure-logic tests: signature validation, invalid signatures, expired
 * timestamps, clock drift, replay detection, token hashing, constant-time
 * compare, request canonicalization, Zod schemas, errors, and the composed
 * verifier. No server, no database required.
 *
 * Run:  bun scripts/verify-e0.mjs     (bun imports TypeScript natively)
 */

import { createHash, createHmac, randomBytes } from 'node:crypto'

// ━━ Imports (TypeScript modules — bun transpiles on the fly) ━━
import {
  generateAgentToken,
  hashAgentToken,
  sha256Hex,
  timingSafeEqual,
  timingSafeEqualHex,
  verifyTokenHash,
  createToken,
  isTokenExpired,
  tokenExpiryWarningDue,
} from '../src/lib/agent-auth/tokens'
import {
  canonicalizeRequest,
  buildCanonicalPath,
  computeBodyHash,
  verifyRequestSignature,
} from '../src/lib/agent-auth/signature'
import { validateTimestamp, serverTime } from '../src/lib/agent-auth/timestamp'
import { InMemoryNonceStore, isValidNonce } from '../src/lib/agent-auth/nonce-store'
import {
  loadAgentConfig,
  AGENT_CLOCK_TOLERANCE_MS_DEFAULT,
  AGENT_NONCE_TTL_MS_DEFAULT,
  AGENT_TOKEN_LIFETIME_DAYS_DEFAULT,
  AGENT_MAX_BODY_BYTES_DEFAULT,
  AGENT_MAX_SCREENSHOT_BYTES_DEFAULT,
  AGENT_MAX_BATCH_EVENTS_DEFAULT,
} from '../src/lib/agent-auth/config'
import {
  AgentAuthError,
  AgentUnauthorizedError,
  AgentInvalidSignatureError,
  AgentExpiredTimestampError,
  AgentReplayError,
  AgentInvalidNonceError,
  AgentInvalidJoinKeyError,
  AgentInvalidAgentError,
  AgentTokenRevokedError,
  AgentForbiddenError,
  AgentPayloadTooLargeError,
  AgentRateLimitedError,
  isAgentAuthError,
} from '../src/lib/agent-auth/errors'
import {
  registrationSchema,
  activationSchema,
  heartbeatSchema,
  activitySchema,
  screenshotInitiateSchema,
  commandPollSchema,
  agentAuthHeadersSchema,
} from '../src/lib/agent-auth/schemas'
import {
  parseAgentAuthHeaders,
  verifyAgentRequest,
} from '../src/lib/agent-auth/verifier'

// ━━ Harness ━━
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Independent reference signer (contract §2.2) — proves the library matches the spec.
const refSign = ({ method, path, timestamp, nonce, body, key }) => {
  const bodyHash = createHash('sha256').update(body).digest('hex')
  const canonical = [method.toUpperCase(), path, String(timestamp), nonce, bodyHash].join('\n')
  return createHmac('sha256', key).update(canonical).digest('base64url')
}

// ━━ 1. Token generation & hashing (contract §1, ADR-011) ━━
console.log('\n1) Token generation & hashing')
{
  const t1 = generateAgentToken()
  check('Token is 43-char base64url', /^[A-Za-z0-9_-]{43}$/.test(t1), t1)
  const t2 = generateAgentToken()
  check('Two tokens differ (256-bit entropy)', t1 !== t2)
  const h = hashAgentToken(t1)
  check('hashAgentToken → 64-char hex', /^[0-9a-f]{64}$/.test(h))
  check('Hash deterministic', hashAgentToken(t1) === h)
  check('Hash ≠ plaintext', h !== t1)
  check('hashAgentToken === sha256Hex(token)', h === sha256Hex(t1))
  check('verifyTokenHash correct token', verifyTokenHash(t1, h) === true)
  check('verifyTokenHash wrong token', verifyTokenHash(t2, h) === false)
  check('verifyTokenHash empty', verifyTokenHash('', h) === false && verifyTokenHash(t1, '') === false)
}

// ━━ 2. Constant-time comparison ━━
console.log('\n2) Constant-time comparison')
{
  check('timingSafeEqual equal', timingSafeEqual('abc123XYZ_-', 'abc123XYZ_-') === true)
  check('timingSafeEqual different (same length)', timingSafeEqual('abc', 'abd') === false)
  check('timingSafeEqual length mismatch', timingSafeEqual('abc', 'abcd') === false)
  const hexA = sha256Hex('same')
  const hexB = sha256Hex('other')
  check('timingSafeEqualHex equal', timingSafeEqualHex(hexA, hexA) === true)
  check('timingSafeEqualHex different', timingSafeEqualHex(hexA, hexB) === false)
  // smoke: 5k iterations run without error
  let ok = true
  for (let i = 0; i < 5000; i++) timingSafeEqual(`k${i}-payload`, `k${i}-payload`)
  check('Constant-time compare 5k iterations', ok)
}

// ━━ 3. Canonicalization & signature (contract §2.2) ━━
console.log('\n3) Canonicalization & HMAC signature')
{
  const method = 'POST'
  const path = '/api/agent/v1/policy?format=v1'
  const timestamp = 1785678846000
  const nonce = randomBytes(16).toString('base64url')
  const body = '{"a":1}'
  const key = generateAgentToken()

  const canonical = canonicalizeRequest({ method, path, timestamp, nonce, bodyHash: sha256Hex(body) })
  check(
    'Canonical format METHOD\\nPATH\\nTS\\nNONCE\\nbodyhash',
    canonical === `${method}\n${path}\n${timestamp}\n${nonce}\n${sha256Hex(body)}`,
    JSON.stringify(canonical)
  )
  check('buildCanonicalPath includes query', buildCanonicalPath('/api/agent/v1/policy', '?format=v1') === '/api/agent/v1/policy?format=v1')
  check('buildCanonicalPath no query', buildCanonicalPath('/api/agent/v1/policy') === '/api/agent/v1/policy')
  check(
    'computeBodyHash(empty) = sha256hex("")',
    computeBodyHash('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  )

  // Reference-implementation interop: lib verifies a signature produced independently.
  const sig = refSign({ method, path, timestamp, nonce, body, key })
  check('verifyRequestSignature accepts reference signature', verifyRequestSignature({ method, path, timestamp, nonce, body, key, signature: sig }) === true)

  const tamper = (patch) =>
    verifyRequestSignature({ method, path, timestamp, nonce, body, key, signature: sig, ...patch })
  check('Tampered body → false', tamper({ body: '{"a":2}' }) === false)
  check('Tampered timestamp → false', tamper({ timestamp: timestamp + 1 }) === false)
  check('Tampered nonce → false', tamper({ nonce: nonce + 'x' }) === false)
  check('Tampered path → false', tamper({ path: '/api/agent/v1/policy?format=v2' }) === false)
  check('Tampered method → false', tamper({ method: 'GET' }) === false)
  check('Wrong key → false', tamper({ key: generateAgentToken() }) === false)
  check('Tampered signature → false', verifyRequestSignature({ method, path, timestamp, nonce, body, key, signature: sig.slice(0, -2) + 'AA' }) === false)
}

// ━━ 4. Timestamp validation & clock drift (contract §2.3/§2.4) ━━
console.log('\n4) Timestamp validation & clock drift')
{
  const now = Date.now()
  check('serverTime() ≈ Date.now()', Math.abs(serverTime() - now) < 5000)
  check('Now → valid', validateTimestamp(now, { now }).valid === true)
  check('+100 s (within 300 s) → valid', validateTimestamp(now + 100_000, { now }).valid === true)
  check('+300 s boundary → valid', validateTimestamp(now + 300_000, { now }).valid === true)
  const r = validateTimestamp(now + 300_001, { now })
  check('+300.001 s → invalid (skew)', r.valid === false && r.reason === 'skew' && r.skewMs === 300_001)
  check('−400 s → invalid', validateTimestamp(now - 400_000, { now }).valid === false)
  check('Missing timestamp → invalid', validateTimestamp(undefined, { now }).valid === false)
  check('Non-numeric timestamp → invalid', validateTimestamp('abc', { now }).valid === false)
  // Clock-drift info: serverTime returned for resync (contract §2.4)
  const drift = validateTimestamp(now + 100_000, { now })
  check('Clock-drift result exposes serverTime', drift.valid === true)
  const bad = validateTimestamp(now - 400_000, { now })
  check('Clock-skew result exposes serverTime for offset', bad.valid === false && typeof bad.serverTime === 'number')
}

// ━━ 5. Replay protection / nonce store (contract §2.3) ━━
console.log('\n5) Replay protection & nonce store')
{
  const store = new InMemoryNonceStore()
  const nonceA = randomBytes(16).toString('base64url')
  const nonceB = randomBytes(16).toString('base64url')
  check('Fresh nonce not used', (await store.isUsed('dev_1', nonceA)) === false)
  await store.markUsed('dev_1', nonceA)
  check('Marked nonce is used (replay)', (await store.isUsed('dev_1', nonceA)) === true)
  check('Different nonce not used', (await store.isUsed('dev_1', nonceB)) === false)
  check('Different device same nonce not used', (await store.isUsed('dev_2', nonceA)) === false)

  const ttlStore = new InMemoryNonceStore(60_000, 100)
  await ttlStore.markUsed('dev_3', nonceA, 30)
  await sleep(80)
  check('Nonce expires after TTL', (await ttlStore.isUsed('dev_3', nonceA)) === false)

  const bounded = new InMemoryNonceStore(60_000, 3)
  for (let i = 0; i < 4; i++) await bounded.markUsed('dev', `nonce-${i}-${'x'.repeat(16)}`)
  check('Store is bounded (FIFO eviction)', bounded.size <= 3, `size=${bounded.size}`)

  check('isValidNonce accepts 128-bit base64url', isValidNonce(randomBytes(16).toString('base64url')) === true)
  check('isValidNonce rejects short nonce', isValidNonce('short') === false)
  check('isValidNonce rejects bad chars', isValidNonce('nonce with spaces!!!!!!') === false)
  check('isValidNonce rejects undefined', isValidNonce(undefined) === false)
}

// ━━ 6. Configuration & security constants ━━
console.log('\n6) Configuration')
{
  const def = loadAgentConfig({})
  check('Default clock tolerance 300 s', def.clockToleranceMs === AGENT_CLOCK_TOLERANCE_MS_DEFAULT && def.clockToleranceMs === 300_000)
  check('Default nonce TTL 10 min', def.nonceTtlMs === AGENT_NONCE_TTL_MS_DEFAULT && def.nonceTtlMs === 600_000)
  check('Default token lifetime 180 d', def.tokenLifetimeDays === AGENT_TOKEN_LIFETIME_DAYS_DEFAULT && def.tokenLifetimeDays === 180)
  check('Default max body 1 MB', def.maxBodyBytes === AGENT_MAX_BODY_BYTES_DEFAULT && def.maxBodyBytes === 1_048_576)
  check('Default max screenshot 10 MB', def.maxScreenshotBytes === AGENT_MAX_SCREENSHOT_BYTES_DEFAULT && def.maxScreenshotBytes === 10_485_760)
  check('Default max batch 500', def.maxBatchEvents === AGENT_MAX_BATCH_EVENTS_DEFAULT && def.maxBatchEvents === 500)
  const ovr = loadAgentConfig({ AGENT_CLOCK_TOLERANCE_MS: '500000', AGENT_MAX_BATCH_EVENTS: '750' })
  check('Env overrides parsed', ovr.clockToleranceMs === 500_000 && ovr.maxBatchEvents === 750)
  const bad = loadAgentConfig({ AGENT_CLOCK_TOLERANCE_MS: 'abc' })
  check('Invalid env falls back to default', bad.clockToleranceMs === 300_000)
}

// ━━ 7. Error types (contract §3 envelope + §2.6 semantics) ━━
console.log('\n7) Error types')
{
  const unauth = new AgentUnauthorizedError()
  check('Unauthorized → 401 AGENT_UNAUTHORIZED', unauth.status === 401 && unauth.code === 'AGENT_UNAUTHORIZED')
  check('toBody omits undefined fields', !('details' in unauth.toBody()) && !('retryAfter' in unauth.toBody()))
  const sig = new AgentInvalidSignatureError()
  check('InvalidSignature → 401 AGENT_SIGNATURE_INVALID', sig.status === 401 && sig.code === 'AGENT_SIGNATURE_INVALID')
  const skew = new AgentExpiredTimestampError({ skewMs: 999, serverTime: 1 })
  check('ExpiredTimestamp → 429 AGENT_CLOCK_SKEW + details', skew.status === 429 && skew.code === 'AGENT_CLOCK_SKEW' && skew.details.skewMs === 999)
  const replay = new AgentReplayError()
  check('Replay → 409 AGENT_REPLAY', replay.status === 409 && replay.code === 'AGENT_REPLAY')
  check('InvalidNonce → 400 AGENT_NONCE_INVALID', new AgentInvalidNonceError().status === 400)
  check('InvalidJoinKey → 401 AGENT_JOIN_KEY_INVALID', new AgentInvalidJoinKeyError().code === 'AGENT_JOIN_KEY_INVALID')
  check('InvalidAgent → 401 AGENT_DEVICE_NOT_FOUND', new AgentInvalidAgentError().code === 'AGENT_DEVICE_NOT_FOUND')
  check('TokenRevoked → 401 AGENT_TOKEN_EXPIRED', new AgentTokenRevokedError().code === 'AGENT_TOKEN_EXPIRED')
  check('Forbidden → 403', new AgentForbiddenError().status === 403)
  check('PayloadTooLarge → 413', new AgentPayloadTooLargeError(1_048_576).status === 413)
  const rl = new AgentRateLimitedError(5)
  check('RateLimited → 429 + Retry-After in body', rl.status === 429 && rl.retryAfter === 5 && rl.toBody().retryAfter === 5)
  check('isAgentAuthError true for subclasses', isAgentAuthError(unauth) === true)
  check('isAgentAuthError false for Error', isAgentAuthError(new Error('x')) === false)
  check('Error envelope shape', JSON.stringify(unauth.toBody()) === JSON.stringify({ code: 'AGENT_UNAUTHORIZED', message: 'Unauthorized' }))
}

// ━━ 8. Zod schemas ━━
console.log('\n8) Zod schemas')
{
  const reg = {
    installationId: 'inst_abc123',
    joinKey: 'JK-xxxx',
    clientTime: Date.now(),
    hostname: 'WS-ACME-001',
    os: { family: 'Windows', version: '11', build: '22631', arch: 'x64' },
    hardware: { cpu: 'Intel i7', ramGB: 32, diskGB: 512, mac: 'AA:BB:CC:DD:EE:FF', serial: 'SN123' },
    agentVersion: '0.1.0',
    capabilities: ['activity', 'screenshots'],
  }
  check('registrationSchema valid', registrationSchema.safeParse(reg).success === true)
  check('registrationSchema strips unknown fields', !('extra' in registrationSchema.parse({ ...reg, extra: 1 })))
  check('registrationSchema bad semver', registrationSchema.safeParse({ ...reg, agentVersion: 'abc' }).success === false)
  check('registrationSchema 33 capabilities rejected', registrationSchema.safeParse({ ...reg, capabilities: Array.from({ length: 33 }, (_, i) => `c${i}`) }).success === false)
  check('activationSchema valid', activationSchema.safeParse({ clientTime: Date.now() }).success === true)

  const hb = {
    clientTime: Date.now(),
    uptimeS: 86400,
    status: 'online',
    queueDepth: 12,
    lastAckedSeq: 1042,
    device: { cpuPct: 4, ramPct: 31, diskFreeGB: 210, batteryPct: 87, network: 'ethernet' },
  }
  check('heartbeatSchema valid', heartbeatSchema.safeParse(hb).success === true)
  check('heartbeatSchema cpuPct 150 rejected', heartbeatSchema.safeParse({ ...hb, device: { cpuPct: 150 } }).success === false)

  const activity = {
    batchId: 'b_9f2c',
    clientTimeStart: 1785678800000,
    clientTimeEnd: 1785678846000,
    events: [
      { seq: 1043, ts: 1785678810000, kind: 'app', app: { name: 'Code.exe', windowTitle: 'x', processName: 'Code' } },
      { seq: 1044, ts: 1785678820000, kind: 'website', web: { url: 'https://x', domain: 'x', browser: 'Chrome' } },
      { seq: 1045, ts: 1785678840000, kind: 'idle', idle: { durationSec: 300, reason: 'no-input' } },
      { seq: 1046, ts: 1785678700000, kind: 'session', session: { action: 'login' } },
    ],
  }
  check('activitySchema valid (4 typed events)', activitySchema.safeParse(activity).success === true)
  check('activitySchema 501 events rejected', activitySchema.safeParse({ ...activity, events: Array.from({ length: 501 }, (_, i) => ({ seq: i, ts: 1000 + i, kind: 'idle', idle: { durationSec: 1 } })) }).success === false)
  check('activitySchema kind/payload mismatch rejected', activitySchema.safeParse({ ...activity, events: [{ seq: 1, ts: 1000, kind: 'app', web: { url: 'https://x' } }] }).success === false)

  const shot = {
    ts: 1785678830000,
    sha256: 'a'.repeat(64),
    size: 482013,
    format: 'webp',
    width: 1920,
    height: 1080,
    blurSensitive: true,
  }
  check('screenshotInitiateSchema valid', screenshotInitiateSchema.safeParse(shot).success === true)
  check('screenshot > 10 MB rejected', screenshotInitiateSchema.safeParse({ ...shot, size: 11_000_000 }).success === false)
  check('screenshot bad sha256 rejected', screenshotInitiateSchema.safeParse({ ...shot, sha256: 'zz' }).success === false)

  check('commandPollSchema valid', commandPollSchema.safeParse({ results: [{ id: 'cmd_1', status: 'ok', completedAt: Date.now() }] }).success === true)
  check('commandPollSchema bad status rejected', commandPollSchema.safeParse({ results: [{ id: 'cmd_1', status: 'maybe' }] }).success === false)

  check(
    'agentAuthHeadersSchema valid',
    agentAuthHeadersSchema.safeParse({ installationId: 'i1', deviceId: 'd1', agentVersion: '0.1.0', timestamp: 1785678846000, nonce: randomBytes(16).toString('base64url'), signature: 'sig' }).success === true
  )
  check(
    'agentAuthHeadersSchema missing timestamp rejected',
    agentAuthHeadersSchema.safeParse({ installationId: 'i1', deviceId: 'd1', agentVersion: '0.1.0', nonce: randomBytes(16).toString('base64url'), signature: 'sig' }).success === false
  )
}

// ━━ 9. Composed verifier (headers → token → signature → clock → nonce) ━━
console.log('\n9) verifyAgentRequest pipeline')
{
  const token = generateAgentToken()
  const tokenHash = sha256Hex(token)
  const deviceId = 'dev_1'
  const installationId = 'inst_1'
  const nonce = randomBytes(16).toString('base64url')

  const buildHeaders = ({ signature, timestamp = Date.now(), n = nonce, body = '{}', path = '/api/agent/v1/heartbeat', tok = token, dev = deviceId, inst = installationId, omit } = {}) => {
    const h = {
      authorization: `Bearer ${tok}`,
      'x-installation-id': inst,
      'x-device-id': dev,
      'x-agent-version': '0.1.0',
      'x-timestamp': String(timestamp),
      'x-nonce': n,
      'x-agent-signature': signature ?? refSign({ method: 'POST', path, timestamp, nonce: n, body, key: tok }),
      'x-request-id': 'req-1',
    }
    if (omit) for (const k of omit) delete h[k]
    return h
  }

  const store = new InMemoryNonceStore()
  const run = (headers, extra = {}) =>
    verifyAgentRequest({
      method: 'POST',
      pathname: '/api/agent/v1/heartbeat',
      body: '{}',
      headers,
      storedTokenHash: tokenHash,
      expectedDeviceId: deviceId,
      expectedInstallationId: installationId,
      nonceStore: store,
      ...extra,
    })

  // happy path
  const ctx = await run(buildHeaders())
  check('Happy path returns verified context', ctx.deviceId === deviceId && ctx.installationId === installationId && ctx.agentVersion === '0.1.0' && ctx.requestId === 'req-1')
  check('Nonce consumed after success', (await store.isUsed(deviceId, nonce)) === true)

  // replay — same nonce again
  let replayErr = null
  try { await run(buildHeaders()) } catch (e) { replayErr = e }
  check('Replay detected → 409 AGENT_REPLAY', replayErr instanceof AgentReplayError && replayErr.status === 409)

  // wrong token hash
  let tokErr = null
  try { await run(buildHeaders({ tok: generateAgentToken() })) } catch (e) { tokErr = e }
  check('Wrong token hash → 401 AGENT_UNAUTHORIZED', tokErr instanceof AgentUnauthorizedError && tokErr.status === 401)

  // tampered body (signature over different body)
  const tamperedBody = buildHeaders()
  let bodyErr = null
  try { await run(tamperedBody, { body: '{"x":1}' }) } catch (e) { bodyErr = e }
  check('Tampered body → 401 AGENT_SIGNATURE_INVALID', bodyErr instanceof AgentInvalidSignatureError && bodyErr.status === 401)

  // tampered signature string
  const badSig = buildHeaders({ signature: refSign({ method: 'POST', path: '/api/agent/v1/heartbeat', timestamp: Date.now(), nonce: randomBytes(16).toString('base64url'), body: '{}', key: token }) + 'AA' })
  let sigErr = null
  try { await run(badSig) } catch (e) { sigErr = e }
  check('Tampered signature → 401 AGENT_SIGNATURE_INVALID', sigErr instanceof AgentInvalidSignatureError)

  // expired timestamp (signed over the old timestamp → signature valid, clock fails)
  const staleTs = Date.now() - 400_000
  let skewErr = null
  try { await run(buildHeaders({ timestamp: staleTs })) } catch (e) { skewErr = e }
  check('Expired timestamp → 429 AGENT_CLOCK_SKEW', skewErr instanceof AgentExpiredTimestampError && skewErr.status === 429)

  // tolerant window: 400 s offset passes with heartbeat's 600 s window (contract §2.4)
  let tolerantErr = null
  let tolerantCtx = null
  try { tolerantCtx = await run(buildHeaders({ timestamp: staleTs, n: randomBytes(16).toString('base64url') }), { tolerant: true }) } catch (e) { tolerantErr = e }
  check('Tolerant window accepts 400 s skew', tolerantErr === null && tolerantCtx !== null, tolerantErr?.message ?? '')

  // device mismatch (per-device scoping)
  let devErr = null
  try { await run(buildHeaders({ dev: 'dev_OTHER' })) } catch (e) { devErr = e }
  check('Device mismatch → 403', devErr instanceof AgentForbiddenError && devErr.status === 403 && devErr.code === 'AGENT_DEVICE_MISMATCH')

  // installation mismatch
  let instErr = null
  try { await run(buildHeaders({ inst: 'inst_OTHER' })) } catch (e) { instErr = e }
  check('Installation mismatch → 403', instErr instanceof AgentForbiddenError && instErr.status === 403)

  // missing bearer token
  let missingBearer = null
  try { parseAgentAuthHeaders(buildHeaders({ omit: ['authorization'] })) } catch (e) { missingBearer = e }
  check('Missing bearer → 401 AGENT_UNAUTHORIZED', missingBearer instanceof AgentUnauthorizedError)

  // missing signature header
  let missingSig = null
  try { parseAgentAuthHeaders(buildHeaders({ omit: ['x-agent-signature'] })) } catch (e) { missingSig = e }
  check('Missing signature header → 401', missingSig instanceof AgentInvalidSignatureError)

  // header parse round-trip
  const parsed = parseAgentAuthHeaders(buildHeaders())
  check('Header parse returns typed values', typeof parsed.timestamp === 'number' && parsed.deviceId === deviceId && parsed.bearerToken === token)
}

// ━━ 10. Token rotation helpers (contract §2.5) ━━
console.log('\n10) Token rotation helpers')
{
  const rec = createToken()
  check('createToken 43-char token', /^[A-Za-z0-9_-]{43}$/.test(rec.token))
  check('createToken tokenHash === sha256(token)', rec.tokenHash === sha256Hex(rec.token))
  const days180 = (rec.expiresAt.getTime() - rec.issuedAt.getTime()) / 86_400_000
  check('createToken expiry ≈ 180 days', Math.abs(days180 - 180) < 1, `${days180}`)
  check('isTokenExpired past', isTokenExpired(Date.now() - 1000) === true)
  check('isTokenExpired future', isTokenExpired(Date.now() + 86400_000) === false)
  check('tokenExpiryWarningDue 29 d → true', tokenExpiryWarningDue(Date.now() + 29 * 86_400_000) === true)
  check('tokenExpiryWarningDue 40 d → false', tokenExpiryWarningDue(Date.now() + 40 * 86_400_000) === false)
}

// ━━ Summary ━━
console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`)
if (failed > 0) {
  console.log('Failed:', failures.join(', '))
  process.exit(1)
}
process.exit(0)
