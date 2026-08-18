/**
 * E3 — Agent Heartbeat — Automated Verification (live server)
 *
 * Registers a real device via E1 (join-key flow), then exercises the
 * authenticated heartbeat endpoint end-to-end against a running dev server.
 *
 * Run:  bun scripts/verify-e3.mjs     (bun imports the TS signing lib + fetch)
 * Env:  BASE_URL (default http://localhost:3104) · DB_PATH (default db/custom.db)
 *
 * Covers the mission's checklist:
 *   authenticated heartbeat · revoked token · disabled installation
 *   disabled device · stale timestamp · replay nonce · invalid payload
 *   + Device.lastHeartbeatAt updates · highWaterMark persists · agentVersion updates
 */

import { createHash, randomBytes } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { signAgentRequest } from '../src/lib/agent-auth/signature'
import { sha256Hex } from '../src/lib/agent-auth/tokens'

const BASE = process.env.BASE_URL || 'http://localhost:3104'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const INSTALLATION_ID = 'inst_demo_default'
const JOIN_KEY = 'WL-DEMO-JOINKEY-2026'
const E1_IP = '203.0.113.40'

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

const sha256hex = (s) => createHash('sha256').update(s).digest('hex')
const NONCE = () => Buffer.from(randomBytes(16)).toString('base64url')

const db = new Database(DB_PATH) // read-write by default
const getDevice = (id) => db.query('SELECT * FROM Device WHERE id = ?').get(id)
const getCred = (deviceId) =>
  db.query('SELECT * FROM AgentCredential WHERE deviceId = ? ORDER BY issuedAt DESC LIMIT 1').get(deviceId)
const setCredRevoked = (deviceId, revokedAt) =>
  db.query('UPDATE AgentCredential SET revokedAt = ? WHERE deviceId = ?').run(revokedAt, deviceId)
const setInstallStatus = (status) =>
  db.query('UPDATE Installation SET status = ? WHERE id = ?').run(status, INSTALLATION_ID)
const setDeviceStatus = (deviceId, status) =>
  db.query('UPDATE Device SET status = ? WHERE id = ?').run(status, deviceId)

// ── M005 Stage-5: heartbeat requires an active DeviceAssignment once the device
// is beyond Pending. The setup therefore ACTIVATES the device (admin assigns a
// user via the User.deviceId cursor + E2) right after registration — the mission's
// only valid flow: Register → Activate → Heartbeat → Activity.
let testUserId = null
function assignAndActivate(token, deviceId) {
  return (async () => {
    const id = `usr_e3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    db.query('INSERT INTO User (id, name, email, status, updatedAt) VALUES (?, ?, ?, ?, ?)').run(
      id,
      'E3 Test User',
      `e3-${Date.now()}@test.local`,
      'Active',
      new Date().toISOString()
    )
    testUserId = id
    db.query('UPDATE User SET deviceId = ? WHERE id = ?').run(deviceId, id)
    const body = JSON.stringify({ clientTime: Date.now() })
    const nonce = Buffer.from(randomBytes(16)).toString('base64url')
    const ts = Date.now() // single timestamp — signing and header MUST match (ms-exact)
    const signature = signAgentRequest({
      key: token,
      method: 'POST',
      path: '/api/agent/v1/activate',
      timestamp: ts,
      nonce,
      body,
    })
    const res = await fetch(`${BASE}/api/agent/v1/activate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-installation-id': INSTALLATION_ID,
        'x-device-id': deviceId,
        'x-agent-version': '0.1.0',
        'x-timestamp': String(ts),
        'x-nonce': nonce,
        'x-agent-signature': signature,
        'content-type': 'application/json',
      },
      body,
    })
    return res.status
  })()
}

const HB_PATH = '/api/agent/v1/heartbeat'

