/**
 * E16 — Agent Token Rotation — Automated Verification (live server)
 *
 * Registers a real device via E1, activates it via E2, then exercises the
 * authenticated token-rotation endpoint end-to-end against a running dev server.
 *
 * Run:  bun scripts/verify-e16.mjs
 * Env:  BASE_URL (default http://localhost:3110) · DB_PATH (default db/custom.db)
 *
 * Covers the mission's checklist:
 *   normal rotation · repeated rotation · grace token works · grace expiry ·
 *   expired token · revoked token · disabled installation · suspended device ·
 *   assignment required · replay protection · nonce reuse · response DTO ·
 *   transaction rollback · concurrent rotations · race condition ·
 *   hash-at-rest proof · old-token rotation rejected · pending gate
 */

import { createHash, randomBytes } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { signAgentRequest } from '../src/lib/agent-auth/signature'

const BASE = process.env.BASE_URL || 'http://localhost:3110'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const INSTALLATION_ID = 'inst_demo_default'
const JOIN_KEY = 'WL-DEMO-JOINKEY-2026'
const E1_IP = '203.0.113.80'

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

const db = new Database(DB_PATH)
const getDevice = (id) => db.query('SELECT * FROM Device WHERE id = ?').get(id)
const getCred = (deviceId) =>
  db.query('SELECT * FROM AgentCredential WHERE deviceId = ? ORDER BY issuedAt DESC LIMIT 1').get(deviceId)
const activeAssignments = (deviceId) =>
  db.query('SELECT * FROM DeviceAssignment WHERE deviceId = ? AND revokedAt IS NULL').all(deviceId)
const setInstallStatus = (status) =>
  db.query('UPDATE Installation SET status = ? WHERE id = ?').run(status, INSTALLATION_ID)
const setDeviceStatus = (deviceId, status) =>
  db.query('UPDATE Device SET status = ? WHERE id = ?').run(status, deviceId)
const setCredRevoked = (deviceId, revokedAt) =>
  db.query('UPDATE AgentCredential SET revokedAt = ? WHERE deviceId = ?').run(revokedAt, deviceId)
const setCredExpiry = (deviceId, expiresAt) =>
  db.query('UPDATE AgentCredential SET expiresAt = ? WHERE deviceId = ?').run(expiresAt, deviceId)
const setCredRotatedAt = (deviceId, rotatedAt) =>
  db.query('UPDATE AgentCredential SET rotatedAt = ? WHERE deviceId = ?').run(rotatedAt, deviceId)

function createTestUser(name) {
  const id = `usr_e16_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  db.query('INSERT INTO User (id, name, email, status, updatedAt) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name,
    `e16-${Date.now()}@test.local`,
    'Active',
    new Date().toISOString()
  )
  return id
}

const ROTATE_PATH = '/api/agent/v1/token/rotate'
const HB_PATH = '/api/agent/v1/heartbeat'
const ACT_PATH = '/api/agent/v1/activate'

// Single shared timestamp for signing AND the X-Timestamp header (ms-exact —
// a double Date.now() straddling a boundary flakes the HMAC, see Stage-5).
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

const rotate = (token, deviceId, extra = {}) =>
  signedRequest({ token, deviceId, path: ROTATE_PATH, body: { clientTime: Date.now() }, nonce: NONCE(), ...extra })
const heartbeat = (token, deviceId) =>
  signedRequest({ token, deviceId, path: HB_PATH, body: { clientTime: Date.now(), status: 'online' }, nonce: NONCE() })
const activate = (token, deviceId) =>
  signedRequest({ token, deviceId, path: ACT_PATH, body: { clientTime: Date.now() }, nonce: NONCE() })

async function registerDevice(hostnameSuffix) {
  const serial = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await fetch(`${BASE}/api/agent/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': E1_IP },
    body: JSON.stringify({
      installationId: INSTALLATION_ID,
      joinKey: JOIN_KEY,
      clientTime: Date.now(),
      hostname: `VERIFY-E16-${hostnameSuffix}-${serial}`,
      os: { family: 'Windows', version: '11', build: '22631', arch: 'x64' },
      hardware: { cpu: 'Intel i7-13700K', ramGB: 32, diskGB: 512, mac: 'AA:BB:CC:DD:EE:FF', serial: `SN-E16-${serial}` },
      agentVersion: '0.1.0',
      capabilities: ['activity', 'health'],
    }),
  })
  const json = await reg.json().catch(() => ({}))
  return { status: reg.status, deviceId: json.deviceId, token: json.agentToken }
}

