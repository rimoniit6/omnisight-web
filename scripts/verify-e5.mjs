/**
 * E5 — Activity Ingestion — Automated Verification (live server)
 *
 * Registers a real device via E1, heartbeats it online via E3, then exercises
 * the authenticated activity endpoint end-to-end against a running dev server.
 *
 * Run:  bun scripts/verify-e5.mjs
 * Env:  BASE_URL (default http://localhost:3106) · DB_PATH (default db/custom.db)
 *
 * Covers the mission's checklist:
 *   valid batch · duplicate seq · replay batch · out-of-order seq
 *   malformed event · oversized batch · transaction rollback
 *   + ActivityEvent row count · Device.highWaterMark · duplicate protection
 *   + gzip body · all-rejected (HWM unchanged) · payload-too-large
 *
 * NOTE on seq numbering: contract E5 counts seq ≤ highWaterMark as a duplicate
 * (already-acked). Each scenario therefore uses seqs ABOVE the running HWM so
 * it exercises "accepted" paths; ≤HWM resends are the duplicate tests.
 */

import { createHash, randomBytes } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { Database } from 'bun:sqlite'
import { signAgentRequest } from '../src/lib/agent-auth/signature'

const BASE = process.env.BASE_URL || 'http://localhost:3106'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const INSTALLATION_ID = 'inst_demo_default'
const JOIN_KEY = 'WL-DEMO-JOINKEY-2026'
const E1_IP = '203.0.113.60'

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

const NONCE = () => Buffer.from(randomBytes(16)).toString('base64url')

const db = new Database(DB_PATH)
const getDevice = (id) => db.query('SELECT * FROM Device WHERE id = ?').get(id)
const countEvents = (deviceId) =>
  db.query('SELECT count(*) c FROM ActivityEvent WHERE deviceId = ?').get(deviceId)?.c ?? 0
const eventSeqs = (deviceId) =>
  db
    .query('SELECT seq, kind, type, title, source, receivedAt, timestamp FROM ActivityEvent WHERE deviceId = ?')
    .all(deviceId)

const ACT_PATH = '/api/agent/v1/activity'

