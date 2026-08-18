/**
 * E2 — Device Activation — Automated Verification (live server)
 *
 * Registers a real device via E1, then exercises the authenticated activation
 * endpoint end-to-end against a running dev server — including the M005 Stage-5
 * assignment gate (heartbeat/activity require an active DeviceAssignment).
 *
 * Run:  bun scripts/verify-e2.mjs
 * Env:  BASE_URL (default http://localhost:3108) · DB_PATH (default db/custom.db)
 *
 * Covers the mission's checklist:
 *   first activation · repeat activation (idempotent) · revoked assignment ·
 *   reassignment · duplicate activation · unauthorized · expired token ·
 *   disabled installation · suspended device · pending device · revoked device ·
 *   assignment lookup · partial unique index · transaction rollback ·
 *   response DTO · gate integration (E3/E5 require assignment) · build
 */

import { createHash, randomBytes } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { signAgentRequest } from '../src/lib/agent-auth/signature'

const BASE = process.env.BASE_URL || 'http://localhost:3108'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const INSTALLATION_ID = 'inst_demo_default'
const JOIN_KEY = 'WL-DEMO-JOINKEY-2026'
const E1_IP = '203.0.113.70'

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
const getCred = (deviceId) =>
  db.query('SELECT * FROM AgentCredential WHERE deviceId = ? ORDER BY issuedAt DESC LIMIT 1').get(deviceId)
const activeAssignments = (deviceId) =>
  db.query('SELECT * FROM DeviceAssignment WHERE deviceId = ? AND revokedAt IS NULL').all(deviceId)
const allAssignments = (deviceId) =>
  db.query('SELECT * FROM DeviceAssignment WHERE deviceId = ? ORDER BY assignedAt').all(deviceId)
const setInstallStatus = (status) =>
  db.query('UPDATE Installation SET status = ? WHERE id = ?').run(status, INSTALLATION_ID)
const setDeviceStatus = (deviceId, status) =>
  db.query('UPDATE Device SET status = ? WHERE id = ?').run(status, deviceId)
const setCredRevoked = (deviceId, revokedAt) =>
  db.query('UPDATE AgentCredential SET revokedAt = ? WHERE deviceId = ?').run(revokedAt, deviceId)

// ── test users (created/cleaned via SQL — admin-assignment simulation) ──
function createTestUser(email, name) {
  const id = `usr_e2_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  db.query('INSERT INTO User (id, name, email, status, updatedAt) VALUES (?, ?, ?, ?, ?)').run(id, name, email, 'Active', new Date().toISOString())
  return id
}
function setUserDevice(userId, deviceId) {
  db.query('UPDATE User SET deviceId = ? WHERE id = ?').run(deviceId, userId)
}
function deleteUser(userId) {
  db.query('DELETE FROM User WHERE id = ?').run(userId)
}

// ── signed request helper (contract §2.1/§2.2) ──
async function signedRequest({ token, deviceId, path, body, nonce, ts = Date.now(), headers = {} }) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
  const signature = signAgentRequest({ key: token, method: 'POST', path, timestamp: ts, nonce, body: bodyStr })
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
      ...headers,
    },
    body: bodyStr,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, headers: res.headers }
}

const ACT_PATH = '/api/agent/v1/activate'
const HB_PATH = '/api/agent/v1/heartbeat'
const AC_PATH = '/api/agent/v1/activity'

async function activate(token, deviceId) {
  return signedRequest({ token, deviceId, path: ACT_PATH, body: { clientTime: Date.now() }, nonce: NONCE() })
}
async function heartbeat(token, deviceId) {
  return signedRequest({ token, deviceId, path: HB_PATH, body: { clientTime: Date.now(), status: 'online' }, nonce: NONCE() })
}
async function activity(token, deviceId) {
  return signedRequest({
    token,
    deviceId,
    path: AC_PATH,
    body: { batchId: `b_${Date.now()}`, events: [{ seq: 1, timestamp: Date.now(), kind: 'app', title: 'E2-Test' }] },
    nonce: NONCE(),
  })
}

// ── register a device via E1 ──
async function registerDevice(hostnameSuffix) {
  const serial = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await fetch(`${BASE}/api/agent/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': E1_IP },
    body: JSON.stringify({
      installationId: INSTALLATION_ID,
      joinKey: JOIN_KEY,
      clientTime: Date.now(),
      hostname: `VERIFY-E2-${hostnameSuffix}-${serial}`,
      os: { family: 'Windows', version: '11', build: '22631', arch: 'x64' },
      hardware: { cpu: 'Intel i7-13700K', ramGB: 32, diskGB: 512, mac: 'AA:BB:CC:DD:EE:FF', serial: `SN-E2-${serial}` },
      agentVersion: '0.1.0',
      capabilities: ['activity', 'health'],
    }),
  })
  const json = await reg.json().catch(() => ({}))
  return { status: reg.status, deviceId: json.deviceId, token: json.agentToken }
}