// ── setup: register + assign + activate → returns active device/token ──
async function setupDevice(name, registerSuffix = 'A') {
  const r = await registerDevice(registerSuffix)
  const uid = createTestUser(name)
  db.query('UPDATE User SET deviceId = ? WHERE id = ?').run(r.deviceId, uid)
  const a = await activate(r.token, r.deviceId)
  return { ...r, userId: uid, activateStatus: a.status }
}

console.log('\n=== E16 — Agent Token Rotation — Automated Verification ===\n')
console.log(`Base: ${BASE} | Install: ${INSTALLATION_ID}\n`)

const createdUsers = []
const createdDevices = []

try {
  // ── 1. NORMAL ROTATION ─────────────────────────────────────────────────
  console.log('1) Normal rotation')
  const d1 = await setupDevice('E16 User A')
  check('E1 register → 201 + E2 activate → 200', d1.status === 201 && d1.activateStatus === 200, `(got ${d1.status}/${d1.activateStatus})`)
  createdDevices.push(d1.deviceId)
  createdUsers.push(d1.userId)
  const cred0 = getCred(d1.deviceId)
  check('credential exists after activation', !!cred0 && cred0.tokenHash === sha256hex(d1.token), `(got ${cred0?.tokenHash?.slice(0, 12)})`)
  check('prevTokenHash empty before rotation', cred0?.prevTokenHash === null)

  const r1 = await rotate(d1.token, d1.deviceId)
  check('rotate → 200', r1.status === 200, `(got ${r1.status}) ${JSON.stringify(r1.json.error ?? '')}`)
  check('DTO: token + expiresAt + graceUntil + serverTime', !!r1.json.token && !!r1.json.expiresAt && !!r1.json.graceUntil && typeof r1.json.serverTime === 'number', JSON.stringify(Object.keys(r1.json)))
  check('new token is 256-bit base64url (43 chars)', typeof r1.json.token === 'string' && r1.json.token.length === 43, `(len ${r1.json.token?.length})`)
  check('graceUntil ≈ serverTime + 60 s', Math.abs(new Date(r1.json.graceUntil).getTime() - (r1.json.serverTime + 60_000)) < 5_000, `(graceUntil ${r1.json.graceUntil} serverTime ${r1.json.serverTime})`)
  check('expiresAt ≈ serverTime + 180 d', Math.abs(new Date(r1.json.expiresAt).getTime() - (r1.json.serverTime + 180 * 86_400_000)) < 60_000)

  // ── 2. NEW TOKEN WORKS IMMEDIATELY; OLD TOKEN IN GRACE ─────────────────
  console.log('\n2) Dual-token — new works now, old works during grace')
  const hbNew = await heartbeat(r1.json.token, d1.deviceId)
  check('heartbeat with NEW token → 200 (works immediately)', hbNew.status === 200, `(got ${hbNew.status} ${hbNew.json.error?.code ?? ''})`)
  const hbOld = await heartbeat(d1.token, d1.deviceId)
  check('heartbeat with OLD token → 200 (grace window)', hbOld.status === 200, `(got ${hbOld.status} ${hbOld.json.error?.code ?? ''})`)
  const cred1 = getCred(d1.deviceId)
  check('stored tokenHash = sha256(new)', cred1?.tokenHash === sha256hex(r1.json.token), `(got ${cred1?.tokenHash?.slice(0, 12)} vs ${sha256hex(r1.json.token).slice(0, 12)})`)
  check('prevTokenHash = sha256(old)', cred1?.prevTokenHash === sha256hex(d1.token))
  check('rotatedAt set', !!cred1?.rotatedAt)

  // ── 3. HASH-AT-REST PROOF ──────────────────────────────────────────────
  console.log('\n3) Hash-at-rest proof (no plaintext ever persisted)')
  const row = db.query('SELECT * FROM AgentCredential WHERE deviceId = ?').get(d1.deviceId)
  const plaintextFields = Object.entries(row).filter(
    ([k, v]) => v && String(v).length >= 10 && (String(v).includes(r1.json.token) || String(v).includes(d1.token))
  )
  check('no column contains either plaintext token', plaintextFields.length === 0, JSON.stringify(plaintextFields.map(([k]) => k)))
  check('tokenHash is exactly sha256(new) — hex 64', cred1?.tokenHash === sha256hex(r1.json.token) && /^[0-9a-f]{64}$/.test(cred1?.tokenHash ?? ''))

  // ── 4. REPEATED ROTATION ───────────────────────────────────────────────
  console.log('\n4) Repeated rotation')
  const r4 = await rotate(r1.json.token, d1.deviceId)
  check('rotate again (signed with NEW token) → 200', r4.status === 200, `(got ${r4.status})`)
  check('different token returned', r4.json.token !== r1.json.token)
  const hb4New = await heartbeat(r4.json.token, d1.deviceId)
  check('heartbeat with 2nd new token → 200', hb4New.status === 200)
  const hb4Grace = await heartbeat(r1.json.token, d1.deviceId)
  check('2nd rotation: previous token now rides grace → 200', hb4Grace.status === 200, `(got ${hb4Grace.status} ${hb4Grace.json.error?.code ?? ''})`)
  const hb4Old = await heartbeat(d1.token, d1.deviceId)
  check('original token (2 rotations back) → 401 (dropped from grace)', hb4Old.status === 401, `(got ${hb4Old.status} ${hb4Old.json.error?.code ?? ''})`)
  const cred4 = getCred(d1.deviceId)
  check('tokenHash = sha256(2nd new), prev = sha256(1st new)', cred4?.tokenHash === sha256hex(r4.json.token) && cred4?.prevTokenHash === sha256hex(r1.json.token))

  // ── 5. GRACE EXPIRY (old token dead after 60 s) ────────────────────────
  console.log('\n5) Grace expiry (old token invalid after 60 s)')
  const rotatedAtMs = new Date(cred4.rotatedAt).getTime()
  // Simulate 61 s elapsed: the verifier measures grace from rotatedAt.
  setCredRotatedAt(d1.deviceId, new Date(Date.now() - 61_000).toISOString())
  const hb5Grace = await heartbeat(r1.json.token, d1.deviceId)
  check('old token after grace → 401 AGENT_TOKEN_EXPIRED', hb5Grace.status === 401 && hb5Grace.json.error?.code === 'AGENT_TOKEN_EXPIRED', `(got ${hb5Grace.status} ${hb5Grace.json.error?.code})`)
  const hb5Cur = await heartbeat(r4.json.token, d1.deviceId)
  check('current token still valid while old is dead → 200', hb5Cur.status === 200, `(got ${hb5Cur.status})`)
  setCredRotatedAt(d1.deviceId, new Date(rotatedAtMs).toISOString()) // restore
  const hb5Restore = await heartbeat(r1.json.token, d1.deviceId)
  check('grace restored → 200 (deterministic, no ambiguity)', hb5Restore.status === 200, `(got ${hb5Restore.status})`)

  // ── 6. EXPIRED TOKEN ───────────────────────────────────────────────────
  console.log('\n6) Expired token')
  setCredExpiry(d1.deviceId, new Date(Date.now() - 60_000).toISOString())
  const hb6 = await heartbeat(r4.json.token, d1.deviceId)
  check('expired current token → 401 AGENT_TOKEN_EXPIRED', hb6.status === 401 && hb6.json.error?.code === 'AGENT_TOKEN_EXPIRED', `(got ${hb6.status} ${hb6.json.error?.code})`)
  const r6 = await rotate(r4.json.token, d1.deviceId)
  check('rotate with expired token → 401', r6.status === 401, `(got ${r6.status})`)
  setCredExpiry(d1.deviceId, new Date(Date.now() + 180 * 86_400_000).toISOString())

  // ── 7. REVOKED TOKEN ───────────────────────────────────────────────────
  console.log('\n7) Revoked token')
  setCredRevoked(d1.deviceId, new Date().toISOString())
  const hb7 = await heartbeat(r4.json.token, d1.deviceId)
  check('revoked credential → 401 AGENT_TOKEN_EXPIRED', hb7.status === 401 && hb7.json.error?.code === 'AGENT_TOKEN_EXPIRED', `(got ${hb7.status} ${hb7.json.error?.code})`)
  const r7 = await rotate(r4.json.token, d1.deviceId)
  check('rotate with revoked token → 401', r7.status === 401, `(got ${r7.status})`)
  setCredRevoked(d1.deviceId, null)

  // ── 8. DISABLED INSTALLATION ───────────────────────────────────────────
  console.log('\n8) Disabled installation')
  setInstallStatus('Disabled')
  const r8 = await rotate(r4.json.token, d1.deviceId)
  check('disabled installation → 403 AGENT_INSTALLATION_DISABLED', r8.status === 403 && r8.json.error?.code === 'AGENT_INSTALLATION_DISABLED', `(got ${r8.status} ${r8.json.error?.code})`)
  setInstallStatus('Active')

  // ── 9. SUSPENDED DEVICE ────────────────────────────────────────────────
  console.log('\n9) Suspended device')
  setDeviceStatus(d1.deviceId, 'Suspended')
  const r9 = await rotate(r4.json.token, d1.deviceId)
  check('suspended device → 403 AGENT_DEVICE_REVOKED', r9.status === 403 && r9.json.error?.code === 'AGENT_DEVICE_REVOKED', `(got ${r9.status} ${r9.json.error?.code})`)
  setDeviceStatus(d1.deviceId, 'Online')

  // ── 10. ASSIGNMENT REQUIRED ────────────────────────────────────────────
  console.log('\n10) Assignment required (data-plane gate)')
  db.query('UPDATE DeviceAssignment SET revokedAt = ?, revokeReason = ? WHERE deviceId = ? AND revokedAt IS NULL').run(
    new Date().toISOString(), 'e16-assignment-gate-test', d1.deviceId
  )
  check('0 active assignments', activeAssignments(d1.deviceId).length === 0)
  const r10 = await rotate(r4.json.token, d1.deviceId)
  check('rotate without assignment → 403 AGENT_DEVICE_UNASSIGNED', r10.status === 403 && r10.json.error?.code === 'AGENT_DEVICE_UNASSIGNED', `(got ${r10.status} ${r10.json.error?.code})`)
  const hb10 = await heartbeat(r4.json.token, d1.deviceId)
  check('heartbeat without assignment → 403 AGENT_DEVICE_UNASSIGNED', hb10.status === 403 && hb10.json.error?.code === 'AGENT_DEVICE_UNASSIGNED', `(got ${hb10.status} ${hb10.json.error?.code})`)
  const a10 = await activate(r4.json.token, d1.deviceId)
  check('E2 re-activates → 200 (gate restored)', a10.status === 200, `(got ${a10.status})`)
  const r10b = await rotate(r4.json.token, d1.deviceId)
  check('rotate works again after re-activation', r10b.status === 200, `(got ${r10b.status})`)
  const hb10b = await heartbeat(r10b.json.token, d1.deviceId)
  check('heartbeat with the fresh token → 200', hb10b.status === 200)

  // ── 11. OLD-TOKEN ROTATION REJECTED ────────────────────────────────────
  console.log('\n11) Old-token rotation rejected (must sign with current)')
  const r11 = await rotate(r4.json.token, d1.deviceId) // r4 token now rides grace after r10b
  check('rotate signed with old (grace) token → 401 AGENT_TOKEN_EXPIRED', r11.status === 401 && r11.json.error?.code === 'AGENT_TOKEN_EXPIRED', `(got ${r11.status} ${r11.json.error?.code})`)
  const r11b = await rotate(r10b.json.token, d1.deviceId)
  check('rotate signed with current token → 200', r11b.status === 200, `(got ${r11b.status})`)
  const cur11 = r11b.json.token

  // ── 12. REPLAY / NONCE REUSE ───────────────────────────────────────────
  console.log('\n12) Replay protection & nonce reuse')
  const nonce = NONCE()
  const ts = Date.now()
  const a12 = await signedRequest({ token: cur11, deviceId: d1.deviceId, path: ROTATE_PATH, body: { clientTime: Date.now() }, nonce, ts })
  const b12 = await signedRequest({ token: cur11, deviceId: d1.deviceId, path: ROTATE_PATH, body: { clientTime: Date.now() }, nonce, ts })
  check('first rotate with nonce → 200', a12.status === 200, `(got ${a12.status})`)
  check('replayed nonce on rotate → 409 AGENT_REPLAY', b12.status === 409 && b12.json.error?.code === 'AGENT_REPLAY', `(got ${b12.status} ${b12.json.error?.code})`)
  // same nonce on a different endpoint is still a replay (per-device nonce scope)
  const c12 = await signedRequest({ token: a12.json.token, deviceId: d1.deviceId, path: HB_PATH, body: { clientTime: Date.now(), status: 'online' }, nonce, ts })
  check('same nonce reused on heartbeat → 409 AGENT_REPLAY', c12.status === 409, `(got ${c12.status})`)
  const d12 = await heartbeat(a12.json.token, d1.deviceId)
  check('fresh nonce on new token → 200', d12.status === 200, `(got ${d12.status})`)

  // ── 13. TRANSACTION ROLLBACK (mid-tx failure → no partial state) ───────
  console.log('\n13) Transaction rollback')
  const credBefore13 = { ...getCred(d1.deviceId) }
  const { db: prismaDb } = await import('../src/lib/db')
  let rolledBack = false
  try {
    await prismaDb.$transaction(async (tx) => {
      await tx.agentCredential.update({
        where: { id: credBefore13.id },
        data: { tokenHash: sha256hex('should-roll-back'), prevTokenHash: credBefore13.tokenHash, rotatedAt: new Date() },
      })
      throw new Error('force mid-tx failure')
    })
  } catch {
    rolledBack = true
  }
  check('transaction throws on mid-tx failure', rolledBack)
  const credAfter13 = getCred(d1.deviceId)
  check('tokenHash unchanged after rollback', credAfter13.tokenHash === credBefore13.tokenHash, `(got ${credAfter13?.tokenHash?.slice(0, 12)} vs ${credBefore13.tokenHash.slice(0, 12)})`)
  const hb13 = await heartbeat(a12.json.token, d1.deviceId)
  check('existing token still authenticates after rollback → 200', hb13.status === 200, `(got ${hb13.status})`)

  // ── 14. CONCURRENT ROTATIONS (race) ────────────────────────────────────
  console.log('\n14) Concurrent rotations (race condition)')
  const cur14 = a12.json.token // current before the race
  const [r14a, r14b] = await Promise.all([rotate(cur14, d1.deviceId), rotate(cur14, d1.deviceId)])
  check('both concurrent rotates → 200', r14a.status === 200 && r14b.status === 200, `(got ${r14a.status}/${r14b.status})`)
  check('distinct tokens returned', r14a.json.token !== r14b.json.token)
  const cred14 = getCred(d1.deviceId)
  const hashA = sha256hex(r14a.json.token)
  const hashB = sha256hex(r14b.json.token)
  // Prisma serializes SQLite transactions: the 2nd rotation reads the 1st's
  // committed row, so the final state is tokenHash = last-writer, prevTokenHash
  // = first-writer (which now rides the grace window). BOTH returned tokens are
  // stored — one current, one grace — and the pre-race token is superseded.
  check('stored current hash is one of the two returned tokens', cred14?.tokenHash === hashA || cred14?.tokenHash === hashB, `(stored ${cred14?.tokenHash?.slice(0, 12)})`)
  check('prevTokenHash is the OTHER returned token (grace window)', cred14?.prevTokenHash === (cred14?.tokenHash === hashA ? hashB : hashA), `(got ${cred14?.prevTokenHash?.slice(0, 12)})`)
  check('pre-race token (cur14) is superseded — no longer stored', cred14?.tokenHash !== sha256hex(cur14) && cred14?.prevTokenHash !== sha256hex(cur14))
  const currentTok = cred14?.tokenHash === hashA ? r14a.json.token : r14b.json.token
  const graceTok = currentTok === r14a.json.token ? r14b.json.token : r14a.json.token
  const hb14cur = await heartbeat(currentTok, d1.deviceId)
  check('race-winner token (current) → 200', hb14cur.status === 200, `(got ${hb14cur.status})`)
  const hb14grace = await heartbeat(graceTok, d1.deviceId)
  check('race-loser token (grace window) → 200', hb14grace.status === 200, `(got ${hb14grace.status} ${hb14grace.json.error?.code ?? ''})`)
  const hb14old = await heartbeat(cur14, d1.deviceId)
  check('pre-race token → 401 (no longer matches any stored hash — AGENT_UNAUTHORIZED)', hb14old.status === 401 && hb14old.json.error?.code === 'AGENT_UNAUTHORIZED', `(got ${hb14old.status} ${hb14old.json.error?.code})`)
  // self-heal: rotate with the stored current → fresh working token
  const r14heal = await rotate(currentTok, d1.deviceId)
  check('self-heal rotation with stored current → 200', r14heal.status === 200, `(got ${r14heal.status})`)
  const hb14 = await heartbeat(r14heal.json.token, d1.deviceId)
  check('post-race fresh token works → 200', hb14.status === 200, `(got ${hb14.status})`)

  // ── 15. PENDING DEVICE GATE (no assignment → no rotation) ──────────────
  console.log('\n15) Pending device gate')
  const p15 = await registerDevice('P')
  createdDevices.push(p15.deviceId)
  check('E1 register → 201', p15.status === 201)
  const r15 = await rotate(p15.token, p15.deviceId)
  check('rotate on un-activated (Pending) device → 403 AGENT_DEVICE_PENDING', r15.status === 403 && r15.json.error?.code === 'AGENT_DEVICE_PENDING', `(got ${r15.status} ${r15.json.error?.code})`)
  const u15 = createTestUser('E16 Pending User')
  createdUsers.push(u15)
  db.query('UPDATE User SET deviceId = ? WHERE id = ?').run(p15.deviceId, u15)
  const a15 = await activate(p15.token, p15.deviceId)
  check('after activation, rotate → 200', a15.status === 200, `(got ${a15.status})`)
  const r15b = await rotate(p15.token, p15.deviceId)
  check('activated device rotates fine', r15b.status === 200, `(got ${r15b.status})`)

  // ── 16. RESPONSE DTO SHAPE (full field audit) ──────────────────────────
  console.log('\n16) Response DTO shape')
  const dtoKeys = Object.keys(r1.json).sort()
  const expectedKeys = ['expiresAt', 'graceUntil', 'serverTime', 'token'].sort()
  check('DTO contains exactly token/expiresAt/graceUntil/serverTime', JSON.stringify(dtoKeys) === JSON.stringify(expectedKeys), JSON.stringify(dtoKeys))

  // ── 17. FINAL INTEGRITY ────────────────────────────────────────────────
  console.log('\n17) Final integrity')
  const installs = db.query('SELECT status FROM Installation WHERE id = ?').get(INSTALLATION_ID)
  check('installation still Active', installs?.status === 'Active')
  // Meaningful at-rest proof across every credential created this run: stored
  // tokenHash/prevTokenHash are sha256 hex (64 chars) and NEVER equal a returned
  // plaintext token (43-char base64url — structurally impossible to collide).
  const allRows = db
    .query("SELECT tokenHash, prevTokenHash FROM AgentCredential WHERE deviceId IN (SELECT id FROM Device WHERE hostname LIKE 'VERIFY-E16-%')")
    .all()
  const allPlaintexts = [d1.token, r1.json.token, r4.json.token, r10b.json.token, cur11, a12.json.token, r14a.json.token, r14b.json.token, r14heal.json.token, r15b.json.token, p15.token]
  const shapeOk = allRows.every((row) => /^[0-9a-f]{64}$/.test(row.tokenHash ?? '') && (!row.prevTokenHash || /^[0-9a-f]{64}$/.test(row.prevTokenHash)))
  const noPlain = allRows.every((row) => !allPlaintexts.some((t) => t && (row.tokenHash === t || row.prevTokenHash === t)))
  check('all stored hashes are sha256 hex (64) — hash-at-rest', shapeOk)
  check('no stored column equals any returned plaintext token', noPlain)
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
    db.query('DELETE FROM User WHERE id = ?').run(userId)
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