async function heartbeat({ token, deviceId, ts = Date.now(), nonce, bodyObj, headers = {} }) {
  const body = JSON.stringify(bodyObj)
  const signature = signAgentRequest({
    key: token,
    method: 'POST',
    path: HB_PATH,
    timestamp: ts,
    nonce,
    body,
  })
  const res = await fetch(`${BASE}${HB_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-installation-id': INSTALLATION_ID,
      'x-device-id': deviceId,
      'x-agent-version': '0.1.0',
      'x-timestamp': String(ts),
      'x-nonce': nonce,
      'x-agent-signature': signature,
      'content-type': 'application/json',
      ...headers,
    },
    body,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, headers: res.headers }
}

const BODY = (extra = {}) => ({
  clientTime: Date.now(),
  uptimeS: 600,
  status: 'online',
  lastAckedSeq: 42,
  agentVersion: '0.2.0',
  platform: 'Windows',
  architecture: 'x64',
  hostname: `HB-${Date.now()}`,
  capabilities: ['activity', 'health'],
  ...extra,
})

console.log('\n=== E3 — Agent Heartbeat — Automated Verification ===\n')
console.log(`Base: ${BASE} | Install: ${INSTALLATION_ID}\n`)

let deviceId
let token

try {
  // ── Setup: register a real device via E1 ───────────────────────────────
  console.log('0) Setup — register device via E1')
  const serial = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await fetch(`${BASE}/api/agent/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': E1_IP },
    body: JSON.stringify({
      installationId: INSTALLATION_ID,
      joinKey: JOIN_KEY,
      clientTime: Date.now(),
      hostname: `VERIFY-E3-${serial}`,
      os: { family: 'Windows', version: '11', build: '22631', arch: 'x64' },
      hardware: { cpu: 'Intel i7-13700K', ramGB: 32, diskGB: 512, mac: 'AA:BB:CC:DD:EE:FF', serial: `SN-E3-${serial}` },
      agentVersion: '0.1.0',
      capabilities: ['activity', 'health'],
    }),
  })
  const regJson = await reg.json().catch(() => ({}))
  check('E1 register → 201', reg.status === 201, `(got ${reg.status})`)
  deviceId = regJson.deviceId
  token = regJson.agentToken
  check('got deviceId + token', !!deviceId && !!token)
  const actStatus = await assignAndActivate(token, deviceId)
  check('E2 activate → 200 (Stage-5 assignment gate setup)', actStatus === 200, `(got ${actStatus})`)
  check('active DeviceAssignment exists', db.query('SELECT count(*) c FROM DeviceAssignment WHERE deviceId = ? AND revokedAt IS NULL').get(deviceId)?.c === 1)

  // ── 1. Authenticated heartbeat ─────────────────────────────────────────
  console.log('\n1) Authenticated heartbeat')
  const t1 = await heartbeat({ token, deviceId, nonce: NONCE(), bodyObj: BODY() })
  check('HTTP 200', t1.status === 200, `(got ${t1.status}) ${JSON.stringify(t1.json.error ?? '')}`)
  check(
    'Response DTO (serverTime/heartbeatIntervalMs/policyVersion/configVersion/commands/timeOffset)',
    typeof t1.json.serverTime === 'number' &&
      t1.json.heartbeatIntervalMs === 30000 &&
      t1.json.policyVersion === 1 &&
      t1.json.configVersion === 1 &&
      Array.isArray(t1.json.commands) &&
      t1.json.commands.length === 0 &&
      t1.json.updateAvailable === false &&
      t1.json.flags?.suspended === false &&
      typeof t1.json.timeOffset === 'number',
    JSON.stringify(Object.keys(t1.json))
  )
  check('timeOffset ≈ serverTime − clientTime (|Δ| < 10 s)', Math.abs(t1.json.timeOffset) < 10000, `(got ${t1.json.timeOffset})`)

  // DB persistence
  const dev1 = getDevice(deviceId)
  const nowMs = Date.now()
  check('Device.status → Online', dev1?.status === 'Online', `(got ${dev1?.status})`)
  check(
    'Device.lastHeartbeatAt updated (recent)',
    !!dev1?.lastHeartbeatAt && Math.abs(nowMs - new Date(dev1.lastHeartbeatAt).getTime()) < 120_000
  )
  check('Device.lastSeen updated (recent)', !!dev1?.lastSeen && Math.abs(nowMs - new Date(dev1.lastSeen).getTime()) < 120_000)
  check('Device.agentVersion updated → 0.2.0', dev1?.agentVersion === '0.2.0', `(got ${dev1?.agentVersion})`)
  check('Device.agentPlatform → Windows', dev1?.agentPlatform === 'Windows')
  check('Device.agentArch → x64', dev1?.agentArch === 'x64')
  check('Device.highWaterMark → 42', dev1?.highWaterMark === 42, `(got ${dev1?.highWaterMark})`)
  check('Device.capabilities persisted', dev1?.capabilities === JSON.stringify(['activity', 'health']))
  const cred1 = getCred(deviceId)
  check('Credential untouched (tokenHash unchanged)', cred1?.tokenHash === sha256hex(token))

  // ── 2. Revoked token ───────────────────────────────────────────────────
  console.log('\n2) Revoked token')
  setCredRevoked(deviceId, new Date().toISOString())
  const t2 = await heartbeat({ token, deviceId, nonce: NONCE(), bodyObj: BODY() })
  check('revoked credential → 401 AGENT_TOKEN_EXPIRED', t2.status === 401 && t2.json.error?.code === 'AGENT_TOKEN_EXPIRED', `(got ${t2.status} ${t2.json.error?.code})`)
  setCredRevoked(deviceId, null) // restore

  // ── 3. Disabled installation ───────────────────────────────────────────
  console.log('\n3) Disabled installation')
  setInstallStatus('Disabled')
  const t3 = await heartbeat({ token, deviceId, nonce: NONCE(), bodyObj: BODY() })
  check('disabled installation → 403 AGENT_INSTALLATION_DISABLED', t3.status === 403 && t3.json.error?.code === 'AGENT_INSTALLATION_DISABLED', `(got ${t3.status} ${t3.json.error?.code})`)
  setInstallStatus('Active') // restore

  // ── 4. Disabled device ─────────────────────────────────────────────────
  console.log('\n4) Disabled device')
  setDeviceStatus(deviceId, 'Suspended')
  const t4 = await heartbeat({ token, deviceId, nonce: NONCE(), bodyObj: BODY() })
  check('suspended device → 403 AGENT_DEVICE_REVOKED', t4.status === 403 && t4.json.error?.code === 'AGENT_DEVICE_REVOKED', `(got ${t4.status} ${t4.json.error?.code})`)
  setDeviceStatus(deviceId, 'Online') // restore

  // ── 5. Stale timestamp (beyond the tolerant 600 s window) ──────────────
  console.log('\n5) Stale timestamp')
  const staleTs = Date.now() - 700_000 // 700 s in the past > 600 s tolerant window
  const t5 = await heartbeat({ token, deviceId, ts: staleTs, nonce: NONCE(), bodyObj: BODY() })
  check('stale timestamp → 429 AGENT_CLOCK_SKEW', t5.status === 429 && t5.json.error?.code === 'AGENT_CLOCK_SKEW', `(got ${t5.status} ${t5.json.error?.code})`)

  // ── 6. Replay nonce ────────────────────────────────────────────────────
  console.log('\n6) Replay nonce')
  const nonce = NONCE()
  const r6a = await heartbeat({ token, deviceId, nonce, bodyObj: BODY() })
  const r6b = await heartbeat({ token, deviceId, nonce, bodyObj: BODY() })
  check('first use → 200', r6a.status === 200)
  check('replayed nonce → 409 AGENT_REPLAY', r6b.status === 409 && r6b.json.error?.code === 'AGENT_REPLAY', `(got ${r6b.status} ${r6b.json.error?.code})`)

  // ── 7. Invalid payload ─────────────────────────────────────────────────
  console.log('\n7) Invalid payload')
  const t7 = await heartbeat({ token, deviceId, nonce: NONCE(), bodyObj: { clientTime: Date.now(), uptimeS: -5 } })
  check('negative uptimeS → 422 AGENT_VALIDATION', t7.status === 422 && t7.json.error?.code === 'AGENT_VALIDATION', `(got ${t7.status} ${t7.json.error?.code})`)
  const t7b = await heartbeat({ token, deviceId, nonce: NONCE(), bodyObj: { cpuUsage: 150 } })
  check('cpuUsage > 100 → 422 AGENT_VALIDATION', t7b.status === 422 && t7b.json.error?.code === 'AGENT_VALIDATION')

  // ── 8. highWaterMark persists (monotonic — never decreases) ────────────
  console.log('\n8) highWaterMark persistence')
  const t8 = await heartbeat({ token, deviceId, nonce: NONCE(), bodyObj: BODY({ highWaterMark: 5 }) })
  check('heartbeat with hwm=5 → 200', t8.status === 200)
  const dev8 = getDevice(deviceId)
  check('highWaterMark stays 42 (not lowered)', dev8?.highWaterMark === 42, `(got ${dev8?.highWaterMark})`)
  const t8b = await heartbeat({ token, deviceId, nonce: NONCE(), bodyObj: BODY({ highWaterMark: 99 }) })
  check('heartbeat with hwm=99 → 200', t8b.status === 200)
  const dev8b = getDevice(deviceId)
  check('highWaterMark advances to 99', dev8b?.highWaterMark === 99, `(got ${dev8b?.highWaterMark})`)

  // ── 9. X-Token-Expires header when credential is near expiry ────────────
  console.log('\n9) X-Token-Expires header')
  db.query('UPDATE AgentCredential SET expiresAt = ? WHERE deviceId = ?').run(
    new Date(Date.now() + 5 * 86400000).toISOString(),
    deviceId
  )
  const t9 = await heartbeat({ token, deviceId, nonce: NONCE(), bodyObj: BODY() })
  check('heartbeat near token expiry → 200', t9.status === 200)
  check(
    'X-Token-Expires header present near expiry',
    (t9.headers?.get('x-token-expires') ?? '') !== '',
    `(got ${t9.headers?.get('x-token-expires') ?? 'none'})`
  )
  db.query('UPDATE AgentCredential SET expiresAt = ? WHERE deviceId = ?').run(
    new Date(Date.now() + 180 * 86400000).toISOString(),
    deviceId
  )

  // ── 10. lastKnownIp falls back to the observed request IP ───────────────
  console.log('\n10) lastKnownIp fallback')
  db.query('UPDATE Device SET ipAddress = NULL WHERE id = ?').run(deviceId)
  const t10 = await heartbeat({
    token,
    deviceId,
    nonce: NONCE(),
    bodyObj: BODY(), // no ipAddress in body → server falls back to X-Forwarded-For
    headers: { 'x-forwarded-for': '198.51.100.77' },
  })
  check('fallback heartbeat → 200', t10.status === 200)
  const dev10 = getDevice(deviceId)
  check('Device.ipAddress = observed X-Forwarded-For IP', dev10?.ipAddress === '198.51.100.77', `(got ${dev10?.ipAddress})`)
} finally {
  // ── Cleanup (keep demo data intact) ────────────────────────────────────
  console.log('\n--- Cleanup ---')
  if (deviceId) {
    db.query('DELETE FROM DeviceAssignment WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM AgentCredential WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM Device WHERE id = ?').run(deviceId)
  }
  if (testUserId) db.query('DELETE FROM User WHERE id = ?').run(testUserId)
  setInstallStatus('Active')
  const remaining = db.query('SELECT count(*) c FROM Device').get().c
  const creds = db.query('SELECT count(*) c FROM AgentCredential').get().c
  console.log(`  Removed test device. Devices remaining: ${remaining} | credentials: ${creds}`)
  db.close()
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`)
if (failed > 0) {
  console.log('Failed:', failures.join(', '))
  process.exit(1)
}
process.exit(0)
