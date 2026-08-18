/**
 * E6 — Screenshot Upload Foundation — Automated Verification (live server)
 *
 * Registers a real device (E1), activates it (E2, assignment), heartbeats it
 * (E3), then exercises the full screenshot pipeline against a running dev
 * server: initiate → chunks → complete, dedup, single-shot, and every
 * rejection the mission lists (duplicate chunk, invalid order, hash mismatch,
 * expired ticket, wrong MIME, oversized) + rollback/transaction integrity,
 * temp cleanup, rate limiting, and the assignment gate.
 *
 * Run:   bun scripts/verify-e6.mjs
 * Env:   BASE_URL (default http://localhost:3107) · DB_PATH (default db/custom.db)
 *
 * Start the target server first, e.g.:  npx next dev -p 3107
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { signAgentRequest } from '../src/lib/agent-auth/signature'
import { checkAgentRateLimit, AGENT_RATE_LIMIT_RULES } from '../src/lib/agent-rate-limit/limiter'
import { InMemoryRateLimitStore } from '../src/lib/agent-rate-limit/store'

const BASE = process.env.BASE_URL || 'http://localhost:3107'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const STORAGE_ROOT = path.resolve(process.env.STORAGE_PATH || 'storage/screenshots')
const INSTALLATION_ID = 'inst_demo_default'
const JOIN_KEY = 'WL-DEMO-JOINKEY-2026'
const E1_IP = '203.0.113.61'

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
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

// ━━ Minimal WebP fixtures (RIFF/WEBP magic — the server sniffs, not decodes) ━━
function webpFixture(size) {
  const buf = Buffer.alloc(size)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(size - 8, 4)
  buf.write('WEBP', 8)
  buf.write('VP8 ', 12)
  buf.writeUInt32LE(size - 20, 16)
  buf.fill(0xab, 20)
  return buf
}
const IMG_A = webpFixture(300) // single chunk
const IMG_B = webpFixture(600) // distinct content → distinct hash
const IMG_C = webpFixture(900) // never uploaded — fresh hash for mismatch tests
const IMG_D = webpFixture(262144 + 8192) // 2 chunks (256 KB + 8 KB)
const IMG_E = webpFixture(262144 + 16384) // 2 chunks, distinct hash (out-of-order scenario)
const NOT_WEBP = Buffer.from('PNG not really an image ................')

const db = new Database(DB_PATH)
const getDevice = (id) => db.query('SELECT * FROM Device WHERE id = ?').get(id)
const getTicket = (id) => db.query('SELECT * FROM UploadTicket WHERE id = ?').get(id)
const countTickets = (deviceId) => db.query('SELECT count(*) c FROM UploadTicket WHERE deviceId = ?').get(deviceId)?.c ?? 0
const countScreenshots = (deviceId) => db.query('SELECT count(*) c FROM Screenshot WHERE deviceId = ?').get(deviceId)?.c ?? 0
const storedFiles = (deviceId) =>
  db.query('SELECT storagePath FROM Screenshot WHERE deviceId = ? AND storagePath IS NOT NULL').all(deviceId)
const dedupRows = (deviceId) =>
  db.query('SELECT id, dedupRef FROM Screenshot WHERE deviceId = ? AND dedupRef IS NOT NULL').all(deviceId)

// ── Signed request helper — any method, string or Buffer body ──────────────
// The server refills the screenshots bucket at 8 tokens/s (125 ms) — steady
// tests space requests ≥150 ms so they never trip 429; the section-11 burst
// explicitly passes noSleep to exhaust the bucket on purpose.
async function signedRequest({ token, deviceId, method = 'POST', path: p, body, nonce, ts = Date.now(), headers = {}, noSleep = false }) {
  const wireBody = Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body)
  const signature = signAgentRequest({ key: token, method, path: p, timestamp: ts, nonce, body: wireBody })
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-installation-id': INSTALLATION_ID,
      'x-device-id': deviceId,
      'x-agent-version': '0.1.0',
      'x-timestamp': String(ts),
      'x-nonce': nonce,
      'x-agent-signature': signature,
      'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
      ...headers,
    },
    body: wireBody,
  })
  if (!noSleep) await new Promise((r) => setTimeout(r, 150))
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, headers: res.headers }
}

const SCREENSHOTS = '/api/agent/v1/screenshots'
const chunkPath = (ticket, index) => `/api/agent/v1/screenshots/${ticket}/chunk?index=${index}`
const completePath = (ticket) => `/api/agent/v1/screenshots/${ticket}/complete`

async function registerDevice(hostname) {
  const serial = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await fetch(`${BASE}/api/agent/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': E1_IP },
    body: JSON.stringify({
      installationId: INSTALLATION_ID,
      joinKey: JOIN_KEY,
      clientTime: Date.now(),
      hostname: `${hostname}-${serial}`,
      os: { family: 'Windows', version: '11', build: '22631', arch: 'x64' },
      hardware: { cpu: 'Intel i7-13700K', ramGB: 32, diskGB: 512, mac: 'AA:BB:CC:DD:EE:FF', serial: `SN-${serial}` },
      agentVersion: '0.1.0',
      capabilities: ['activity', 'screenshots', 'health'],
    }),
  })
  const json = await reg.json().catch(() => ({}))
  return { status: reg.status, deviceId: json.deviceId, token: json.agentToken }
}

const testUsers = []

async function assignAndActivate(token, deviceId, tag) {
  const id = `usr_e6_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  testUsers.push(id)
  db.query('INSERT INTO User (id, name, email, status, updatedAt) VALUES (?, ?, ?, ?, ?)').run(
    id,
    `E6 ${tag} User`,
    `${tag}-${Date.now()}@test.local`,
    'Active',
    new Date().toISOString()
  )
  db.query('UPDATE User SET deviceId = ? WHERE id = ?').run(deviceId, id)
  const body = JSON.stringify({ clientTime: Date.now() })
  const nonce = NONCE()
  const ts = Date.now()
  const signature = signAgentRequest({ key: token, method: 'POST', path: '/api/agent/v1/activate', timestamp: ts, nonce, body })
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

const initiateMeta = (img, over = {}) => ({
  ts: Date.now(),
  sha256: sha256(img),
  size: img.length,
  format: 'webp',
  width: 1920,
  height: 1080,
  multiMonitor: false,
  monitorId: 0,
  privacyMode: false,
  blurSensitive: true,
  ...over,
})

function qMeta(img, over = {}) {
  const m = initiateMeta(img, over)
  return ['ts', 'sha256', 'size', 'format', 'width', 'height', 'multiMonitor', 'monitorId', 'privacyMode', 'blurSensitive']
    .map((k) => `&${k}=${encodeURIComponent(m[k])}`)
    .join('')
}

console.log('\n=== E6 — Screenshot Upload Foundation — Automated Verification ===\n')
console.log(`Base: ${BASE} | Storage: ${STORAGE_ROOT}\n`)

let deviceId = null
let token = null
let deviceB = null

try {
  // ── Setup ────────────────────────────────────────────────────────────────
  console.log('0) Setup — register → activate (assignment) → heartbeat')
  const d1 = await registerDevice('VERIFY-E6-A')
  check('E1 register → 201', d1.status === 201, `(got ${d1.status})`)
  deviceId = d1.deviceId
  token = d1.token
  check('got deviceId + token', !!deviceId && !!token)
  const act = await assignAndActivate(token, deviceId, 'A')
  check('E2 activate → 200 (assignment created)', act === 200, `(got ${act})`)
  check('active DeviceAssignment exists', db.query('SELECT count(*) c FROM DeviceAssignment WHERE deviceId = ? AND revokedAt IS NULL').get(deviceId)?.c === 1)
  const hb = await signedRequest({ token, deviceId, path: '/api/agent/v1/heartbeat', body: JSON.stringify({ clientTime: Date.now(), status: 'online' }), nonce: NONCE() })
  check('E3 heartbeat → 200 (device Online)', hb.status === 200, `(got ${hb.status})`)
  check('Device status → Online', getDevice(deviceId)?.status === 'Online')

  // ── 1. Initiate ──────────────────────────────────────────────────────────
  console.log('\n1) Initiate')
  const i1 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_A), nonce: NONCE() })
  check('initiate (valid) → 201', i1.status === 201, `(got ${i1.status}) ${JSON.stringify(i1.json.error ?? '')}`)
  check('duplicate=false, uploadId present', i1.json.duplicate === false && !!i1.json.uploadId, JSON.stringify(i1.json))
  check('chunkSize = 262144 (256 KB mission rule)', i1.json.chunkSize === 262144, `(got ${i1.json.chunkSize})`)
  check('chunks = ceil(size/chunkSize) = 1', i1.json.chunks === 1, `(got ${i1.json.chunks})`)
  check('expiresAt present (+10 min TTL)', !!i1.json.expiresAt)
  const t1 = i1.json.uploadId
  const t1row = getTicket(t1)
  check('UploadTicket row: status=open', t1row?.status === 'open', `(got ${t1row?.status})`)
  check('UploadTicket row: deviceId bound', t1row?.deviceId === deviceId)
  check('UploadTicket row: sha256 matches', t1row?.sha256 === sha256(IMG_A))
  check('UploadTicket row: size matches', t1row?.size === IMG_A.length)
  check('UploadTicket row: totalChunks=1, received=0', t1row?.totalChunks === 1 && t1row?.receivedBytes === 0)
  check('UploadTicket row: chunkSize=262144', t1row?.chunkSize === 262144)

  const i2 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_A, { size: 0 }), nonce: NONCE() })
  check('initiate size=0 → 422', i2.status === 422, `(got ${i2.status})`)
  const i3 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_A, { sha256: 'not-a-hash' }), nonce: NONCE() })
  check('initiate bad sha256 → 422', i3.status === 422, `(got ${i3.status})`)
  const i4 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_A, { format: 'png' }), nonce: NONCE() })
  check('initiate png format → 422 (mission WebP-only)', i4.status === 422, `(got ${i4.status})`)
  const i5 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_A, { size: 6 * 1024 * 1024 }), nonce: NONCE() })
  check('initiate 6 MB > 5 MB limit → 413', i5.status === 413 && i5.json.error?.code === 'AGENT_PAYLOAD_TOO_LARGE', `(got ${i5.status} ${i5.json.error?.code})`)
  const i6 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_A, { ts: Date.now() - 3 * 86400000 }), nonce: NONCE() })
  check('initiate ts outside ±24 h → 422', i6.status === 422, `(got ${i6.status})`)
  const i7 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: 'not json{', nonce: NONCE() })
  check('initiate malformed JSON → 422', i7.status === 422, `(got ${i7.status})`)
  const i8 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_B), nonce: NONCE(), headers: { 'x-agent-signature': 'AAAA' } })
  check('initiate bad signature → 401', i8.status === 401, `(got ${i8.status})`)
  const i9 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_A, { ts: 'nope' }), nonce: NONCE() })
  check('initiate non-integer ts → 422', i9.status === 422, `(got ${i9.status})`)

  // ── 2. Chunk upload — valid path ─────────────────────────────────────────
  console.log('\n2) Chunk upload (valid)')
  const c1 = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t1, 0), body: IMG_A, nonce: NONCE() })
  check('chunk 0 → 200 {received,nextIndex}', c1.status === 200 && c1.json.received === true, `(got ${c1.status}) ${JSON.stringify(c1.json)}`)
  check('nextIndex = 1 (all received)', c1.json.nextIndex === 1, `(got ${c1.json.nextIndex})`)
  const t1row2 = getTicket(t1)
  check('receivedBitmap = [0]', JSON.stringify(JSON.parse(t1row2.receivedBitmap ?? '[]')) === '[0]', `(got ${t1row2.receivedBitmap})`)
  check('receivedBytes = 300', t1row2.receivedBytes === IMG_A.length, `(got ${t1row2.receivedBytes})`)
  const tmpChunk = path.join(STORAGE_ROOT, '.tmp', t1, '0.bin')
  check('chunk file on disk in ticket temp dir', existsSync(tmpChunk), tmpChunk)
  check('chunk file bytes match', readFileSync(tmpChunk).equals(IMG_A))

  // ── 3. Chunk rejections (mission list) ───────────────────────────────────
  console.log('\n3) Chunk rejections')
  const c2 = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t1, 0), body: IMG_A, nonce: NONCE() })
  check('duplicate chunk index 0 → 409 AGENT_UPLOAD_CONFLICT', c2.status === 409 && c2.json.error?.code === 'AGENT_UPLOAD_CONFLICT', `(got ${c2.status} ${c2.json.error?.code})`)
  const c3 = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t1, 5), body: IMG_A, nonce: NONCE() })
  check('out-of-range index (5 ≥ 1 chunk) → 409', c3.status === 409, `(got ${c3.status})`)
  const c4 = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t1, -1), body: IMG_A, nonce: NONCE() })
  check('negative index → 422', c4.status === 422, `(got ${c4.status})`)
  const c5 = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t1, 'abc'), body: IMG_A, nonce: NONCE() })
  check('non-integer index → 422', c5.status === 422, `(got ${c5.status})`)
  const c6 = await signedRequest({ token, deviceId, method: 'PUT', path: `/api/agent/v1/screenshots/${t1}/chunk`, body: IMG_A, nonce: NONCE() })
  check('missing index param → 422', c6.status === 422, `(got ${c6.status})`)
  const c7 = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t1, 1), body: webpFixture(300 * 1024), nonce: NONCE() })
  check('oversized chunk (300 KB > 256 KB) → 413', c7.status === 413 && c7.json.error?.code === 'AGENT_PAYLOAD_TOO_LARGE', `(got ${c7.status}) ${c7.json.error?.code}`)
  const c8 = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath('up_nonexistent', 0), body: IMG_A, nonce: NONCE() })
  check('unknown ticket → 404 AGENT_UPLOAD_NOT_FOUND', c8.status === 404 && c8.json.error?.code === 'AGENT_UPLOAD_NOT_FOUND', `(got ${c8.status}) ${c8.json.error?.code}`)

  // ── 4. Complete — valid path ─────────────────────────────────────────────
  console.log('\n4) Complete (valid)')
  const p1 = await signedRequest({ token, deviceId, path: completePath(t1), body: Buffer.alloc(0), nonce: NONCE() })
  check('complete → 201 {screenshotId, duplicate:false, stored:true}', p1.status === 201 && !!p1.json.screenshotId && p1.json.duplicate === false && p1.json.stored === true, `(got ${p1.status}) ${JSON.stringify(p1.json)}`)
  const sid1 = p1.json.screenshotId
  const s1row = db.query('SELECT * FROM Screenshot WHERE id = ?').get(sid1)
  check('Screenshot row: sha256 matches content', s1row?.sha256 === sha256(IMG_A), `(got ${s1row?.sha256})`)
  check('Screenshot row: size=300, format=WebP', s1row?.size === IMG_A.length && s1row?.format === 'WebP')
  check('Screenshot row: width/height captured', s1row?.width === 1920 && s1row?.height === 1080)
  check('Screenshot row: monitorId=0, privacyMode=false', s1row?.monitorId === 0 && s1row?.privacyMode === 0)
  check('Screenshot row: uploadId → ticket (provenance)', s1row?.uploadId === t1)
  check('Screenshot row: storagePath matches {yyyy}/{mm}/{dd}/{id}.webp', /^\d{4}\/\d{2}\/\d{2}\/[a-z0-9]+\.webp$/.test(s1row?.storagePath ?? ''), `(got ${s1row?.storagePath})`)
  const finalFile = path.join(STORAGE_ROOT, s1row.storagePath)
  check('final file exists on disk', existsSync(finalFile), finalFile)
  check('final file bytes identical to uploaded image', readFileSync(finalFile).equals(IMG_A))
  check('Screenshot row: userId = assigned employee (ADR-024)', !!s1row?.userId)
  const t1row3 = getTicket(t1)
  check('ticket status → completed', t1row3?.status === 'completed', `(got ${t1row3?.status})`)
  check('ticket temp dir removed after complete', !existsSync(path.join(STORAGE_ROOT, '.tmp', t1)))
  const p1b = await signedRequest({ token, deviceId, path: completePath(t1), body: Buffer.alloc(0), nonce: NONCE() })
  check('complete on completed ticket → 409 (not open)', p1b.status === 409, `(got ${p1b.status})`)
  const c9 = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t1, 0), body: IMG_A, nonce: NONCE() })
  check('chunk on completed ticket → 409 (not open)', c9.status === 409, `(got ${c9.status})`)

  // ── 5. Dedup (ADR-014 — bytes never duplicated) ──────────────────────────
  console.log('\n5) Dedup')
  const d1i = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_A), nonce: NONCE() })
  check('initiate same sha256 → 201 duplicate=true + existingId', d1i.status === 201 && d1i.json.duplicate === true && d1i.json.existingId === sid1, `(got ${d1i.status}) ${JSON.stringify(d1i.json)}`)
  check('no UploadTicket created for dedup hit (still 1)', countTickets(deviceId) === 1, `(got ${countTickets(deviceId)})`)
  const d1r = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_B), nonce: NONCE() })
  const t2 = d1r.json.uploadId
  check('initiate IMG_B → fresh ticket', d1r.status === 201 && d1r.json.duplicate === false && !!t2)
  const d1c = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t2, 0), body: IMG_B, nonce: NONCE() })
  check('chunk B → 200', d1c.status === 200, `(got ${d1c.status})`)
  const d3 = await signedRequest({ token, deviceId, path: `${SCREENSHOTS}?mode=single${qMeta(IMG_A)}`, body: IMG_A, nonce: NONCE() })
  check('single-shot duplicate → 201 duplicate=true, stored=false', d3.status === 201 && d3.json.duplicate === true && d3.json.stored === false, `(got ${d3.status}) ${JSON.stringify(d3.json)}`)
  const d3row = db.query('SELECT * FROM Screenshot WHERE id = ?').get(d3.json.screenshotId)
  check('dedup row: dedupRef → original twin', d3row?.dedupRef === sid1, `(got ${d3row?.dedupRef})`)
  check('dedup row: storagePath null (bytes not duplicated)', d3row?.storagePath === null)
  check('still exactly 1 stored file for IMG_A content', storedFiles(deviceId).length === 1, `(got ${storedFiles(deviceId).length})`)

  // ── 6. Single-shot fast path ─────────────────────────────────────────────
  console.log('\n6) Single-shot')
  const s1 = await signedRequest({ token, deviceId, path: `${SCREENSHOTS}?mode=single${qMeta(IMG_B)}`, body: IMG_B, nonce: NONCE() })
  check('single-shot new content → 201 {stored:true}', s1.status === 201 && s1.json.stored === true && s1.json.duplicate === false, `(got ${s1.status}) ${JSON.stringify(s1.json)}`)
  const ss1row = db.query('SELECT * FROM Screenshot WHERE id = ?').get(s1.json.screenshotId)
  check('single-shot row persisted + file exists', !!ss1row?.storagePath && existsSync(path.join(STORAGE_ROOT, ss1row.storagePath)))
  const s2 = await signedRequest({ token, deviceId, path: `${SCREENSHOTS}?mode=single${qMeta(IMG_A, { sha256: sha256(IMG_B) })}`, body: IMG_A, nonce: NONCE() })
  check('single-shot wrong sha256 → 422', s2.status === 422 && s2.json.error?.code === 'AGENT_VALIDATION', `(got ${s2.status})`)
  const s3 = await signedRequest({ token, deviceId, path: `${SCREENSHOTS}?mode=single${qMeta(IMG_A, { size: 999 })}`, body: IMG_A, nonce: NONCE() })
  check('single-shot size mismatch → 422', s3.status === 422, `(got ${s3.status})`)
  const s4 = await signedRequest({ token, deviceId, path: `${SCREENSHOTS}?mode=single${qMeta(NOT_WEBP)}`, body: NOT_WEBP, nonce: NONCE() })
  check('single-shot non-WebP bytes → 422 (magic sniff)', s4.status === 422, `(got ${s4.status})`)
  const s5 = await signedRequest({ token, deviceId, path: `${SCREENSHOTS}?mode=single${qMeta(webpFixture(5 * 1024 * 1024 + 1))}`, body: webpFixture(5 * 1024 * 1024 + 1), nonce: NONCE() })
  check('single-shot > 5 MB → 413', s5.status === 413, `(got ${s5.status})`)
  const s6 = await signedRequest({ token, deviceId, path: `${SCREENSHOTS}?mode=single${qMeta(IMG_B, { ts: 'nope' })}`, body: IMG_B, nonce: NONCE() })
  check('single-shot invalid ts → 422', s6.status === 422, `(got ${s6.status})`)
  const s7 = await signedRequest({ token, deviceId, path: `${SCREENSHOTS}?mode=single${qMeta(IMG_A, { privacyMode: 'true' })}`, body: IMG_A, nonce: NONCE() })
  check('single-shot privacyMode → stored=false', s7.status === 201 && s7.json.stored === false, `(got ${s7.status}) ${JSON.stringify(s7.json)}`)
  const s7row = db.query('SELECT * FROM Screenshot WHERE id = ?').get(s7.json.screenshotId)
  check('privacyMode row: storagePath null, privacyMode=1', s7row?.storagePath === null && s7row?.privacyMode === 1)
  check('privacyMode wrote no file (2 stored files total)', storedFiles(deviceId).length === 2, `(got ${storedFiles(deviceId).length})`)

  // ── 7. Hash mismatch & rollback ──────────────────────────────────────────
  console.log('\n7) Hash mismatch / size mismatch / rollback')
  const h1 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_A, { sha256: sha256(IMG_C) }), nonce: NONCE() })
  const t3 = h1.json.uploadId
  check('initiate with WRONG declared hash → ticket created', h1.status === 201 && !!t3, `(got ${h1.status})`)
  const h1c = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t3, 0), body: IMG_A, nonce: NONCE() })
  check('chunk upload ok (bytes = IMG_A)', h1c.status === 200, `(got ${h1c.status})`)
  const h1p = await signedRequest({ token, deviceId, path: completePath(t3), body: Buffer.alloc(0), nonce: NONCE() })
  check('complete with hash mismatch → 422', h1p.status === 422 && h1p.json.error?.code === 'AGENT_VALIDATION', `(got ${h1p.status}) ${h1p.json.error?.code}`)
  check('ticket aborted after mismatch', getTicket(t3)?.status === 'aborted', `(got ${getTicket(t3)?.status})`)
  check('no Screenshot row created for aborted upload', !db.query('SELECT 1 FROM Screenshot WHERE uploadId = ?').get(t3))
  check('temp dir purged after abort', !existsSync(path.join(STORAGE_ROOT, '.tmp', t3)))

  const h2 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_A, { size: 100, sha256: sha256(IMG_C) }), nonce: NONCE() })
  const t4 = h2.json.uploadId
  const h2c = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t4, 0), body: IMG_A, nonce: NONCE() })
  check('size-mismatch: chunk accepted (route gate only)', h2c.status === 200, `(got ${h2c.status})`)
  const h2p = await signedRequest({ token, deviceId, path: completePath(t4), body: Buffer.alloc(0), nonce: NONCE() })
  check('complete with byte-count mismatch → 409', h2p.status === 409, `(got ${h2p.status})`)
  check('ticket aborted + no row', getTicket(t4)?.status === 'aborted' && !db.query('SELECT 1 FROM Screenshot WHERE uploadId = ?').get(t4))

  // ── 8. Incomplete uploads ────────────────────────────────────────────────
  console.log('\n8) Incomplete uploads')
  const n1 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_D), nonce: NONCE() })
  const t5 = n1.json.uploadId
  check('2-chunk image (256 KB + 8 KB) → chunks=2', n1.json.chunks === 2, `(got ${n1.json.chunks})`)
  const p0 = await signedRequest({ token, deviceId, path: completePath(t5), body: Buffer.alloc(0), nonce: NONCE() })
  check('complete with zero chunks → 409', p0.status === 409 && p0.json.error?.code === 'AGENT_UPLOAD_CONFLICT', `(got ${p0.status})`)
  check('ticket aborted', getTicket(t5)?.status === 'aborted')
  const n2 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_D), nonce: NONCE() })
  const t6 = n2.json.uploadId
  const p1c = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t6, 0), body: IMG_D.subarray(0, 262144), nonce: NONCE() })
  check('chunk 0 of 2 → 200 nextIndex=1', p1c.status === 200 && p1c.json.nextIndex === 1, `(got ${p1c.status}) ${JSON.stringify(p1c.json)}`)
  const p2c = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t6, 1), body: IMG_D.subarray(262144), nonce: NONCE() })
  check('chunk 1 of 2 → 200 nextIndex=2', p2c.status === 200 && p2c.json.nextIndex === 2, `(got ${p2c.status}) ${JSON.stringify(p2c.json)}`)
  const n3 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_D), nonce: NONCE() })
  const t7 = n3.json.uploadId
  const p3c = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t7, 0), body: IMG_D.subarray(0, 262144), nonce: NONCE() })
  check('partial (chunk 0 only) → 200', p3c.status === 200, `(got ${p3c.status})`)
  const p3p = await signedRequest({ token, deviceId, path: completePath(t7), body: Buffer.alloc(0), nonce: NONCE() })
  check('complete with missing chunk 1 → 409', p3p.status === 409, `(got ${p3p.status})`)
  check('no row, ticket aborted', !db.query('SELECT 1 FROM Screenshot WHERE uploadId = ?').get(t7) && getTicket(t7)?.status === 'aborted')
  const p2p = await signedRequest({ token, deviceId, path: completePath(t6), body: Buffer.alloc(0), nonce: NONCE() })
  check('complete after all 2 chunks → 201 stored', p2p.status === 201 && p2p.json.stored === true, `(got ${p2p.status})`)
  const p2row = db.query('SELECT * FROM Screenshot WHERE id = ?').get(p2p.json.screenshotId)
  check('2-chunk file bytes reassembled correctly', existsSync(path.join(STORAGE_ROOT, p2row.storagePath)) && readFileSync(path.join(STORAGE_ROOT, p2row.storagePath)).equals(IMG_D))
  const n4 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_E), nonce: NONCE() })
  const t8 = n4.json.uploadId
  const p4c = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t8, 1), body: IMG_E.subarray(262144), nonce: NONCE() })
  check('out-of-order chunk 1 first → 200 nextIndex=0 (resumable)', p4c.status === 200 && p4c.json.nextIndex === 0, `(got ${p4c.status}) ${JSON.stringify(p4c.json)}`)
  const p5c = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t8, 0), body: IMG_E.subarray(0, 262144), nonce: NONCE() })
  check('hole-fill chunk 0 → 200 nextIndex=2', p5c.status === 200 && p5c.json.nextIndex === 2, `(got ${p5c.status})`)
  const p5p = await signedRequest({ token, deviceId, path: completePath(t8), body: Buffer.alloc(0), nonce: NONCE() })
  check('complete after out-of-order upload → 201 stored', p5p.status === 201 && p5p.json.stored === true, `(got ${p5p.status})`)
  const p5row = db.query('SELECT * FROM Screenshot WHERE id = ?').get(p5p.json.screenshotId)
  check('out-of-order image bytes correct', readFileSync(path.join(STORAGE_ROOT, p5row.storagePath)).equals(IMG_E))

  // ── 9. Expired ticket ────────────────────────────────────────────────────
  console.log('\n9) Expired ticket')
  const e1 = await signedRequest({ token, deviceId, path: SCREENSHOTS, body: initiateMeta(IMG_C), nonce: NONCE() })
  const t9 = e1.json.uploadId
  db.query('UPDATE UploadTicket SET expiresAt = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), t9)
  const e1c = await signedRequest({ token, deviceId, method: 'PUT', path: chunkPath(t9, 0), body: IMG_A, nonce: NONCE() })
  check('chunk on expired ticket → 410 AGENT_UPLOAD_EXPIRED', e1c.status === 410 && e1c.json.error?.code === 'AGENT_UPLOAD_EXPIRED', `(got ${e1c.status}) ${e1c.json.error?.code}`)
  check('ticket status → expired (state machine)', getTicket(t9)?.status === 'expired', `(got ${getTicket(t9)?.status})`)
  const e1p = await signedRequest({ token, deviceId, path: completePath(t9), body: Buffer.alloc(0), nonce: NONCE() })
  check('complete on expired ticket → 410', e1p.status === 410, `(got ${e1p.status})`)

  // ── 10. Foreign ticket / assignment gate ─────────────────────────────────
  console.log('\n10) Foreign ticket / assignment gate')
  const f1 = await registerDevice('VERIFY-E6-B')
  check('device B registered → 201', f1.status === 201, `(got ${f1.status})`)
  deviceB = f1.deviceId
  db.query('UPDATE Device SET status = ? WHERE id = ?').run('Active', f1.deviceId)
  const f1c = await signedRequest({ token: f1.token, deviceId: f1.deviceId, method: 'PUT', path: chunkPath(t6, 0), body: IMG_A, nonce: NONCE() })
  check("device B (unassigned) chunk on A's ticket → 403 AGENT_DEVICE_UNASSIGNED (auth first)", f1c.status === 403 && f1c.json.error?.code === 'AGENT_DEVICE_UNASSIGNED', `(got ${f1c.status}) ${f1c.json.error?.code}`)
  const f2 = await assignAndActivate(f1.token, f1.deviceId, 'B')
  check('device B activated → 200 (now assigned)', f2 === 200, `(got ${f2})`)
  const f2c = await signedRequest({ token: f1.token, deviceId: f1.deviceId, method: 'PUT', path: chunkPath(t6, 0), body: IMG_A, nonce: NONCE() })
  check("assigned device B chunk on A's ticket → 404 (no existence leak)", f2c.status === 404 && f2c.json.error?.code === 'AGENT_UPLOAD_NOT_FOUND', `(got ${f2c.status}) ${f2c.json.error?.code}`)
  const f2i = await signedRequest({ token: f1.token, deviceId: f1.deviceId, path: SCREENSHOTS, body: initiateMeta(webpFixture(700)), nonce: NONCE() })
  check('device B can initiate own upload → 201', f2i.status === 201, `(got ${f2i.status})`)
  const f2t = f2i.json.uploadId
  const f2p = await signedRequest({ token: f1.token, deviceId: f1.deviceId, path: completePath(f2t), body: Buffer.alloc(0), nonce: NONCE() })
  check('device B complete with 0 chunks → 409 (not a leak)', f2p.status === 409, `(got ${f2p.status})`)

  // ── 11. Rate limiting (contract §3 — centralized limiter wired) ──────────
  console.log('\n11) Rate limiting')
  check('screenshots rule registered (capacity 16, refill 125 ms)', AGENT_RATE_LIMIT_RULES.screenshots?.capacity === 16 && AGENT_RATE_LIMIT_RULES.screenshots?.refillMs === 125, JSON.stringify(AGENT_RATE_LIMIT_RULES.screenshots))
  const store = new InMemoryRateLimitStore()
  let consumed = 0
  let unitBlocked = false
  for (let i = 0; i < 17; i++) {
    try {
      checkAgentRateLimit('screenshots', 'unit-e6-bucket', { store })
      consumed++
    } catch (e) {
      if (e.name === 'AgentRateLimitedError') unitBlocked = true
    }
  }
  check('unit: 16 tokens consumed, 17th throws AgentRateLimitedError', consumed === 16 && unitBlocked, `(consumed ${consumed})`)
  let saw429 = false
  let sawRetryAfter = false
  const burstStatuses = []
  // True burst semantics: fire all initiates CONCURRENTLY (a real agent burst
  // is concurrent, not sequential). Sequential awaits let the 125 ms token
  // refill keep pace with slow dev-server round trips (~100 ms+), which can
  // mask rate limiting on loaded machines. Concurrent firing drains the
  // 16-token bucket deterministically regardless of host latency.
  const burst = Array.from({ length: 30 }, (_, i) =>
    signedRequest({
      token,
      deviceId,
      path: SCREENSHOTS,
      body: initiateMeta(webpFixture(200 + i)),
      nonce: NONCE(),
      noSleep: true,
    }).then((r) => {
      burstStatuses.push(r.status)
      if (r.status === 429 && r.json.error?.code === 'AGENT_RATE_LIMITED') {
        saw429 = true
        sawRetryAfter = !!r.headers.get('retry-after')
      }
      return r
    })
  )
  await Promise.all(burst)
  check('integration: burst of initiates eventually → 429 AGENT_RATE_LIMITED', saw429, `(statuses: ${burstStatuses.join(',')})`)
  check('429 carries Retry-After header (contract §3)', sawRetryAfter)

  // ── 12. Final integrity ──────────────────────────────────────────────────
  console.log('\n12) Final integrity')
  const finalshots = countScreenshots(deviceId)
  const files = storedFiles(deviceId)
  check('every stored row has a real file on disk', files.every((f) => existsSync(path.join(STORAGE_ROOT, f.storagePath))))
  check('dedup rows point at real twins', dedupRows(deviceId).every((r) => !!db.query('SELECT 1 FROM Screenshot WHERE id = ?').get(r.dedupRef)))
  const completedTickets = db.query('SELECT count(*) c FROM UploadTicket WHERE deviceId = ? AND status = ?').get(deviceId, 'completed').c
  const completedRows = db.query('SELECT count(*) c FROM Screenshot WHERE deviceId = ? AND uploadId IS NOT NULL').get(deviceId).c
  check('every completed ticket produced exactly one Screenshot row', completedTickets === completedRows, `(tickets ${completedTickets} vs rows ${completedRows})`)
  const aborted = db.query('SELECT count(*) c FROM UploadTicket WHERE deviceId = ? AND status = ?').get(deviceId, 'aborted').c
  check('4 rollback scenarios left aborted tickets', aborted === 4, `(got ${aborted})`)
  const tmpRoot = path.join(STORAGE_ROOT, '.tmp')
  const tmpEntries = existsSync(tmpRoot) ? readdirSync(tmpRoot) : []
  const orphaned = tmpEntries.filter((d) => {
    const t = getTicket(d)
    return !t || t.status !== 'open'
  })
  check('temp dirs exist only for open (resumable) tickets', orphaned.length === 0, `(orphaned: ${orphaned.join(',')})`)
  check('screenshot count = 6 (4 stored + 1 dedup + 1 privacy)', finalshots === 6, `(got ${finalshots})`)
  check('X-Server-Time header on success', !!p2p.headers.get('x-server-time'))
  console.log(`\n  Device A: ${finalshots} screenshots, ${files.length} files on disk, ${countTickets(deviceId)} tickets`)
} finally {
  // ── Cleanup ──────────────────────────────────────────────────────────────
  console.log('\n--- Cleanup ---')
  for (const device of [deviceId, deviceB]) {
    if (!device) continue
    for (const f of storedFiles(device)) {
      rmSync(path.join(STORAGE_ROOT, f.storagePath), { force: true })
    }
    db.query('DELETE FROM Screenshot WHERE deviceId = ?').run(device)
    db.query('DELETE FROM UploadTicket WHERE deviceId = ?').run(device)
    db.query('DELETE FROM ActivityEvent WHERE deviceId = ?').run(device)
    db.query('DELETE FROM DeviceAssignment WHERE deviceId = ?').run(device)
    db.query('DELETE FROM AgentCredential WHERE deviceId = ?').run(device)
    db.query('DELETE FROM Device WHERE id = ?').run(device)
  }
  for (const u of testUsers) db.query('DELETE FROM User WHERE id = ?').run(u)
  rmSync(path.join(STORAGE_ROOT, '.tmp'), { recursive: true, force: true })
  console.log(`  Removed test data. devices=${db.query('SELECT count(*) c FROM Device').get().c} screenshots=${db.query('SELECT count(*) c FROM Screenshot').get().c} tickets=${db.query('SELECT count(*) c FROM UploadTicket').get().c}`)
  db.close()
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`)
if (failed > 0) {
  console.log('Failed:', failures.join(', '))
  process.exit(1)
}
process.exit(0)