// ── M005 Stage-5: activity requires an active DeviceAssignment (assignment is
// authorization; Device.status is presence only). Setup therefore ACTIVATES the
// device (server resolves the user via the User.deviceId cursor + E2) right after
// registration — the mission's only valid flow: Register → Activate → Heartbeat →
// Activity. Mirrors the assignAndActivate helper in verify-e3.mjs.
let testUserId = null
async function assignAndActivate(token, deviceId) {
  const id = `usr_e5_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  db.query('INSERT INTO User (id, name, email, status, updatedAt) VALUES (?, ?, ?, ?, ?)').run(
    id,
    'E5 Test User',
    `e5-${Date.now()}@test.local`,
    'Active',
    new Date().toISOString()
  )
  testUserId = id
  db.query('UPDATE User SET deviceId = ? WHERE id = ?').run(deviceId, id)
  const body = JSON.stringify({ clientTime: Date.now() })
  const nonce = NONCE()
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
}

async function signedRequest({ token, deviceId, path, body, nonce, ts = Date.now(), headers = {}, gzip = false }) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
  const wireBody = gzip ? gzipSync(bodyStr) : bodyStr
  const signature = signAgentRequest({
    key: token,
    method: 'POST',
    path,
    timestamp: ts,
    nonce,
    body: bodyStr, // canonical = decompressed/pre-gzip body (contract §2.2)
  })
  const res = await fetch(`${BASE}${path}`, {
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
      ...(gzip ? { 'content-encoding': 'gzip' } : {}),
      ...headers,
    },
    body: wireBody,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, headers: res.headers }
}

async function heartbeat(token, deviceId) {
  const body = JSON.stringify({ clientTime: Date.now(), status: 'online' })
  const nonce = NONCE()
  const ts = Date.now() // single timestamp — signing and header MUST match (ms-exact)
  const signature = signAgentRequest({
    key: token,
    method: 'POST',
    path: '/api/agent/v1/heartbeat',
    timestamp: ts,
    nonce,
    body,
  })
  const res = await fetch(`${BASE}/api/agent/v1/heartbeat`, {
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
}

// Contract typed events
const TYPED_EVENTS = [
  {
    seq: 1,
    ts: Date.now(),
    kind: 'app',
    app: { name: 'Code.exe', windowTitle: 'schema.prisma', processName: 'Code', durationSec: 120, focusSec: 118 },
  },
  { seq: 2, ts: Date.now() - 1000, kind: 'website', web: { url: 'https://developer.mozilla.org/', domain: 'developer.mozilla.org', browser: 'Chrome', durationSec: 60, focusSec: 55 } },
  { seq: 3, ts: Date.now() - 2000, kind: 'idle', idle: { durationSec: 300, reason: 'no-input' } },
]
// Mission flat events
const FLAT_EVENTS = [
  {
    seq: 4,
    timestamp: Date.now() - 3000,
    kind: 'app',
    title: 'Slack.exe',
    application: 'Slack',
    windowTitle: '#engineering',
    duration: 90,
    isIdle: false,
    payload: { channel: '#engineering' },
  },
  { seq: 5, timestamp: Date.now() - 4000, kind: 'session', title: 'login', isIdle: false, payload: { action: 'login' } },
]

console.log('\n=== E5 — Activity Ingestion — Automated Verification ===\n')
console.log(`Base: ${BASE} | Install: ${INSTALLATION_ID}\n`)

let deviceId
let token

try {
  // ── Setup: register via E1 + heartbeat online (E5 default rejects Pending) ──
  console.log('0) Setup — register device via E1, heartbeat online via E3')
  const serial = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await fetch(`${BASE}/api/agent/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': E1_IP },
    body: JSON.stringify({
      installationId: INSTALLATION_ID,
      joinKey: JOIN_KEY,
      clientTime: Date.now(),
      hostname: `VERIFY-E5-${serial}`,
      os: { family: 'Windows', version: '11', build: '22631', arch: 'x64' },
      hardware: { cpu: 'Intel i7-13700K', ramGB: 32, diskGB: 512, mac: 'AA:BB:CC:DD:EE:FF', serial: `SN-E5-${serial}` },
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
  const hb = await heartbeat(token, deviceId)
  check('E3 heartbeat → 200 (device Online for data ingest)', hb === 200, `(got ${hb})`)
  check('Device status → Online', getDevice(deviceId)?.status === 'Online')

  // ── 1. Valid batch (typed + flat events) ─────────────────────────────────
  console.log('\n1) Valid batch')
  const b1 = await signedRequest({
    token,
    deviceId,
    path: ACT_PATH,
    body: { batchId: 'b_valid_1', events: [...TYPED_EVENTS, ...FLAT_EVENTS] },
    nonce: NONCE(),
  })
  check('HTTP 202', b1.status === 202, `(got ${b1.status}) ${JSON.stringify(b1.json.error ?? '')}`)
  check('accepted=5, duplicates=0, rejected=[]', b1.json.accepted === 5 && b1.json.duplicates === 0 && Array.isArray(b1.json.rejected) && b1.json.rejected.length === 0, JSON.stringify({ a: b1.json.accepted, d: b1.json.duplicates, r: b1.json.rejected }))
  check('Response envelope (batchId/highWaterMark/serverTime)', b1.json.batchId === 'b_valid_1' && b1.json.highWaterMark === 5 && typeof b1.json.serverTime === 'number')
  let rows = eventSeqs(deviceId)
  check('5 rows persisted', rows.length === 5, `(got ${rows.length})`)
  check('all source="agent"', rows.every((r) => r.source === 'agent'))
  check('receivedAt set (server clock)', rows.every((r) => !!r.receivedAt))
  check('timestamp = event ts (unclamped)', Math.abs(new Date(rows.find((r) => r.seq === 1).timestamp).getTime() - TYPED_EVENTS[0].ts) < 5000)
  check('kind/type/title mapping', rows.find((r) => r.seq === 1)?.kind === 'app' && rows.find((r) => r.seq === 1)?.type === 'App' && rows.find((r) => r.seq === 1)?.title === 'Code.exe' && rows.find((r) => r.seq === 4)?.kind === 'app' && rows.find((r) => r.seq === 5)?.kind === 'session')
  check('Device.highWaterMark → 5', getDevice(deviceId)?.highWaterMark === 5, `(got ${getDevice(deviceId)?.highWaterMark})`)

  // ── 2. Duplicate seq (resend same batch, new nonce) ──────────────────────
  console.log('\n2) Duplicate seq')
  const b2 = await signedRequest({
    token,
    deviceId,
    path: ACT_PATH,
    body: { batchId: 'b_valid_1', events: [...TYPED_EVENTS, ...FLAT_EVENTS] },
    nonce: NONCE(),
  })
  check('HTTP 202', b2.status === 202, `(got ${b2.status})`)
  check('accepted=0, duplicates=5', b2.json.accepted === 0 && b2.json.duplicates === 5, JSON.stringify({ a: b2.json.accepted, d: b2.json.duplicates }))
  check('row count unchanged (5)', countEvents(deviceId) === 5, `(got ${countEvents(deviceId)})`)
  check('HWM still 5 (not regressed)', getDevice(deviceId)?.highWaterMark === 5)

  // ── 3. Replay batch (same nonce → 409 AGENT_REPLAY) ──────────────────────
  console.log('\n3) Replay batch (nonce reuse)')
  const nonce3 = NONCE()
  const b3a = await signedRequest({ token, deviceId, path: ACT_PATH, body: { batchId: 'b_replay', events: [{ seq: 20, timestamp: Date.now(), kind: 'app', title: 'A' }] }, nonce: nonce3 })
  const b3b = await signedRequest({ token, deviceId, path: ACT_PATH, body: { batchId: 'b_replay', events: [{ seq: 20, timestamp: Date.now(), kind: 'app', title: 'A' }] }, nonce: nonce3 })
  check('first use → 202', b3a.status === 202, `(got ${b3a.status})`)
  check('replayed nonce → 409 AGENT_REPLAY', b3b.status === 409 && b3b.json.error?.code === 'AGENT_REPLAY', `(got ${b3b.status} ${b3b.json.error?.code})`)
  check('replay inserted nothing', countEvents(deviceId) === 6, `(got ${countEvents(deviceId)})`)
  check('HWM → 20 after replay scenario', getDevice(deviceId)?.highWaterMark === 20, `(got ${getDevice(deviceId)?.highWaterMark})`)

  // ── 4. Out-of-order seq (new seqs above HWM, sent out of order) ──────────
  console.log('\n4) Out-of-order seq')
  const b4 = await signedRequest({
    token,
    deviceId,
    path: ACT_PATH,
    body: { batchId: 'b_o3', events: [
      { seq: 22, timestamp: Date.now(), kind: 'app', title: 'O3-high' },
      { seq: 21, timestamp: Date.now() - 2000, kind: 'app', title: 'O3-low' },
      { seq: 23, timestamp: Date.now() - 1000, kind: 'app', title: 'O3-mid' },
    ] },
    nonce: NONCE(),
  })
  check('HTTP 202, accepted=3', b4.status === 202 && b4.json.accepted === 3, `(got ${b4.status} a=${b4.json.accepted})`)
  const seqsNow = eventSeqs(deviceId).map((r) => r.seq).sort((a, b) => a - b)
  check('seqs 21,22,23 all persisted (out-of-order ok)', seqsNow.includes(21) && seqsNow.includes(22) && seqsNow.includes(23), JSON.stringify(seqsNow))
  check('HWM advances to 23', getDevice(deviceId)?.highWaterMark === 23, `(got ${getDevice(deviceId)?.highWaterMark})`)
  const b4dup = await signedRequest({ token, deviceId, path: ACT_PATH, body: { batchId: 'b_o3', events: [{ seq: 21, timestamp: Date.now(), kind: 'app', title: 'O3-low' }] }, nonce: NONCE() })
  check('resending seq 21 (≤HWM) → duplicate, not error', b4dup.json.accepted === 0 && b4dup.json.duplicates === 1, JSON.stringify({ a: b4dup.json.accepted, d: b4dup.json.duplicates }))

  // ── 5. Malformed event (partial success: rejected[] only) ────────────────
  console.log('\n5) Malformed event')
  const b5 = await signedRequest({
    token,
    deviceId,
    path: ACT_PATH,
    body: { batchId: 'b_mixed', events: [
      { seq: 24, timestamp: Date.now(), kind: 'app', title: 'Good' },
      { seq: 25, timestamp: Date.now(), kind: 'app' }, // missing title/app payload → flat fails (no title/application), typed fails (no app obj)
      { seq: 26, timestamp: Date.now() - 3 * 86400000, kind: 'app', title: 'Old' }, // ts 3 days ago → AGENT_CLOCK_SKEW
    ] },
    nonce: NONCE(),
  })
  check('HTTP 202 (partial success)', b5.status === 202, `(got ${b5.status})`)
  check('accepted=1 (seq 24 only)', b5.json.accepted === 1, `(got ${b5.json.accepted})`)
  const rej25 = (b5.json.rejected ?? []).find((r) => r.seq === 25)
  const rej26 = (b5.json.rejected ?? []).find((r) => r.seq === 26)
  check('seq 25 rejected AGENT_VALIDATION', rej25?.code === 'AGENT_VALIDATION', JSON.stringify(rej25))
  check('seq 26 rejected AGENT_CLOCK_SKEW', rej26?.code === 'AGENT_CLOCK_SKEW', JSON.stringify(rej26))
  check('rejected events not persisted', eventSeqs(deviceId).some((r) => r.seq === 24) && !eventSeqs(deviceId).some((r) => r.seq === 25) && !eventSeqs(deviceId).some((r) => r.seq === 26))
  check('HWM → 24 (only accepted seq)', getDevice(deviceId)?.highWaterMark === 24, `(got ${getDevice(deviceId)?.highWaterMark})`)

  // ── 6. Oversized batch (>500 events) & empty array → 422 ─────────────────
  console.log('\n6) Oversized / empty batch')
  const bigEvents = Array.from({ length: 501 }, (_, i) => ({ seq: 100 + i, timestamp: Date.now(), kind: 'app', title: `E${i}` }))
  const b6 = await signedRequest({ token, deviceId, path: ACT_PATH, body: { batchId: 'b_big', events: bigEvents }, nonce: NONCE() })
  check('501 events → 422 AGENT_VALIDATION', b6.status === 422 && b6.json.error?.code === 'AGENT_VALIDATION', `(got ${b6.status} ${b6.json.error?.code})`)
  check('nothing persisted from oversized batch', countEvents(deviceId) === 10, `(got ${countEvents(deviceId)})`)
  const b6b = await signedRequest({ token, deviceId, path: ACT_PATH, body: { batchId: 'b_empty', events: [] }, nonce: NONCE() })
  check('empty events[] → 422', b6b.status === 422, `(got ${b6b.status})`)
  const b6c = await signedRequest({ token, deviceId, path: ACT_PATH, body: { batchId: 'b_nobatch' }, nonce: NONCE() })
  check('missing batchId → 422', b6c.status === 422, `(got ${b6c.status})`)

  // ── 7. Transaction rollback (HWM never advances on failed write) ─────────
  console.log('\n7) Transaction rollback')
  // API level: all events rejected → no write, HWM unchanged.
  const hwmBefore = getDevice(deviceId)?.highWaterMark
  const b7 = await signedRequest({ token, deviceId, path: ACT_PATH, body: { batchId: 'b_allrej', events: [{ seq: 30, timestamp: Date.now() - 3 * 86400000, kind: 'app', title: 'X' }] }, nonce: NONCE() })
  check('all-rejected batch → 202 accepted=0', b7.status === 202 && b7.json.accepted === 0, `(got ${b7.status} a=${b7.json.accepted})`)
  check('HWM unchanged (no persistence, no advance)', getDevice(deviceId)?.highWaterMark === hwmBefore, `(got ${getDevice(deviceId)?.highWaterMark} vs ${hwmBefore})`)

  // Unit level: real transaction — a mid-tx write failure rolls back the WHOLE
  // transaction: the valid first row AND the Device.highWaterMark update.
  const { persistActivityEvents } = await import('../src/lib/agent')
  const hwmUnit = getDevice(deviceId)?.highWaterMark
  let threw = false
  try {
    // Force a genuine mid-transaction failure: the second row has an invalid
    // timestamp (NaN) → Prisma validation error AFTER the first row would have
    // been inserted — the $transaction must roll both back.
    await persistActivityEvents(deviceId, [
      { seq: 60, kind: 'app', ts: Date.now(), title: 'WillRollback' },
      { seq: 61, kind: 'app', ts: Number.NaN, title: 'ForcesFailure' },
    ])
  } catch {
    threw = true
  }
  check('persistActivityEvents throws on mid-tx failure', threw)
  check('first row rolled back too (no orphan rows)', eventSeqs(deviceId).filter((r) => r.title === 'WillRollback').length === 0)
  check('HWM unchanged after rollback', getDevice(deviceId)?.highWaterMark === hwmUnit, `(got ${getDevice(deviceId)?.highWaterMark} vs ${hwmUnit})`)

  // ── 8. gzip body + payload-too-large ─────────────────────────────────────
  console.log('\n8) gzip body & payload limits')
  const b8 = await signedRequest({ token, deviceId, path: ACT_PATH, body: { batchId: 'b_gzip', events: [{ seq: 40, timestamp: Date.now(), kind: 'app', title: 'Gzip' }] }, nonce: NONCE(), gzip: true })
  check('gzip body → 202, accepted=1', b8.status === 202 && b8.json.accepted === 1, `(got ${b8.status} a=${b8.json.accepted})`)
  const hugePayload = { seq: 41, timestamp: Date.now(), kind: 'app', title: 'Big', payload: { blob: 'x'.repeat(1_200_000) } }
  const b8b = await signedRequest({ token, deviceId, path: ACT_PATH, body: { batchId: 'b_bigbody', events: [hugePayload] }, nonce: NONCE() })
  check('>1 MB body → 413 AGENT_PAYLOAD_TOO_LARGE', b8b.status === 413 && b8b.json.error?.code === 'AGENT_PAYLOAD_TOO_LARGE', `(got ${b8b.status} ${b8b.json.error?.code})`)

  // ── 9. Final DB integrity ────────────────────────────────────────────────
  console.log('\n9) Final DB integrity')
  const total = countEvents(deviceId)
  const hwmFinal = getDevice(deviceId)?.highWaterMark
  // seqs persisted: 1-5 (5) + 20 (1) + 21-23 (3) + 24 (1) + 40 (1) = 11
  check('rows persisted = 11 (5+1+3+1+1)', total === 11, `(got ${total})`)
  check('HWM = 40 (max persisted seq)', hwmFinal === 40, `(got ${hwmFinal})`)
  // duplicate protection is enforced by UNIQUE(deviceId, seq) — reinserting any
  // persisted seq counts as duplicate and never raises an error (proven in #2/#4)
} finally {
  // ── Cleanup (keep demo data intact) ──────────────────────────────────────
  console.log('\n--- Cleanup ---')
  if (deviceId) {
    db.query('DELETE FROM ActivityEvent WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM DeviceAssignment WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM AgentCredential WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM Device WHERE id = ?').run(deviceId)
  }
  if (testUserId) db.query('DELETE FROM User WHERE id = ?').run(testUserId)
  const devices = db.query('SELECT count(*) c FROM Device').get().c
  const events = db.query('SELECT count(*) c FROM ActivityEvent').get().c
  const creds = db.query('SELECT count(*) c FROM AgentCredential').get().c
  console.log(`  Removed test device. Devices: ${devices} | activity: ${events} | credentials: ${creds}`)
  db.close()
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`)
if (failed > 0) {
  console.log('Failed:', failures.join(', '))
  process.exit(1)
}
process.exit(0)
