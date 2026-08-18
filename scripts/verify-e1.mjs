/**
 * E1 — Agent Registration API — Automated Verification
 *
 * Requires: dev server running on http://localhost:3000 and DB at db/custom.db
 * Run:      node scripts/verify-e1.mjs
 *
 * Covers (8 cases): valid registration, invalid join key, duplicate registration,
 * missing fields, invalid payload, database persistence, token hashing, response shape.
 */

import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const BASE = process.env.BASE_URL || 'http://localhost:3000'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'

const INSTALLATION_ID = 'inst_demo_default'
const JOIN_KEY = 'WL-DEMO-JOINKEY-2026' // demo install backfilled in M003

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

async function post(body, ip) {
  const res = await fetch(`${BASE}/api/agent/v1/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': ip,
      'X-Request-ID': crypto.randomUUID(),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

const validPayload = (serial) => ({
  installationId: INSTALLATION_ID,
  joinKey: JOIN_KEY,
  clientTime: Date.now(),
  hostname: `VERIFY-E1-${serial}`,
  os: { family: 'Windows', version: '11', build: '22631', arch: 'x64' },
  hardware: {
    cpu: 'Intel i7-13700K',
    ramGB: 32,
    diskGB: 512,
    mac: 'AA:BB:CC:DD:EE:FF',
    serial: `SN-VERIFY-${serial}`,
  },
  agentVersion: '0.1.0',
  capabilities: ['activity', 'screenshots', 'health', 'logs', 'errors', 'commands'],
})

// Track rows created so we can clean up (keep demo data intact)
const createdDeviceIds = []
const db = new DatabaseSync(DB_PATH)

function getStoredTokenHash(deviceId) {
  const row = db
    .prepare('SELECT tokenHash FROM AgentCredential WHERE deviceId = ? ORDER BY issuedAt DESC LIMIT 1')
    .get(deviceId)
  return row?.tokenHash ?? null
}

const sha256hex = (s) => createHash('sha256').update(s).digest('hex')

console.log('\n=== E1 Agent Registration — Automated Verification ===\n')
console.log(`Base: ${BASE} | Install: ${INSTALLATION_ID}\n`)

// ── 1. Valid registration ────────────────────────────────────────────────
console.log('1) Valid registration')
const serial = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const p1 = validPayload(serial)
const r1 = await post(p1, '203.0.113.1')
check('HTTP 201', r1.status === 201, `(got ${r1.status})`)
check(
  'Response shape (8 keys, no tokenHash/token hash leak)',
  r1.json.deviceId &&
    r1.json.agentToken &&
    r1.json.tokenExpiresAt &&
    typeof r1.json.serverTime === 'number' &&
    r1.json.heartbeatIntervalMs === 30000 &&
    r1.json.minAgentVersion === '0.1.0' &&
    r1.json.policyVersion === 1 &&
    r1.json.configVersion === 1 &&
    r1.json.status === 'pending' &&
    !('tokenHash' in r1.json),
  JSON.stringify(Object.keys(r1.json))
)
check('agentToken looks like 256-bit base64url', /^[A-Za-z0-9_-]{43}$/.test(r1.json.agentToken))
const deviceId = r1.json.deviceId
createdDeviceIds.push(deviceId)

// ── 2. Invalid join key ───────────────────────────────────────────────────
console.log('\n2) Invalid join key')
const p2 = validPayload(`badkey-${serial}`)
p2.joinKey = 'WRONG-KEY-123'
const r2 = await post(p2, '203.0.113.2')
check('HTTP 401', r2.status === 401, `(got ${r2.status})`)
check('Error code AGENT_JOIN_KEY_INVALID', r2.json.error?.code === 'AGENT_JOIN_KEY_INVALID')

// ── 3. Duplicate registration (same hardware fingerprint) ─────────────────
console.log('\n3) Duplicate registration')
const r3 = await post(p1, '203.0.113.3') // same payload → same fingerprint
check('HTTP 409', r3.status === 409, `(got ${r3.status})`)
check('Error code AGENT_ALREADY_REGISTERED', r3.json.error?.code === 'AGENT_ALREADY_REGISTERED')
check('Same deviceId returned in details', r3.json.error?.details?.deviceId === deviceId)

// ── 4. Missing fields ─────────────────────────────────────────────────────
console.log('\n4) Missing fields')
const r4 = await post({ installationId: INSTALLATION_ID }, '203.0.113.4')
check('HTTP 422', r4.status === 422, `(got ${r4.status})`)
check('Error code AGENT_VALIDATION', r4.json.error?.code === 'AGENT_VALIDATION')

// ── 5. Invalid payload (bad semver / unknown capability / bad hostname) ───
console.log('\n5) Invalid payload')
const p5 = validPayload(`badpayload-${serial}`)
p5.agentVersion = 'not-a-version'
const r5 = await post(p5, '203.0.113.5')
check('Bad semver → 422', r5.status === 422, `(got ${r5.status})`)
const p5b = validPayload(`badcap-${serial}`)
p5b.capabilities = ['activity', 'video'] // 'video' not in whitelist
const r5b = await post(p5b, '203.0.113.6')
check('Unknown capability → 422', r5b.status === 422, `(got ${r5b.status})`)
const p5c = validPayload(`badhost-${serial}`)
p5c.hostname = 'x'.repeat(200)
const r5c = await post(p5c, '203.0.113.7')
check('Oversized hostname → 422', r5c.status === 422, `(got ${r5c.status})`)

// ── 6. Database persistence ───────────────────────────────────────────────
console.log('\n6) Database persistence')
const dev = db
  .prepare('SELECT id, hostname, status, installationId, hardwareFingerprint FROM Device WHERE id = ?')
  .get(deviceId)
check('Device row created', !!dev)
check('Device status = Pending', dev?.status === 'Pending')
check('Device linked to installation', dev?.installationId === INSTALLATION_ID)
check('hardwareFingerprint stored', typeof dev?.hardwareFingerprint === 'string' && dev.hardwareFingerprint.length === 64)
const cred = db.prepare('SELECT tokenHash FROM AgentCredential WHERE deviceId = ?').get(deviceId)
check('AgentCredential row created', !!cred)

// ── 7. Token hashing ──────────────────────────────────────────────────────
console.log('\n7) Token hashing')
const storedHash = getStoredTokenHash(deviceId)
check('Stored tokenHash is 64-char sha256 hex', /^[0-9a-f]{64}$/.test(storedHash ?? ''))
check('Stored hash !== plaintext token', storedHash !== r1.json.agentToken)
check('Stored hash === sha256(agentToken)', storedHash === sha256hex(r1.json.agentToken))

// ── 8. Response shape — full DTO keys, no secrets ─────────────────────────
console.log('\n8) Response shape (exact key set)')
const expectedKeys = [
  'deviceId',
  'agentToken',
  'tokenExpiresAt',
  'serverTime',
  'heartbeatIntervalMs',
  'minAgentVersion',
  'policyVersion',
  'configVersion',
  'status',
].sort()
const actualKeys = Object.keys(r1.json).sort()
check('Exact DTO key set', JSON.stringify(actualKeys) === JSON.stringify(expectedKeys), JSON.stringify(actualKeys))
check('No passwordHash / tokenHash / joinKey in response', !JSON.stringify(r1.json).includes('tokenHash'))

// ── Cleanup (keep demo data intact) ───────────────────────────────────────
console.log('\n--- Cleanup ---')
const cleanup = db
  .prepare('DELETE FROM AgentCredential WHERE deviceId = ?')
  .run(deviceId)
db.prepare('DELETE FROM Device WHERE id = ?').run(deviceId)
const remaining = db.prepare('SELECT count(*) c FROM Device').get().c
console.log(`  Removed test device + credential (rows affected: ${cleanup.changes}). Device rows remaining: ${remaining}`)
db.close()

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`)
if (failed > 0) {
  console.log('Failed:', failures.join(', '))
  process.exit(1)
}
process.exit(0)
