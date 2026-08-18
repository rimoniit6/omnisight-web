/**
 * E7 — Device Health Endpoint — Automated Verification (live server)
 *
 * Registers a real device (E1), activates it (E2), then exercises
 * POST /api/agent/v1/health against a running dev server: happy path with
 * full mission payload, changed-values-only Device persistence (never
 * overwrite unchanged, no agentVersion downgrades), DeviceHealthSnapshot
 * persistence (18 §5.17 — server timestamps only), one-transaction
 * atomicity, warnings (AV disabled / pending reboot / low disk / high CPU /
 * low battery), validation rejections (422), oversized body (413), the full
 * auth matrix (401/403 gates incl. suspended / retired / disabled
 * installation / unassigned / pending), replay protection, centralized rate
 * limiting (1/60 s, burst 2), forward-compatible unknown-field tolerance,
 * X-Token-Expires, DB integrity (index, orphans, FK cascade), and regression
 * of E1/E2/E3/E5/E6/E16 on a fresh device.
 *
 * Run:   bun scripts/verify-e7.mjs
 * Env:   BASE_URL (default http://localhost:3107) · DB_PATH (default db/custom.db)
 *
 * Start the target server first, e.g.:  npx next dev -p 3107
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { signAgentRequest } from '../src/lib/agent-auth/signature'

const BASE = process.env.BASE_URL || 'http://localhost:3107'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const STORAGE_ROOT = path.resolve(process.env.STORAGE_PATH || 'storage/screenshots')
const INSTALLATION_ID = 'inst_demo_default'
const JOIN_KEY = 'WL-DEMO-JOINKEY-2026'
// One unique TEST-NET-3 IP per device — the register route enforces 5/min per
// IP (contract §3); a fresh address per simulated agent keeps the suite
// deterministic across back-to-back runs (25 agents, 25 distinct IPs).
const IPS = Array.from({ length: 40 }, (_, i) => `203.0.113.${i + 1}`)

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

// ━━ Minimal WebP fixture (server sniffs magic, does not decode) — E6 regression ━━
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
const IMG_A = webpFixture(300)

const db = new Database(DB_PATH)
db.run('PRAGMA foreign_keys = ON') // match Prisma's per-connection FK enforcement (cascade test, ADR-024)
db.run('PRAGMA busy_timeout = 10000') // wait out worker flush locks (FLEET-WORKER health snapshots) during cleanup
for (const row of db.query('SELECT storagePath FROM Screenshot WHERE sha256 = ?').all(sha256(IMG_A))) {
  // purge fixture-hash orphans left by interrupted runs so the dedup/201 checks are idempotent
  if (row.storagePath) rmSync(path.join(STORAGE_ROOT, row.storagePath), { force: true })
}
db.query('DELETE FROM Screenshot WHERE sha256 = ?').run(sha256(IMG_A))
const getDevice = (id) => db.query('SELECT * FROM Device WHERE id = ?').get(id)
const getSnapshots = (deviceId) =>
  db.query('SELECT * FROM DeviceHealthSnapshot WHERE deviceId = ? ORDER BY ts').all(deviceId)
const countSnapshots = (deviceId) =>
  db.query('SELECT count(*) c FROM DeviceHealthSnapshot WHERE deviceId = ?').get(deviceId)?.c ?? 0
const getInstallation = (id) => db.query('SELECT * FROM Installation WHERE id = ?').get(id)
const getCredential = (deviceId) =>
  db.query('SELECT * FROM AgentCredential WHERE deviceId = ?').get(deviceId)

// ── Signed request helper — any method, string or Buffer body ──────────────
// The health bucket refills at 1 token / 60 s (capacity 2) — tests space
// requests across DEVICES (each device has its own bucket); the section-11
// burst passes noSleep to exhaust the bucket on purpose.
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

const HEALTH = '/api/agent/v1/health'

let ipCursor = 0
async function registerDevice(hostname, ip = IPS[ipCursor % IPS.length]) {
  ipCursor++
  const serial = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await fetch(`${BASE}/api/agent/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
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
  const id = `usr_e7_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  testUsers.push(id)
  db.query('INSERT INTO User (id, name, email, status, updatedAt) VALUES (?, ?, ?, ?, ?)').run(
    id,
    `E7 ${tag} User`,
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

// Mission payload — every documented field (cpu/memory/disk/battery/uptime/
// processes/network/services/temperatures/agentVersion/osVersion/hostname/
// bootTime/antivirus/firewall/pendingReboot + contract aliases ram/av/os/agent).
function fullBody(over = {}) {
  return {
    clientTime: Date.now(),
    cpu: { cores: 16, loadPct: 63 },
    memory: { totalGB: 32, freeGB: 20 },
    disk: { totalGB: 512, freeGB: 120 },
    battery: { percent: 87 },
    uptime: 86400,
    processes: ['code.exe', 'explorer.exe', 'msedge.exe'],
    network: { ssid: 'CorpWiFi', ip: '10.20.30.40' },
    services: ['wl-agent', 'wl-sync'],
    temperatures: [{ name: 'CPU', celsius: 61 }],
    agentVersion: '0.2.0',
    osVersion: '10.0.22631',
    hostname: 'DESKTOP-E7',
    bootTime: Date.now() - 86400000,
    antivirus: { name: 'Defender', enabled: true },
    firewall: { name: 'Windows Firewall', enabled: true },
    agent: { threads: 12, memMB: 512, uptimeS: 90000, lastGcMs: 140 },
    pendingReboot: false,
    ...over,
  }
}

const qMeta = (img) =>
  ['ts', 'sha256', 'size', 'format', 'width', 'height', 'multiMonitor', 'monitorId', 'privacyMode', 'blurSensitive']
    .map((k) => {
      const v = { ts: Date.now(), sha256: sha256(img), size: img.length, format: 'webp', width: 1920, height: 1080, multiMonitor: false, monitorId: 0, privacyMode: false, blurSensitive: true }[k]
      return `&${k}=${encodeURIComponent(v)}`
    })
    .join('')

const devices = []

async function makeDevice(name, tag) {
  const reg = await registerDevice(name)
  if (reg.status !== 200 && reg.status !== 201) {
    console.log(`  !! makeDevice(${name}) register failed: status=${reg.status}`, reg.status === 201 ? '' : JSON.stringify(reg))
    return { ...reg, deviceId: null, token: null }
  }
  const act = await assignAndActivate(reg.token, reg.deviceId, tag)
  devices.push(reg.deviceId)
  return { ...reg, act }
}

async function main() {
  try {
  // ── 1. Happy path — full mission payload → 200 + persistence ──────────────
  console.log('1) Happy path — full payload')
  const d1 = await makeDevice('e7-main', 'main')
  check('setup: register → 201 (new device)', d1.status === 201, `(got ${d1.status})`)
  check('setup: activate → 200', d1.act === 200, `(got ${d1.act})`)

  const h1 = await signedRequest({ token: d1.token, deviceId: d1.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('full payload → 200', h1.status === 200, `(got ${h1.status}) ${JSON.stringify(h1.json)}`)
  check('response has serverTime (ms)', typeof h1.json.serverTime === 'number' && h1.json.serverTime > 0)
  check('response accepted === true', h1.json.accepted === true)
  check('response warnings is array (empty for healthy device)', Array.isArray(h1.json.warnings) && h1.json.warnings.length === 0, JSON.stringify(h1.json.warnings))
  check('response nextHeartbeat = serverTime + 60 s', h1.json.nextHeartbeat - h1.json.serverTime === 60000, `(diff ${h1.json.nextHeartbeat - h1.json.serverTime})`)
  check('X-Server-Time header on success', !!h1.headers.get('x-server-time'))

  const snap1 = getSnapshots(d1.deviceId)
  const dev1 = getDevice(d1.deviceId)
  check('snapshot row created (1)', snap1.length === 1, `(got ${snap1.length})`)
  check('snapshot ts ≈ serverTime (server-authoritative)', Math.abs(new Date(snap1[0].ts).getTime() - h1.json.serverTime) < 3000, `(snapshot ${new Date(snap1[0].ts).getTime()} vs server ${h1.json.serverTime})`)
  check('snapshot cpuPct = 63', snap1[0].cpuPct === 63, `(got ${snap1[0].cpuPct})`)
  check('snapshot ramPct = 38 (12/32 used)', snap1[0].ramPct === 38, `(got ${snap1[0].ramPct})`)
  check('snapshot diskFreeGB = 120', snap1[0].diskFreeGB === 120, `(got ${snap1[0].diskFreeGB})`)
  check('snapshot batteryPct = 87', snap1[0].batteryPct === 87, `(got ${snap1[0].batteryPct})`)
  check('snapshot network JSON has ssid+ip', JSON.parse(snap1[0].network).ssid === 'CorpWiFi' && JSON.parse(snap1[0].network).ip === '10.20.30.40', snap1[0].network)
  check('snapshot osVersion = 10.0.22631', snap1[0].osVersion === '10.0.22631', `(got ${snap1[0].osVersion})`)
  check('snapshot avName = Defender, avEnabled = 1', snap1[0].avName === 'Defender' && snap1[0].avEnabled === 1, `(got ${snap1[0].avName}/${snap1[0].avEnabled})`)
  check('snapshot agentMemMB = 512', snap1[0].agentMemMB === 512, `(got ${snap1[0].agentMemMB})`)
  check('snapshot agentUptimeS = 90000 (agent.uptimeS wins over uptime)', snap1[0].agentUptimeS === 90000, `(got ${snap1[0].agentUptimeS})`)
  check('Device hostname updated (changed-value)', dev1.hostname === 'DESKTOP-E7', `(got ${dev1.hostname})`)
  check('Device osVersion updated', dev1.osVersion === '10.0.22631', `(got ${dev1.osVersion})`)
  check('Device ram = 32 (memory.totalGB)', dev1.ram === 32, `(got ${dev1.ram})`)
  check('Device diskSpace = 512 (disk.totalGB)', dev1.diskSpace === 512, `(got ${dev1.diskSpace})`)
  check('Device ipAddress = 10.20.30.40 (network.ip)', dev1.ipAddress === '10.20.30.40', `(got ${dev1.ipAddress})`)
  check('Device agentVersion bumped 0.1.0 → 0.2.0', dev1.agentVersion === '0.2.0', `(got ${dev1.agentVersion})`)

  // ── 2. Changed-values-only — never overwrite unchanged ────────────────────
  console.log('2) Changed-values-only persistence')
  const updatedAtT1 = dev1.updatedAt
  const h2 = await signedRequest({ token: d1.token, deviceId: d1.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  const dev1b = getDevice(d1.deviceId)
  check('identical re-report → 200', h2.status === 200, `(got ${h2.status})`)
  check('second snapshot created (2 total)', countSnapshots(d1.deviceId) === 2, `(got ${countSnapshots(d1.deviceId)})`)
  check('no UPDATE call when nothing changed (updatedAt identical)', dev1b.updatedAt === updatedAtT1, `(was ${updatedAtT1}, now ${dev1b.updatedAt})`)
  check('no unchanged-field overwrite (hostname/ram/disk intact)', dev1b.hostname === 'DESKTOP-E7' && dev1b.ram === 32 && dev1b.diskSpace === 512)

  // No-downgrade + equal version (fresh device).
  const d2 = await makeDevice('e7-nodowngrade', 'nodowngrade')
  const n1 = await signedRequest({ token: d2.token, deviceId: d2.deviceId, path: HEALTH, body: fullBody({ agentVersion: '0.1.0', hostname: undefined }), nonce: NONCE() })
  const dev2 = getDevice(d2.deviceId)
  check('equal agentVersion → 200, no change', n1.status === 200 && dev2.agentVersion === '0.1.0', `(got ${n1.status} ${dev2.agentVersion})`)
  const n2 = await signedRequest({ token: d2.token, deviceId: d2.deviceId, path: HEALTH, body: fullBody({ agentVersion: '0.0.9', hostname: undefined }), nonce: NONCE() })
  const dev2b = getDevice(d2.deviceId)
  check('lower agentVersion → no downgrade (stays 0.1.0)', n2.status === 200 && dev2b.agentVersion === '0.1.0', `(got ${n2.status} ${dev2b.agentVersion})`)

  // ── 3. Atomicity — no partial writes ──────────────────────────────────────
  console.log('3) Transaction atomicity')
  const d3 = await makeDevice('e7-atomic', 'atomic')
  const before = JSON.stringify(getDevice(d3.deviceId))
  const bad = await signedRequest({ token: d3.token, deviceId: d3.deviceId, path: HEALTH, body: fullBody({ cpu: { cores: 8, loadPct: 'high' } }), nonce: NONCE() })
  check('invalid payload → 422', bad.status === 422 && bad.json.error?.code === 'AGENT_VALIDATION', `(got ${bad.status} ${bad.json.error?.code})`)
  check('no snapshot on rejected request', countSnapshots(d3.deviceId) === 0, `(got ${countSnapshots(d3.deviceId)})`)
  check('Device row byte-identical after rejected request (no partial write)', JSON.stringify(getDevice(d3.deviceId)) === before)
  const good = await signedRequest({ token: d3.token, deviceId: d3.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('valid follow-up → 200, both writes landed together', good.status === 200 && getDevice(d3.deviceId).ram === 32 && countSnapshots(d3.deviceId) === 1, `(got ${good.status})`)

  // ── 4. Warnings — server-computed risk flags ──────────────────────────────
  console.log('4) Warnings')
  const d4 = await makeDevice('e7-warn', 'warn')
  const w1 = await signedRequest({
    token: d4.token, deviceId: d4.deviceId, path: HEALTH,
    body: fullBody({ antivirus: { name: 'Defender', enabled: false }, pendingReboot: true, disk: { totalGB: 256, freeGB: 5 }, cpu: { cores: 4, loadPct: 95 }, battery: { percent: 8 } }),
    nonce: NONCE(),
  })
  const warnCodes = w1.json.warnings || []
  check('AV disabled → warning', warnCodes.some((w) => w.includes('Antivirus disabled')), JSON.stringify(warnCodes))
  check('pendingReboot → warning', warnCodes.some((w) => w.includes('Pending reboot')))
  check('low disk (< 10 GB) → warning', warnCodes.some((w) => w.includes('Low disk')))
  check('high CPU (> 90%) → warning', warnCodes.some((w) => w.includes('High CPU')))
  check('low battery (≤ 10%) → warning', warnCodes.some((w) => w.includes('Low battery')))
  const w2 = await signedRequest({ token: d4.token, deviceId: d4.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('clean report → zero warnings', Array.isArray(w2.json.warnings) && w2.json.warnings.length === 0, JSON.stringify(w2.json.warnings))
  check('warning payload still persisted (batteryPct = 8)', getSnapshots(d4.deviceId)[0].batteryPct === 8)

  // ── 5. Validation rejections → 422 ────────────────────────────────────────
  console.log('5) Validation rejections')
  const d5a = await makeDevice('e7-v1', 'v1')
  const v1 = await signedRequest({ token: d5a.token, deviceId: d5a.deviceId, path: HEALTH, body: 'not json{', nonce: NONCE() })
  check('invalid JSON → 422', v1.status === 422 && v1.json.error?.code === 'AGENT_VALIDATION', `(got ${v1.status})`)
  const v2 = await signedRequest({ token: d5a.token, deviceId: d5a.deviceId, path: HEALTH, body: fullBody({ cpu: { cores: 8, loadPct: 'high' } }), nonce: NONCE() })
  check('cpu.loadPct string → 422', v2.status === 422, `(got ${v2.status})`)

  const d5b = await makeDevice('e7-v2', 'v2')
  const v3 = await signedRequest({ token: d5b.token, deviceId: d5b.deviceId, path: HEALTH, body: fullBody({ cpu: { cores: 8, loadPct: 150 } }), nonce: NONCE() })
  check('cpu.loadPct 150 (out of range) → 422', v3.status === 422, `(got ${v3.status})`)
  const v4 = await signedRequest({ token: d5b.token, deviceId: d5b.deviceId, path: HEALTH, body: fullBody({ battery: { percent: -5 } }), nonce: NONCE() })
  check('battery.percent -5 → 422', v4.status === 422, `(got ${v4.status})`)

  const d5c = await makeDevice('e7-v3', 'v3')
  const v5 = await signedRequest({ token: d5c.token, deviceId: d5c.deviceId, path: HEALTH, body: fullBody({ hostname: '' }), nonce: NONCE() })
  check('empty hostname → 422', v5.status === 422, `(got ${v5.status})`)
  const v6 = await signedRequest({ token: d5c.token, deviceId: d5c.deviceId, path: HEALTH, body: fullBody({ agentVersion: 'not-a-version' }), nonce: NONCE() })
  check('invalid semver agentVersion → 422', v6.status === 422, `(got ${v6.status})`)

  const d5d = await makeDevice('e7-v4', 'v4')
  const v7 = await signedRequest({ token: d5d.token, deviceId: d5d.deviceId, path: HEALTH, body: JSON.stringify('hello'), nonce: NONCE() })
  check('non-object JSON → 422', v7.status === 422, `(got ${v7.status})`)
  const v8 = await signedRequest({ token: d5d.token, deviceId: d5d.deviceId, path: HEALTH, body: JSON.stringify({ clientTime: Date.now() }), nonce: NONCE() })
  check('minimal body (all fields optional) → 200', v8.status === 200 && v8.json.accepted === true, `(got ${v8.status})`)
  check('minimal body still creates a snapshot row', countSnapshots(d5d.deviceId) === 1)

  // ── 6. Oversized body → 413 (size gate precedes auth) ─────────────────────
  console.log('6) Oversized body')
  const big = await fetch(`${BASE}${HEALTH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ junk: 'x'.repeat(140000) }),
  })
  const bigJson = await big.json().catch(() => ({}))
  check('> 128 KB body → 413 even unsigned (gate pre-auth)', big.status === 413 && bigJson.error?.code === 'AGENT_PAYLOAD_TOO_LARGE', `(got ${big.status} ${bigJson.error?.code})`)

  const d5e = await makeDevice('e7-v5', 'v5')
  const ok130 = await signedRequest({ token: d5e.token, deviceId: d5e.deviceId, path: HEALTH, body: JSON.stringify({ ...fullBody(), junk: 'y'.repeat(120000) }), nonce: NONCE() })
  check('≈ 120 KB body (under 128 KB) → 200', ok130.status === 200, `(got ${ok130.status})`)

  // ── 7. Forward compatibility — unknown fields ignored, contract aliases ───
  console.log('7) Forward compatibility + contract aliases')
  const d6 = await makeDevice('e7-alias', 'alias')
  const a1 = await signedRequest({
    token: d6.token, deviceId: d6.deviceId, path: HEALTH,
    body: {
      clientTime: Date.now(),
      os: { version: '11.0.26002', build: '22631', patches: ['KB5034441', 'KB5034442'] },
      ram: { totalGB: 64, freeGB: 40 },
      cpu: { cores: 8, loadPct: 12 },
      av: { name: 'SentinelOne', enabled: false },
      agent: { threads: 8, memMB: 700, uptimeS: 5000 },
      network: { ip: '192.168.1.50' },
    },
    nonce: NONCE(),
  })
  const snap6 = getSnapshots(d6.deviceId)[0]
  check('contract keys (ram/av/os/agent) → 200', a1.status === 200, `(got ${a1.status}) ${JSON.stringify(a1.json)}`)
  check('ram alias → ramPct 38 (24/64 used)', snap6.ramPct === 38, `(got ${snap6.ramPct})`)
  check('os.version → snapshot osVersion', snap6.osVersion === '11.0.26002', `(got ${snap6.osVersion})`)
  check('os.patches → snapshot patches JSON (2)', JSON.parse(snap6.patches).length === 2, snap6.patches)
  check('av alias → avName/avEnabled', snap6.avName === 'SentinelOne' && snap6.avEnabled === 0, `(got ${snap6.avName}/${snap6.avEnabled})`)
  check('agent.memMB/uptimeS persisted', snap6.agentMemMB === 700 && snap6.agentUptimeS === 5000, `(got ${snap6.agentMemMB}/${snap6.agentUptimeS})`)
  check('av disabled → warning surfaced', (a1.json.warnings || []).some((w) => w.includes('Antivirus disabled')))
  check('ram.totalGB → Device.ram 64', getDevice(d6.deviceId).ram === 64, `(got ${getDevice(d6.deviceId).ram})`)
  check('network.ip → Device.ipAddress', getDevice(d6.deviceId).ipAddress === '192.168.1.50')

  const a2 = await signedRequest({
    token: d6.token, deviceId: d6.deviceId, path: HEALTH,
    body: { ...fullBody(), futureField: 'x', futureObj: { a: 1, b: [2, 3] }, futureArray: [1, 2, 3] },
    nonce: NONCE(),
  })
  check('unknown top-level fields ignored → 200', a2.status === 200 && a2.json.accepted === true, `(got ${a2.status}) ${JSON.stringify(a2.json.error ?? '')}`)

  // ── 8. Auth matrix ────────────────────────────────────────────────────────
  console.log('8) Auth matrix')
  const d7 = await makeDevice('e7-noauth', 'noauth')
  const noAuth = await fetch(`${BASE}${HEALTH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fullBody()),
  })
  check('no Authorization → 401', noAuth.status === 401, `(got ${noAuth.status})`)

  const d8 = await makeDevice('e7-badtoken', 'badtoken')
  const badTok = await signedRequest({ token: 'deadbeef-deadbeef-deadbeef-deadbeef', deviceId: d8.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('unknown token → 401', badTok.status === 401, `(got ${badTok.status})`)

  const d9 = await makeDevice('e7-clock', 'clock')
  const past = await signedRequest({ token: d9.token, deviceId: d9.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE(), ts: Date.now() - 400000 })
  check('expired timestamp (−400 s) → 429 AGENT_CLOCK_SKEW (retryable, pre-rate-limit)', past.status === 429 && past.json.error?.code === 'AGENT_CLOCK_SKEW', `(got ${past.status} ${past.json.error?.code})`)
  const future = await signedRequest({ token: d9.token, deviceId: d9.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE(), ts: Date.now() + 400000 })
  check('future timestamp (+400 s) → 429 AGENT_CLOCK_SKEW', future.status === 429 && future.json.error?.code === 'AGENT_CLOCK_SKEW', `(got ${future.status} ${future.json.error?.code})`)

  const d10 = await makeDevice('e7-revoked', 'revoked')
  const r1 = await signedRequest({ token: d10.token, deviceId: d10.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('pre-revoke request → 200', r1.status === 200, `(got ${r1.status})`)
  db.query('UPDATE AgentCredential SET revokedAt = ?, revokeReason = ? WHERE deviceId = ?').run(new Date().toISOString(), 'test-revoke', d10.deviceId)
  const r2 = await signedRequest({ token: d10.token, deviceId: d10.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('revoked credential → 401 AGENT_TOKEN_EXPIRED', r2.status === 401 && r2.json.error?.code === 'AGENT_TOKEN_EXPIRED', `(got ${r2.status} ${r2.json.error?.code})`)

  const d11 = await makeDevice('e7-suspended', 'suspended')
  db.query("UPDATE Device SET status = 'Suspended' WHERE id = ?").run(d11.deviceId)
  const s1 = await signedRequest({ token: d11.token, deviceId: d11.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('suspended device → 403 AGENT_DEVICE_REVOKED', s1.status === 403 && s1.json.error?.code === 'AGENT_DEVICE_REVOKED', `(got ${s1.status} ${s1.json.error?.code})`)
  db.query("UPDATE Device SET status = 'Online' WHERE id = ?").run(d11.deviceId)
  const s1b = await signedRequest({ token: d11.token, deviceId: d11.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('restored device → 200 again', s1b.status === 200, `(got ${s1b.status})`)

  const d12 = await makeDevice('e7-retired', 'retired')
  db.query("UPDATE Device SET status = 'Retired' WHERE id = ?").run(d12.deviceId)
  const rt1 = await signedRequest({ token: d12.token, deviceId: d12.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('retired device → 403 AGENT_DEVICE_REVOKED', rt1.status === 403 && rt1.json.error?.code === 'AGENT_DEVICE_REVOKED', `(got ${rt1.status} ${rt1.json.error?.code})`)

  const d13 = await makeDevice('e7-instdisabled', 'instdisabled')
  db.query("UPDATE Installation SET status = 'Disabled' WHERE id = ?").run(INSTALLATION_ID)
  const i1 = await signedRequest({ token: d13.token, deviceId: d13.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('disabled installation → 403 AGENT_INSTALLATION_DISABLED', i1.status === 403 && i1.json.error?.code === 'AGENT_INSTALLATION_DISABLED', `(got ${i1.status} ${i1.json.error?.code})`)
  db.query("UPDATE Installation SET status = 'Active' WHERE id = ?").run(INSTALLATION_ID)
  const i1b = await signedRequest({ token: d13.token, deviceId: d13.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('re-enabled installation → 200 again', i1b.status === 200, `(got ${i1b.status})`)

  const d14 = await makeDevice('e7-unassigned', 'unassigned')
  db.query('UPDATE DeviceAssignment SET revokedAt = ?, revokeReason = ? WHERE deviceId = ?').run(new Date().toISOString(), 'test-revoke', d14.deviceId)
  const u1 = await signedRequest({ token: d14.token, deviceId: d14.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('no active assignment → 403 AGENT_DEVICE_UNASSIGNED', u1.status === 403 && u1.json.error?.code === 'AGENT_DEVICE_UNASSIGNED', `(got ${u1.status} ${u1.json.error?.code})`)
  db.query('UPDATE DeviceAssignment SET revokedAt = NULL, revokeReason = NULL WHERE deviceId = ?').run(d14.deviceId)
  const u1b = await signedRequest({ token: d14.token, deviceId: d14.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('restored assignment → 200 again', u1b.status === 200, `(got ${u1b.status})`)

  const regPending = await registerDevice('e7-pending')
  devices.push(regPending.deviceId)
  const p1 = await signedRequest({ token: regPending.token, deviceId: regPending.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('pending device (not activated) → 403 AGENT_DEVICE_PENDING', p1.status === 403 && p1.json.error?.code === 'AGENT_DEVICE_PENDING', `(got ${p1.status} ${p1.json.error?.code})`)

  // ── 9. Replay protection ──────────────────────────────────────────────────
  console.log('9) Replay protection')
  const d15 = await makeDevice('e7-replay', 'replay')
  const nonce = NONCE()
  const ts = Date.now()
  const rep1 = await signedRequest({ token: d15.token, deviceId: d15.deviceId, path: HEALTH, body: fullBody(), nonce, ts, noSleep: true })
  const rep2 = await signedRequest({ token: d15.token, deviceId: d15.deviceId, path: HEALTH, body: fullBody(), nonce, ts, noSleep: true })
  check('first request → 200', rep1.status === 200, `(got ${rep1.status})`)
  check('replayed nonce+ts → 409 AGENT_REPLAY', rep2.status === 409 && rep2.json.error?.code === 'AGENT_REPLAY', `(got ${rep2.status} ${rep2.json.error?.code})`)

  // ── 10. Rate limiting — 1/60 s, burst 2 (contract §3 E7) ──────────────────
  console.log('10) Rate limiting')
  const d16 = await makeDevice('e7-rate', 'rate')
  const statuses = []
  for (let i = 0; i < 3; i++) {
    const r = await signedRequest({ token: d16.token, deviceId: d16.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE(), noSleep: true })
    statuses.push(r.status)
    if (i === 2) {
      check('burst of 2 then 429 (statuses 200,200,429)', statuses[0] === 200 && statuses[1] === 200 && statuses[2] === 429, `(got ${statuses.join(',')})`)
      check('429 carries AGENT_RATE_LIMITED + Retry-After', r.json.error?.code === 'AGENT_RATE_LIMITED' && !!r.headers.get('retry-after'), `(got ${r.json.error?.code})`)
    }
  }

  // ── 11. X-Token-Expires warning header ────────────────────────────────────
  console.log('11) X-Token-Expires')
  const d17 = await makeDevice('e7-expire', 'expire')
  db.query('UPDATE AgentCredential SET expiresAt = ? WHERE deviceId = ?').run(new Date(Date.now() + 10 * 86400000).toISOString(), d17.deviceId)
  const ex1 = await signedRequest({ token: d17.token, deviceId: d17.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('credential within 30 d → X-Token-Expires header', ex1.status === 200 && !!ex1.headers.get('x-token-expires'), `(got ${ex1.status})`)

  // ── 12. DB integrity ──────────────────────────────────────────────────────
  console.log('12) DB integrity')
  const d18 = await makeDevice('e7-clock2', 'clock2')
  const c1 = await signedRequest({ token: d18.token, deviceId: d18.deviceId, path: HEALTH, body: fullBody({ clientTime: Date.now() - 999999 }), nonce: NONCE() })
  const snap18 = getSnapshots(d18.deviceId)[0]
  check('clientTime NOT trusted for persistence (server ts)', Math.abs(new Date(snap18.ts).getTime() - c1.json.serverTime) < 3000, `(snapshot ${new Date(snap18.ts).getTime()} vs server ${c1.json.serverTime}, client was −999999)`)
  const indexRow = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'DeviceHealthSnapshot' AND name LIKE '%deviceId%ts%'").get()
  check('(deviceId, ts) index exists (§5.17)', !!indexRow, JSON.stringify(indexRow))
  const orphans = db.query('SELECT count(*) c FROM DeviceHealthSnapshot s WHERE NOT EXISTS (SELECT 1 FROM Device d WHERE d.id = s.deviceId)').get().c
  check('zero orphan snapshot rows', orphans === 0, `(got ${orphans})`)

  // FK cascade (ADR-024 — device-scoped control rows cascade).
  const d19 = await makeDevice('e7-cascade', 'cascade')
  const ca1 = await signedRequest({ token: d19.token, deviceId: d19.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('cascade device health works → 200', ca1.status === 200)
  check('cascade device has 1 snapshot', countSnapshots(d19.deviceId) === 1)
  db.query('DELETE FROM DeviceAssignment WHERE deviceId = ?').run(d19.deviceId)
  db.query('DELETE FROM Device WHERE id = ?').run(d19.deviceId)
  check('snapshots cascade-deleted with device (ADR-024)', countSnapshots(d19.deviceId) === 0, `(got ${countSnapshots(d19.deviceId)})`)

  // ── 13. Regression — E1/E2/E3/E5/E6/E16 ───────────────────────────────────
  console.log('13) Regression E1/E2/E3/E5/E6/E16')
  const d20 = await makeDevice('e7-regress', 'regress')
  check('E1 register → 201 (fresh device D20)', d20.status === 201, `(got ${d20.status})`)
  check('E2 activate → 200', d20.act === 200, `(got ${d20.act})`)
  const hb1 = await signedRequest({ token: d20.token, deviceId: d20.deviceId, path: '/api/agent/v1/heartbeat', body: JSON.stringify({ clientTime: Date.now(), status: 'online' }), nonce: NONCE() })
  check('E3 heartbeat → 200', hb1.status === 200, `(got ${hb1.status})`)
  const ac1 = await signedRequest({
    token: d20.token, deviceId: d20.deviceId, path: '/api/agent/v1/activity',
    body: { batchId: 'b_e7_regress', events: [{ seq: 1, ts: Date.now(), kind: 'app', app: { name: 'Code.exe', windowTitle: 't.ts', processName: 'Code', durationSec: 5, focusSec: 5 } }] },
    nonce: NONCE(),
  })
  check('E5 activity → 202 accepted', ac1.status === 202 && ac1.json.accepted === 1, `(got ${ac1.status}) ${JSON.stringify(ac1.json.error ?? '')}`)
  const ss1 = await signedRequest({ token: d20.token, deviceId: d20.deviceId, path: `/api/agent/v1/screenshots?mode=single${qMeta(IMG_A)}`, body: IMG_A, nonce: NONCE() })
  const ssRow = db.query('SELECT * FROM Screenshot WHERE deviceId = ? ORDER BY createdAt DESC').get(d20.deviceId)
  check('E6 single-shot screenshot → 201 stored', ss1.status === 201 && ss1.json.stored === true, `(got ${ss1.status}) ${JSON.stringify(ss1.json)}`)
  check('E6 row persisted with file on disk', !!ssRow?.storagePath && existsSync(path.join(STORAGE_ROOT, ssRow.storagePath)))
  const rt1b = await signedRequest({ token: d20.token, deviceId: d20.deviceId, path: '/api/agent/v1/token/rotate', body: { clientTime: Date.now() }, nonce: NONCE() })
  check('E16 rotate → 200 with new token', rt1b.status === 200 && !!rt1b.json.token, `(got ${rt1b.status})`)
  const hb2 = await signedRequest({ token: rt1b.json.token, deviceId: d20.deviceId, path: '/api/agent/v1/heartbeat', body: JSON.stringify({ clientTime: Date.now(), status: 'online' }), nonce: NONCE() })
  check('E3 with rotated token → 200', hb2.status === 200, `(got ${hb2.status})`)
  const h20 = await signedRequest({ token: rt1b.json.token, deviceId: d20.deviceId, path: HEALTH, body: fullBody(), nonce: NONCE() })
  check('E7 health on rotated credential → 200', h20.status === 200 && h20.json.accepted === true, `(got ${h20.status}) ${JSON.stringify(h20.json.error ?? '')}`)

  console.log(`\n  Devices: ${devices.length} · snapshots written across suite`)
} finally {
  // ── Cleanup ──────────────────────────────────────────────────────────────
  console.log('\n--- Cleanup ---')
  for (const device of devices) {
    if (!device) continue
    const files = db.query('SELECT storagePath FROM Screenshot WHERE deviceId = ? AND storagePath IS NOT NULL').all(device)
    for (const f of files) rmSync(path.join(STORAGE_ROOT, f.storagePath), { force: true })
    db.query('DELETE FROM Screenshot WHERE deviceId = ?').run(device)
    db.query('DELETE FROM UploadTicket WHERE deviceId = ?').run(device)
    db.query('DELETE FROM ActivityEvent WHERE deviceId = ?').run(device)
    db.query('DELETE FROM DeviceHealthSnapshot WHERE deviceId = ?').run(device)
    db.query('DELETE FROM DeviceAssignment WHERE deviceId = ?').run(device)
    db.query('DELETE FROM AgentCredential WHERE deviceId = ?').run(device)
    db.query('DELETE FROM Device WHERE id = ?').run(device)
  }
  for (const u of testUsers) db.query('DELETE FROM User WHERE id = ?').run(u)
  db.query("UPDATE Installation SET status = 'Active' WHERE id = ?").run(INSTALLATION_ID)
  console.log(`  Removed test data. devices=${db.query('SELECT count(*) c FROM Device').get().c} snapshots=${db.query('SELECT count(*) c FROM DeviceHealthSnapshot').get().c} screenshots=${db.query('SELECT count(*) c FROM Screenshot').get().c}`)
  db.close()
  }
}

await main()

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`)
if (failed > 0) {
  console.log('Failed:', failures.join(', '))
  process.exit(1)
}
process.exit(0)