console.log('\n=== E2 — Device Activation — Automated Verification ===\n')
console.log(`Base: ${BASE} | Install: ${INSTALLATION_ID}\n`)

// Test devices/tokens tracked for cleanup
const createdUsers = []
const createdDevices = []

try {
  // ── 1. FIRST ACTIVATION ─────────────────────────────────────────────────
  console.log('1) First activation (register → assign → activate)')
  const r1 = await registerDevice('A')
  check('E1 register → 201', r1.status === 201, `(got ${r1.status})`)
  createdDevices.push(r1.deviceId)
  check('device starts Pending', getDevice(r1.deviceId)?.status === 'Pending', `(got ${getDevice(r1.deviceId)?.status})`)

  // Admin assigns an employee (sets User.deviceId — the current-assignment cursor)
  const u1 = createTestUser(`e2-first-${Date.now()}@test.local`, 'First User')
  createdUsers.push(u1)
  setUserDevice(u1, r1.deviceId)

  const a1 = await activate(r1.token, r1.deviceId)
  check('E2 activate → 200', a1.status === 200, `(got ${a1.status}) ${JSON.stringify(a1.json.error ?? '')}`)
  check('DTO: activated=true + status=active', a1.json.activated === true && a1.json.status === 'active')
  check('DTO: assignmentId + userId + deviceId present', !!a1.json.assignmentId && a1.json.userId === u1 && a1.json.deviceId === r1.deviceId)
  check('DTO: userName/orgId/serverTime/policyVersion/telemetryPolicyVersion/configVersion', a1.json.userName === 'First User' && typeof a1.json.serverTime === 'number' && a1.json.policyVersion === 1 && a1.json.telemetryPolicyVersion === 1 && a1.json.configVersion === 1)
  const act1 = activeAssignments(r1.deviceId)
  check('exactly 1 active assignment created', act1.length === 1 && act1[0].userId === u1 && act1[0].assignedBy === 'system' && act1[0].revokedAt === null, JSON.stringify(act1))
  check('device status → Online', getDevice(r1.deviceId)?.status === 'Online', `(got ${getDevice(r1.deviceId)?.status})`)
  check('device lastHeartbeatAt/lastSeen refreshed', !!getDevice(r1.deviceId)?.lastHeartbeatAt)

  // ── 2. REPEAT ACTIVATION (idempotent) ──────────────────────────────────
  console.log('\n2) Repeat activation (idempotent)')
  const a2 = await activate(r1.token, r1.deviceId)
  check('repeat activate → 200', a2.status === 200, `(got ${a2.status})`)
  check('same assignmentId returned', a2.json.assignmentId === a1.json.assignmentId, `(got ${a2.json.assignmentId} vs ${a1.json.assignmentId})`)
  check('still exactly 1 active assignment', activeAssignments(r1.deviceId).length === 1)
  const a2b = await activate(r1.token, r1.deviceId)
  check('second repeat → 200, no duplicates', a2b.status === 200 && activeAssignments(r1.deviceId).length === 1)

  // ── 3. GATE INTEGRATION (heartbeat/activity require assignment) ─────────
  console.log('\n3) Gate integration — E3/E5 require active DeviceAssignment')
  const hb3 = await heartbeat(r1.token, r1.deviceId)
  check('heartbeat with assignment → 200', hb3.status === 200, `(got ${hb3.status} ${hb3.json.error?.code ?? ''})`)
  const ac3 = await activity(r1.token, r1.deviceId)
  check('activity with assignment → 202', ac3.status === 202, `(got ${ac3.status} ${ac3.json.error?.code ?? ''})`)

  // ── 4. REVOKED ASSIGNMENT → E3/E5 gated off, E2 re-activates ────────────
  console.log('\n4) Revoked assignment')
  db.query('UPDATE DeviceAssignment SET revokedAt = ?, revokeReason = ? WHERE deviceId = ? AND revokedAt IS NULL').run(
    new Date().toISOString(),
    'admin-revoke-test',
    r1.deviceId
  )
  check('0 active assignments after admin revoke', activeAssignments(r1.deviceId).length === 0)
  const hb4 = await heartbeat(r1.token, r1.deviceId)
  check('heartbeat without assignment (Online) → 403 AGENT_DEVICE_UNASSIGNED', hb4.status === 403 && hb4.json.error?.code === 'AGENT_DEVICE_UNASSIGNED', `(got ${hb4.status} ${hb4.json.error?.code})`)
  const ac4 = await activity(r1.token, r1.deviceId)
  check('activity without assignment → 403 AGENT_DEVICE_UNASSIGNED', ac4.status === 403 && ac4.json.error?.code === 'AGENT_DEVICE_UNASSIGNED', `(got ${ac4.status} ${ac4.json.error?.code})`)
  const a4 = await activate(r1.token, r1.deviceId)
  check('E2 re-activates after revoke → 200', a4.status === 200, `(got ${a4.status})`)
  check('new assignment created (different id)', a4.json.assignmentId !== a1.json.assignmentId, `(got ${a4.json.assignmentId} vs ${a1.json.assignmentId})`)
  const hb4b = await heartbeat(r1.token, r1.deviceId)
  check('heartbeat works again after re-activation', hb4b.status === 200)

  // ── 5. REASSIGNMENT (admin moves User.deviceId to another employee) ─────
  console.log('\n5) Reassignment')
  const u2 = createTestUser(`e2-reassign-${Date.now()}@test.local`, 'Second User')
  createdUsers.push(u2)
  setUserDevice(u1, null)
  setUserDevice(u2, r1.deviceId)
  const a5 = await activate(r1.token, r1.deviceId)
  check('E2 reassign → 200', a5.status === 200, `(got ${a5.status})`)
  check('assignment now to user2', a5.json.userId === u2)
  const act5 = activeAssignments(r1.deviceId)
  check('exactly 1 active assignment (to user2)', act5.length === 1 && act5[0].userId === u2, JSON.stringify(act5))
  const all5 = allAssignments(r1.deviceId)
  const revoked = all5.filter((a) => a.revokedAt !== null)
  check('old assignment window revoked with reason', revoked.length === 2 && revoked.every((a) => a.revokeReason === 'reassigned' || a.revokeReason === 'admin-revoke-test'), JSON.stringify(revoked))

  // ── 6. DUPLICATE ACTIVATION (never more than one active) ────────────────
  console.log('\n6) Duplicate activation')
  for (let i = 0; i < 3; i++) {
    const a6 = await activate(r1.token, r1.deviceId)
    check(`activation #${i + 2} → 200`, a6.status === 200)
  }
  check('still exactly 1 active assignment', activeAssignments(r1.deviceId).length === 1)

  // ── 7. PARTIAL UNIQUE INDEX (ADR-029, raw SQL) ──────────────────────────
  console.log('\n7) Partial unique index (ADR-029)')
  let indexViolation = false
  try {
    db.query('INSERT INTO DeviceAssignment (id, deviceId, userId, assignedAt, assignedBy, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
      `da_dup_${Date.now()}`,
      r1.deviceId,
      u2,
      new Date().toISOString(),
      'raw-test',
      new Date().toISOString()
    )
  } catch (e) {
    indexViolation = String(e).includes('UNIQUE')
  }
  check('second active assignment → UNIQUE constraint violation', indexViolation)
  check('still exactly 1 active assignment', activeAssignments(r1.deviceId).length === 1)

  // ── 8. UNAUTHORIZED (bad token) ─────────────────────────────────────────
  console.log('\n8) Unauthorized / malformed auth')
  const a8 = await signedRequest({ token: 'x'.repeat(43), deviceId: r1.deviceId, path: ACT_PATH, body: '{}', nonce: NONCE() })
  check('bad token → 401', a8.status === 401, `(got ${a8.status})`)
  const a8b = await fetch(`${BASE}${ACT_PATH}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
  check('missing headers → 401', a8b.status === 401, `(got ${a8b.status})`)

  // ── 9. EXPIRED TOKEN ────────────────────────────────────────────────────
  console.log('\n9) Expired token')
  setCredRevoked(r1.deviceId, new Date().toISOString())
  const a9 = await activate(r1.token, r1.deviceId)
  check('revoked credential → 401 AGENT_TOKEN_EXPIRED', a9.status === 401 && a9.json.error?.code === 'AGENT_TOKEN_EXPIRED', `(got ${a9.status} ${a9.json.error?.code})`)
  setCredRevoked(r1.deviceId, null)

  // ── 10. DISABLED INSTALLATION ───────────────────────────────────────────
  console.log('\n10) Disabled installation')
  setInstallStatus('Disabled')
  const a10 = await activate(r1.token, r1.deviceId)
  check('disabled installation → 403 AGENT_INSTALLATION_DISABLED', a10.status === 403 && a10.json.error?.code === 'AGENT_INSTALLATION_DISABLED', `(got ${a10.status} ${a10.json.error?.code})`)
  setInstallStatus('Active')

  // ── 11. SUSPENDED DEVICE ────────────────────────────────────────────────
  console.log('\n11) Suspended device')
  setDeviceStatus(r1.deviceId, 'Suspended')
  const a11 = await activate(r1.token, r1.deviceId)
  check('suspended device → 403 AGENT_DEVICE_REVOKED', a11.status === 403 && a11.json.error?.code === 'AGENT_DEVICE_REVOKED', `(got ${a11.status} ${a11.json.error?.code})`)
  setDeviceStatus(r1.deviceId, 'Online')

  // ── 12. REVOKED (RETIRED) DEVICE ────────────────────────────────────────
  console.log('\n12) Revoked (retired) device')
  setDeviceStatus(r1.deviceId, 'Retired')
  const a12 = await activate(r1.token, r1.deviceId)
  check('retired device → 403 AGENT_DEVICE_REVOKED', a12.status === 403 && a12.json.error?.code === 'AGENT_DEVICE_REVOKED', `(got ${a12.status} ${a12.json.error?.code})`)
  setDeviceStatus(r1.deviceId, 'Online')

  // ── 13. PENDING DEVICE WITHOUT ADMIN ASSIGNMENT ─────────────────────────
  console.log('\n13) Pending device, no admin assignment yet')
  const r13 = await registerDevice('B')
  createdDevices.push(r13.deviceId)
  check('E1 register → 201', r13.status === 201)
  // no user assigned → E2 cannot resolve a user
  const a13 = await activate(r13.token, r13.deviceId)
  check('E2 without assigned user → 403 AGENT_DEVICE_PENDING', a13.status === 403 && a13.json.error?.code === 'AGENT_DEVICE_PENDING', `(got ${a13.status} ${a13.json.error?.code}) ${JSON.stringify(a13.json.error ?? '')}`)
  check('no assignment created', activeAssignments(r13.deviceId).length === 0)
  // While still Pending, activity is blocked by the Pending lifecycle state
  const ac13pre = await activity(r13.token, r13.deviceId)
  check('Pending device activity → 403 AGENT_DEVICE_PENDING (no data while pending)', ac13pre.status === 403 && ac13pre.json.error?.code === 'AGENT_DEVICE_PENDING', `(got ${ac13pre.status} ${ac13pre.json.error?.code})`)
  // Pending device heartbeat stays allowed (poll channel, contract §2.6) — but E3
  // flips the device to Online, so the assignment gate (not status) now authorizes
  // data ingestion: an Online-but-unassigned device is blocked by AGENT_DEVICE_UNASSIGNED.
  const hb13 = await heartbeat(r13.token, r13.deviceId)
  check('Pending device heartbeat → 200 (poll channel)', hb13.status === 200, `(got ${hb13.status} ${hb13.json.error?.code ?? ''})`)
  check('device now Online after heartbeat', getDevice(r13.deviceId)?.status === 'Online', `(got ${getDevice(r13.deviceId)?.status})`)
  const ac13 = await activity(r13.token, r13.deviceId)
  check('Online-but-unassigned activity → 403 AGENT_DEVICE_UNASSIGNED (assignment is authorization)', ac13.status === 403 && ac13.json.error?.code === 'AGENT_DEVICE_UNASSIGNED', `(got ${ac13.status} ${ac13.json.error?.code})`)
  // Now assign + activate → works
  const u13 = createTestUser(`e2-pending-${Date.now()}@test.local`, 'Pending User')
  createdUsers.push(u13)
  setUserDevice(u13, r13.deviceId)
  const a13b = await activate(r13.token, r13.deviceId)
  check('after assignment, E2 → 200', a13b.status === 200, `(got ${a13b.status})`)

  // ── 14. ASSIGNMENT LOOKUP (verifier returns assignment in ctx) ──────────
  console.log('\n14) Assignment lookup')
  const ac14 = await activity(r13.token, r13.deviceId)
  check('activity succeeds → assignment gate resolved', ac14.status === 202, `(got ${ac14.status})`)
  check('active assignment exists for device', activeAssignments(r13.deviceId).length === 1)

  // ── 15. TRANSACTION ROLLBACK (mid-tx failure → no partial state) ────────
  console.log('\n15) Transaction rollback')
  const before15 = allAssignments(r13.deviceId).length
  const { db: prismaDb } = await import('../src/lib/db')
  let rolledBack = false
  try {
    await prismaDb.$transaction(async (tx) => {
      await tx.deviceAssignment.create({
        data: { deviceId: r13.deviceId, userId: u13, assignedAt: new Date(), assignedBy: 'rollback-test' },
      })
      throw new Error('force mid-tx failure')
    })
  } catch {
    rolledBack = true
  }
  check('transaction throws on mid-tx failure', rolledBack)
  check('inserted assignment rolled back (count unchanged)', allAssignments(r13.deviceId).length === before15, `(got ${allAssignments(r13.deviceId).length} vs ${before15})`)
  check('active assignment count unchanged', activeAssignments(r13.deviceId).length === 1)

  // ── 16. RESPONSE DTO SHAPE (full field audit) ───────────────────────────
  console.log('\n16) Response DTO shape')
  const dtoKeys = Object.keys(a1.json).sort()
  const expectedKeys = ['activated', 'assignmentId', 'configVersion', 'deviceId', 'organizationId', 'policyVersion', 'serverTime', 'status', 'telemetryPolicyVersion', 'userId', 'userName'].sort()
  check('DTO contains all contract+mission fields', JSON.stringify(dtoKeys) === JSON.stringify(expectedKeys), JSON.stringify(dtoKeys))
  check('organizationId present (server-resolved)', 'organizationId' in a1.json)

  // ── 17. INSTALLATION STATE NOT IMPACTED BY ACTIVATION ───────────────────
  console.log('\n17) Final integrity')
  const installs = db.query('SELECT status FROM Installation WHERE id = ?').get(INSTALLATION_ID)
  check('installation still Active', installs?.status === 'Active')
} finally {
  // ── Cleanup (keep demo data intact) ─────────────────────────────────────
  console.log('\n--- Cleanup ---')
  for (const deviceId of createdDevices) {
    db.query('DELETE FROM DeviceAssignment WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM ActivityEvent WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM AgentCredential WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM Device WHERE id = ?').run(deviceId)
  }
  for (const userId of createdUsers) {
    db.query('UPDATE User SET deviceId = NULL WHERE id = ?').run(userId)
    deleteUser(userId)
  }
  setInstallStatus('Active')
  const devices = db.query('SELECT count(*) c FROM Device').get().c
  const creds = db.query('SELECT count(*) c FROM AgentCredential').get().c
  const users = db.query('SELECT count(*) c FROM User').get().c
  const assigns = db.query('SELECT count(*) c FROM DeviceAssignment').get().c
  console.log(`  Cleanup done. Devices: ${devices} | users: ${users} | credentials: ${creds} | assignments: ${assigns}`)
  db.close()
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`)
if (failed > 0) {
  console.log('Failed:', failures.join(', '))
  process.exit(1)
}
process.exit(0)
