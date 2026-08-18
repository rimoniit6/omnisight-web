/**
 * M009 Stage-2 — Remote Command Execution, Update Delivery & Policy
 * Synchronization (pull/result plane) — Verification.
 *
 * Verifies (mission §3-§8, §10):
 *   · Command Pull API (GET /api/agent/v1/commands) — delivery w/ receipts,
 *     server-executable exclusion, priority/FIFO ordering, pagination.
 *   · Command Result API (POST /api/agent/v1/commands/result) — validated
 *     lifecycle (delivered→acknowledged→running→terminal), receipt checks,
 *     idempotent terminal re-reports, server-computed executionMs, summary
 *     truncation, bounded retry with notBefore backoff, isolation.
 *   · Policy Sync · Config Sync · Update Delivery — ETag/304 optimization.
 *   · Heartbeat real fields (pending commands / policy / config / update).
 *   · Delivery semantics — stale redelivery (at-least-once), worker requeue
 *     sweep, receipt rotation.
 *   · Stage-2 rate-limit rules (commands / commandResult / policy / config /
 *     update).
 *   · Admin command DTO surfaces all new lifecycle fields · audit trail.
 *
 * Run against a dev server (FLEET_WORKER_ENABLED=true is fine):
 *   npx next dev -p 3100
 *   BASE_URL=http://localhost:3100 bun scripts/verify-m009-stage2.mjs
 *
 * Env: BASE_URL (default http://localhost:3100) · DB_PATH (default db/custom.db)
 *      SUPER_ADMIN_EMAIL · SUPER_ADMIN_PASSWORD
 */
import { createHash, randomBytes } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { signAgentRequest } from '../src/lib/agent-auth/signature'

const BASE = process.env.BASE_URL || 'http://localhost:3100'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'aria.martin@umbrella.com'
const ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || ''
const INSTALLATION_ID = 'inst_demo_default'
const JOIN_KEY = 'WL-DEMO-JOINKEY-2026'

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

function section(title) {
  console.log(`\n━━ ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`)
}

const db = new Database(DB_PATH)
db.exec('PRAGMA busy_timeout = 10000')
db.run('PRAGMA foreign_keys = ON')
const q = (sql, ...args) => db.query(sql)?.get?.(...args) ?? null
const qa = (sql, ...args) => db.query(sql)?.all?.(...args) ?? []
const run = (sql, ...args) => db.query(sql).run(...args)

const sha256hex = (s) => createHash('sha256').update(s).digest('hex')
const NONCE = () => Buffer.from(randomBytes(16)).toString('base64url')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cookieOf = (res) => {
  const set = res.headers.get('set-cookie') || ''
  const m = set.match(/wl_session=[^;]+/)
  return m ? m[0] : ''
}

let SESSION_COOKIE = ''
let ADMIN_TOKEN = ''

async function loginAs(email, password) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, token: json.token, cookie: cookieOf(res) }
}

async function apiReq(token, method, p, { cookie = SESSION_COOKIE, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { authorization: 'Bearer ' + token, cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, headers: res.headers }
}

// Direct queue imports — deterministic state-machine coverage (Stage-1 pattern).
const fleetQueue = await import('../src/lib/fleet/queue')
const fleetVersions = await import('../src/lib/fleet/versions')

function createTestUser(name, role = 'Employee', orgId = null) {
  const id = `m9s2_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  db.query('INSERT INTO User (id, name, email, role, status, organizationId, updatedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    name,
    `m9s2-${name.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}@test.local`,
    role,
    'Active',
    orgId,
    new Date().toISOString(),
    new Date().toISOString()
  )
  return id
}

async function registerDevice(hostnameSuffix) {
  const serial = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await fetch(`${BASE}/api/agent/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.82' },
    body: JSON.stringify({
      installationId: INSTALLATION_ID,
      joinKey: JOIN_KEY,
      clientTime: Date.now(),
      hostname: `VERIFY-M009S2-${hostnameSuffix}-${serial}`,
      os: { family: 'Windows', version: '11', build: '22631', arch: 'x64' },
      hardware: { cpu: 'Intel i7-13700K', ramGB: 32, diskGB: 512, mac: 'AA:BB:CC:DD:EE:F9', serial: `SN-M009S2-${serial}` },
      agentVersion: '1.0.3',
      capabilities: ['activity', 'health', 'commands'],
    }),
  })
  const json = await reg.json().catch(() => ({}))
  return { status: reg.status, deviceId: json.deviceId, token: json.agentToken }
}

/** Sign + send a request. GET (no body) signs sha256hex('') exactly like the server. */
async function signedReq({ token, deviceId, method = 'POST', path, body, nonce, ts = Date.now(), extraHeaders = {} }) {
  const bodyStr = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const signature = signAgentRequest({ key: token, method, path, timestamp: ts, nonce, body: bodyStr })
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'x-installation-id': INSTALLATION_ID,
      'x-device-id': deviceId,
      'x-agent-version': '1.0.3',
      'x-timestamp': String(ts),
      'x-nonce': nonce,
      'x-agent-signature': signature,
      ...(bodyStr ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: bodyStr || undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, headers: res.headers }
}

const signedPost = (o) => signedReq({ ...o, method: 'POST' })
const signedGet = (o) => signedReq({ ...o, method: 'GET' })

async function activateAgent(token, deviceId, userId) {
  db.query('UPDATE User SET deviceId = ? WHERE id = ?').run(deviceId, userId)
  return signedPost({ token, deviceId, path: '/api/agent/v1/activate', body: { clientTime: Date.now() }, nonce: NONCE() })
}

// ── Setup ─────────────────────────────────────────────────────────────────────
console.log('\nM009 Stage-2 Fleet Verification — ' + BASE)

// Idempotent pre-clean: purge test releases left behind by interrupted runs.
db.query("DELETE FROM AgentRelease WHERE version IN ('99.99.99-stage2', '9.9.9', '2.0.0')").run()

const loginRes = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)
check('admin login succeeds', loginRes.status === 200, 'status=' + loginRes.status)
ADMIN_TOKEN = loginRes.token || ''
SESSION_COOKIE = loginRes.cookie || ''

async function makeDevice(suffix) {
  const reg = await registerDevice(suffix)
  check(`${suffix} register → 201`, reg.status === 201, 'status=' + reg.status)
  const userId = createTestUser(`M009 S2 ${suffix}`)
  const act = await activateAgent(reg.token, reg.deviceId, userId)
  check(`${suffix} activate → 200`, act.status === 200, 'status=' + act.status)
  return { deviceId: reg.deviceId, token: reg.token, userId }
}

const MAIN = await makeDevice('MAIN')
const PAG = await makeDevice('PAG')
const RATE = await makeDevice('RATE')
const createdDevices = [MAIN.deviceId, PAG.deviceId, RATE.deviceId]
const createdUsers = [MAIN.userId, PAG.userId, RATE.userId]

const RELEASE_VERSION = '99.99.99-stage2'
const audited = () => qa('SELECT DISTINCT action FROM AuditLog WHERE actor = ? ORDER BY createdAt DESC LIMIT 500', 'agent').map((r) => r.action)
const allActionsLazy = () => qa('SELECT DISTINCT action FROM AuditLog ORDER BY createdAt DESC LIMIT 2000').map((r) => r.action)

try {
  // ── 1. Policy Sync (ETag / 304) ─────────────────────────────────────────────
  section('Policy Sync — GET /api/agent/v1/policy')

  const p1 = await signedGet({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/policy', nonce: NONCE() })
  check('policy → 200', p1.status === 200, 'status=' + p1.status)
  check('policy has version', typeof p1.json?.version === 'number' && p1.json.version >= 1)
  check('policy has policy object', typeof p1.json?.policy === 'object' && p1.json.policy !== null)
  check('policy has etag', typeof p1.json?.etag === 'string' && p1.json.etag.startsWith('"'))
  check('policy has updatedAt', typeof p1.json?.updatedAt === 'string')
  check('policy has serverTime + X-Server-Time', typeof p1.json?.serverTime === 'number' && !!p1.headers.get('x-server-time'))

  const p2 = await signedGet({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/policy', nonce: NONCE(), extraHeaders: { 'if-none-match': p1.json.etag } })
  check('policy If-None-Match match → 304', p2.status === 304, 'status=' + p2.status)
  check('304 carries etag header', p2.headers.get('etag') === p1.json.etag)

  const p3 = await signedGet({ token: PAG.token, deviceId: PAG.deviceId, path: '/api/agent/v1/policy', nonce: NONCE(), extraHeaders: { 'if-none-match': '"deadbeef"' } })
  check('policy stale If-None-Match → 200', p3.status === 200, 'status=' + p3.status)

  // ── 2. Config Sync ──────────────────────────────────────────────────────────
  section('Config Sync — GET /api/agent/v1/config')

  const c1 = await signedGet({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/config', nonce: NONCE() })
  check('config → 200', c1.status === 200, 'status=' + c1.status)
  check('config has version', typeof c1.json?.version === 'number')
  check('config heartbeat interval present', typeof c1.json?.config?.heartbeat?.intervalMs === 'number' && c1.json.config.heartbeat.intervalMs > 0)
  check('config commands redeliverAfterMs = 30000', c1.json?.config?.commands?.redeliverAfterMs === 30000)
  check('config commands limits present', c1.json?.config?.commands?.resultMaxStdoutSummary === 8192 && c1.json.config.commands.resultMaxError === 4096)
  check('config security knobs present', typeof c1.json?.config?.security?.clockToleranceMs === 'number')
  check('config feature flags on', c1.json?.config?.featureFlags?.commands === true && c1.json.config.featureFlags.policySync === true)
  check('config has etag + updatedAt', typeof c1.json?.etag === 'string' && typeof c1.json?.updatedAt === 'string')

  const c2 = await signedGet({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/config', nonce: NONCE(), extraHeaders: { 'if-none-match': c1.json.etag } })
  check('config If-None-Match match → 304', c2.status === 304, 'status=' + c2.status)

  // ── 3. Update Manifest (before release) ─────────────────────────────────────
  section('Update Delivery — GET /api/agent/v1/update')

  const u1 = await signedGet({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/update', nonce: NONCE() })
  check('update → 200', u1.status === 200, 'status=' + u1.status)
  check('update has currentVersion', typeof u1.json?.currentVersion === 'string')
  check('update has update flags', typeof u1.json?.updateAvailable === 'boolean' && typeof u1.json?.updateRequired === 'boolean')
  check('update has etag', typeof u1.json?.etag === 'string')

  const u2 = await signedGet({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/update', nonce: NONCE(), extraHeaders: { 'if-none-match': u1.json.etag } })
  check('update If-None-Match match → 304', u2.status === 304, 'status=' + u2.status)

  // ── 4. Release with integrity metadata ──────────────────────────────────────
  section('Release integrity metadata (sha256 / downloadUrl / signature / minAgentVersion)')

  const relRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/agents/versions', {
    body: {
      version: RELEASE_VERSION,
      channel: 'stable',
      notes: 'stage2 verified release',
      sha256: 'a'.repeat(64),
      downloadUrl: 'https://downloads.example.test/agent-' + RELEASE_VERSION + '.zip',
      signature: 'SIG-' + RELEASE_VERSION,
      minAgentVersion: '1.0.0',
    },
  })
  check('POST release → 200', relRes.status === 200, 'status=' + relRes.status + ' ' + JSON.stringify(relRes.json?.error || ''))
  check('release round-trips sha256', relRes.json?.release?.sha256 === 'a'.repeat(64))
  check('release round-trips downloadUrl', (relRes.json?.release?.downloadUrl || '').includes(RELEASE_VERSION))
  check('release round-trips signature', relRes.json?.release?.signature === 'SIG-' + RELEASE_VERSION)
  check('release round-trips minAgentVersion', relRes.json?.release?.minAgentVersion === '1.0.0')

  const versionsApi = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/agents/versions')
  const vRel = (versionsApi.json?.releases || []).find((r) => r.version === RELEASE_VERSION)
  check('GET versions lists new release w/ metadata', !!vRel && vRel.sha256 === 'a'.repeat(64) && vRel.minAgentVersion === '1.0.0')
  check('versions latest reflects new release', versionsApi.json?.latest === RELEASE_VERSION)

  const manAfter = await fleetVersions.getUpdateManifest(MAIN.deviceId)
  check('updateAvailable=true after release', manAfter.updateAvailable === true, JSON.stringify({ a: manAfter.updateAvailable }))
  check('manifest targets new release', manAfter.update?.version === RELEASE_VERSION)
  check('manifest carries sha256', manAfter.update?.sha256 === 'a'.repeat(64))
  check('manifest carries signature + minAgentVersion', manAfter.update?.signature === 'SIG-' + RELEASE_VERSION && manAfter.update?.minAgentVersion === '1.0.0')
  check('manifest etag changed after release', manAfter.etag !== u1.json.etag)

  db.query('UPDATE Device SET agentVersion = ? WHERE id = ?').run('999.999.999', PAG.deviceId)
  const manNoUpdate = await fleetVersions.getUpdateManifest(PAG.deviceId)
  check('no update when agent already latest', manNoUpdate.updateAvailable === false && manNoUpdate.update === null)

  // ── 5. Heartbeat real fields ────────────────────────────────────────────────
  section('Heartbeat — real pending / policy / config / update fields')

  // Enqueue + immediately cancel server-executable commands so the worker
  // cannot change MAIN's pending set between assertions (deterministic count).
  const svcA = await fleetQueue.enqueueCommand({ deviceId: MAIN.deviceId, type: 'refresh_policy', requestedBy: 'verify' })
  const svcB = await fleetQueue.enqueueCommand({ deviceId: MAIN.deviceId, type: 'clear_cache', requestedBy: 'verify' })
  await fleetQueue.cancelCommand(svcA.commandId, 'verify', 'isolate heartbeat')
  await fleetQueue.cancelCommand(svcB.commandId, 'verify', 'isolate heartbeat')

  const hb = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/heartbeat', body: { clientTime: Date.now(), status: 'online' }, nonce: NONCE() })
  check('heartbeat → 200', hb.status === 200, 'status=' + hb.status)
  check('heartbeat heartbeatIntervalMs > 0', typeof hb.json?.heartbeatIntervalMs === 'number' && hb.json.heartbeatIntervalMs > 0)
  check('heartbeat policyVersion real', typeof hb.json?.policyVersion === 'number' && hb.json.policyVersion >= 1)
  check('heartbeat configVersion real', typeof hb.json?.configVersion === 'number' && hb.json.configVersion >= 1)
  check('heartbeat updateAvailable true (release live)', hb.json?.updateAvailable === true)
  check('heartbeat updateVersion points at release', hb.json?.updateVersion === RELEASE_VERSION)
  check('heartbeat commands is E3 list + pendingCommandCount numeric', Array.isArray(hb.json?.commands) && typeof hb.json?.pendingCommandCount === 'number' && hb.json.pendingCommandCount === 0, 'commands=' + JSON.stringify(hb.json?.commands) + ' count=' + hb.json?.pendingCommandCount)

  // ── 6. Command Pull API ─────────────────────────────────────────────────────
  section('Command Pull API — GET /api/agent/v1/commands')

  const unauth = await fetch(BASE + '/api/agent/v1/commands')
  check('pull unauthenticated → 401', unauth.status === 401, 'status=' + unauth.status)

  // Server-executable commands (highest priority — would sort first if leaked).
  const serverA = await fleetQueue.enqueueCommand({ deviceId: MAIN.deviceId, type: 'refresh_policy', priority: 10, requestedBy: 'verify' })
  const serverB = await fleetQueue.enqueueCommand({ deviceId: MAIN.deviceId, type: 'clear_cache', priority: 10, requestedBy: 'verify' })
  // Agent commands — force_upload + sync_now (p5, FIFO) then capture_screenshot (p1).
  const cA = await fleetQueue.enqueueCommand({ deviceId: MAIN.deviceId, type: 'force_upload', priority: 5, requestedBy: 'verify' })
  const cB = await fleetQueue.enqueueCommand({ deviceId: MAIN.deviceId, type: 'sync_now', priority: 5, requestedBy: 'verify' })
  const cC = await fleetQueue.enqueueCommand({ deviceId: MAIN.deviceId, type: 'capture_screenshot', priority: 1, requestedBy: 'verify' })

  const pull = await signedGet({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands', nonce: NONCE() })
  check('pull → 200', pull.status === 200, 'status=' + pull.status)
  check('pull has serverTime + hasMore', typeof pull.json?.serverTime === 'number' && typeof pull.json?.hasMore === 'boolean')
  const pulled = pull.json?.commands || []
  check('pull returns 3 agent commands', pulled.length === 3, 'got ' + pulled.length)
  const pulledTypes = pulled.map((c) => c.type)
  check('server-executable commands excluded', !pulledTypes.some((t) => ['refresh_policy', 'refresh_config', 'collect_health', 'clear_cache'].includes(t)))
  check('pull order: priority desc then FIFO', pulled[0]?.id === cA.commandId && pulled[1]?.id === cB.commandId && pulled[2]?.id === cC.commandId, 'got ' + pulled.map((c) => c.id.slice(0, 8)).join(','))
  check('every delivered command carries a receipt token', pulled.every((c) => typeof c.ackToken === 'string' && c.ackToken.length === 48))
  check('pull exposes retryCount + dedupKey', pulled.every((c) => typeof c.retryCount === 'number' && 'dedupKey' in c))

  const dA = q('SELECT status, deliveredAt, deliveryToken FROM AgentCommand WHERE id = ?', cA.commandId)
  check('pull marks delivered + stamps deliveredAt', dA?.status === 'delivered' && !!dA?.deliveredAt && !!dA?.deliveryToken)
  const srvRow = q('SELECT status FROM AgentCommand WHERE id = ?', serverA.commandId)
  check('server-executable never delivered to agent (worker-owned)', ['queued', 'running', 'completed', 'failed'].includes(srvRow?.status) && srvRow?.status !== 'delivered', 'status=' + srvRow?.status)

  const auditAfterPull = audited()
  check('audit fleet_command_delivered', auditAfterPull.includes('fleet_command_delivered'))

  // ── 7. Command Result API — lifecycle ───────────────────────────────────────
  section('Command Result API — POST /api/agent/v1/commands/result')

  const ackA = pulled.find((c) => c.id === cA.commandId)?.ackToken

  const badAck = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: cA.commandId, status: 'running', ackToken: 'wrong-token' }, nonce: NONCE() })
  check('delivered→running wrong receipt → 422', badAck.status === 422, 'status=' + badAck.status)
  check('bad receipt code AGENT_CMD_BAD_ACK_TOKEN', badAck.json?.error?.details?.code === 'AGENT_CMD_BAD_ACK_TOKEN')
  check('bad receipt leaves command delivered', q('SELECT status FROM AgentCommand WHERE id = ?', cA.commandId)?.status === 'delivered')

  const runA = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: cA.commandId, status: 'running', ackToken: ackA }, nonce: NONCE() })
  check('delivered→running with receipt → 200', runA.status === 200 && runA.json?.status === 'running', 'status=' + runA.status + ' ' + JSON.stringify(runA.json))
  const runRow = q('SELECT status, startedAt, acknowledgedAt FROM AgentCommand WHERE id = ?', cA.commandId)
  check('running stamps startedAt (+acknowledgedAt)', runRow?.status === 'running' && !!runRow?.startedAt && !!runRow?.acknowledgedAt)

  const completeA = await signedPost({
    token: MAIN.token,
    deviceId: MAIN.deviceId,
    path: '/api/agent/v1/commands/result',
    body: {
      commandId: cA.commandId,
      status: 'completed',
      stdoutSummary: 'captured 1234 bytes',
      stderrSummary: '',
      exitCode: 0,
      executionMs: 1234,
      result: { ok: true, bytes: 1234 },
      metadata: { agentNote: 'done' },
    },
    nonce: NONCE(),
  })
  check('running→completed → 200', completeA.status === 200 && completeA.json?.status === 'completed', 'status=' + completeA.status)
  const compRow = q('SELECT status, completedAt, executionMs, stdoutSummary, stderrSummary, exitCode, result, metadata, deliveryToken FROM AgentCommand WHERE id = ?', cA.commandId)
  check('completed persists result JSON', compRow?.status === 'completed' && (compRow?.result || '').includes('"bytes":1234'))
  check('completed persists stdoutSummary + exitCode', compRow?.stdoutSummary === 'captured 1234 bytes' && compRow?.exitCode === 0)
  check('executionMs server-computed (not client 1234)', typeof compRow?.executionMs === 'number' && compRow.executionMs >= 0 && compRow.executionMs !== 1234, 'executionMs=' + compRow?.executionMs)
  check('client executionMs stored advisory in metadata', (compRow?.metadata || '').includes('1234') && (compRow?.metadata || '').includes('clientReportedExecutionMs'))
  check('delivery receipt consumed on terminal', compRow?.deliveryToken === null)

  const reComp = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: cA.commandId, status: 'completed' }, nonce: NONCE() })
  check('terminal re-report same status → idempotent alreadyFinal', reComp.status === 200 && reComp.json?.alreadyFinal === true, JSON.stringify(reComp.json))
  const afterReComp = q('SELECT completedAt FROM AgentCommand WHERE id = ?', cA.commandId)
  check('idempotent re-report does not rewrite', afterReComp?.completedAt === compRow?.completedAt)

  const reFail = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: cA.commandId, status: 'failed', ackToken: 'x' }, nonce: NONCE() })
  check('terminal → different terminal → 422', reFail.status === 422, 'status=' + reFail.status)

  // Full chain: delivered → acknowledged → running → cancelled (receipt on first step).
  const ackB = pulled.find((c) => c.id === cB.commandId)?.ackToken
  const ackB1 = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: cB.commandId, status: 'acknowledged', ackToken: ackB }, nonce: NONCE() })
  check('delivered→acknowledged → 200', ackB1.status === 200 && ackB1.json?.status === 'acknowledged')
  check('acknowledged stamps acknowledgedAt only', !!q('SELECT acknowledgedAt FROM AgentCommand WHERE id = ?', cB.commandId)?.acknowledgedAt && !q('SELECT startedAt FROM AgentCommand WHERE id = ?', cB.commandId)?.startedAt)
  const runB = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: cB.commandId, status: 'running' }, nonce: NONCE() })
  check('acknowledged→running → 200', runB.status === 200, 'status=' + runB.status)
  const backB = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: cB.commandId, status: 'acknowledged' }, nonce: NONCE() })
  check('running→acknowledged (backward) → 422', backB.status === 422, 'status=' + backB.status)
  const cancelB = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: cB.commandId, status: 'cancelled', error: 'agent self-cancel' }, nonce: NONCE() })
  check('running→cancelled → 200', cancelB.status === 200 && cancelB.json?.status === 'cancelled', JSON.stringify(cancelB.json))
  check('cancelled persisted w/ error', q('SELECT status, error FROM AgentCommand WHERE id = ?', cB.commandId)?.status === 'cancelled')

  const notFound = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: 'no-such-command-xyz', status: 'completed' }, nonce: NONCE() })
  check('unknown command → 422', notFound.status === 422, 'status=' + notFound.status)

  // Cross-device isolation: PAG's command is invisible to MAIN.
  const isoCmd = await fleetQueue.enqueueCommand({ deviceId: PAG.deviceId, type: 'sync_now', requestedBy: 'verify' })
  const iso = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: isoCmd.commandId, status: 'completed' }, nonce: NONCE() })
  check('other device command → 422 not found', iso.status === 422, 'status=' + iso.status)

  const zodBad = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: 123, status: 'weird' }, nonce: NONCE() })
  check('malformed result body → 422 AGENT_VALIDATION', zodBad.status === 422 && zodBad.json?.error?.code === 'AGENT_VALIDATION')

  // ── 8. Failure retry: requeue + notBefore backoff + exhaustion ──────────────
  section('Failure retry — bounded backoff (notBefore) + exhaustion')

  const ackC = pulled.find((c) => c.id === cC.commandId)?.ackToken
  const failC = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: cC.commandId, status: 'failed', ackToken: ackC, error: 'boom', executionMs: 42, metadata: { attempt: 'first' } }, nonce: NONCE() })
  check('failed w/ retries left → requeued (status queued)', failC.status === 200 && failC.json?.status === 'queued', JSON.stringify(failC.json))
  const requeuedC = q('SELECT status, retryCount, notBefore, deliveredAt, deliveryToken, error FROM AgentCommand WHERE id = ?', cC.commandId)
  check('requeued row: retryCount=1 + notBefore backoff', requeuedC?.status === 'queued' && requeuedC?.retryCount === 1 && !!requeuedC?.notBefore)
  check('backoff is ~5s in the future', new Date(requeuedC.notBefore).getTime() >= Date.now() + 4000 && new Date(requeuedC.notBefore).getTime() <= Date.now() + 8000, 'notBefore=' + requeuedC?.notBefore)
  check('requeue clears delivery token/state', requeuedC?.deliveredAt === null && requeuedC?.deliveryToken === null)
  check('requeue preserves error for diagnostics', requeuedC?.error === 'boom')
  check('audit fleet_command_retried', audited().includes('fleet_command_retried'))

  // Backoff gate: not delivered again until notBefore passes.
  const gateDeliver = await fleetQueue.deliverCommandsForDevice(MAIN.deviceId, { limit: 50 })
  check('backoff gate: retried command NOT redelivered', !gateDeliver.commands.some((c) => c.id === cC.commandId))

  // Open the backoff window → redelivered with a fresh receipt, retryCount kept.
  // NOTE: raw-SQL timestamps must be epoch ms (Prisma stores SQLite DATETIME as INTEGER).
  run('UPDATE AgentCommand SET notBefore = ?, status = ?, deliveredAt = NULL, deliveryToken = NULL WHERE id = ?', Date.now() - 1000, 'queued', cC.commandId)
  const reDeliver = await fleetQueue.deliverCommandsForDevice(MAIN.deviceId, { limit: 50 })
  const redeliveredC = reDeliver.commands.find((c) => c.id === cC.commandId)
  check('retried command redelivered after backoff', !!redeliveredC)
  check('redelivery keeps retryCount', redeliveredC?.retryCount === 1)
  check('redelivery issues fresh receipt', redeliveredC?.ackToken !== ackC)

  // Exhaust retries → terminal failed (maxRetries lowered to 1 → this is attempt 2).
  run('UPDATE AgentCommand SET maxRetries = 1 WHERE id = ?', cC.commandId)
  const exhaustC = await fleetQueue.reportCommandStatus({ commandId: cC.commandId, status: 'failed', ackToken: redeliveredC.ackToken, error: 'final failure', deviceId: MAIN.deviceId })
  check('retries exhausted → terminal failed', exhaustC.ok === true && exhaustC.status === 'failed', JSON.stringify(exhaustC))
  const failedC = q('SELECT status, retryCount, error FROM AgentCommand WHERE id = ?', cC.commandId)
  check('failed terminal persisted', failedC?.status === 'failed' && failedC?.retryCount === 2 && failedC?.error === 'final failure')
  check('audit fleet_command_failed', audited().includes('fleet_command_failed'))

  // Timeout report → requeued (bounded retry), via the HTTP API.
  const cE = await fleetQueue.enqueueCommand({ deviceId: MAIN.deviceId, type: 'collect_diagnostics', maxRetries: 2, dedupKey: 'timeout-e', requestedBy: 'verify' })
  const pullE = await signedGet({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands', nonce: NONCE() })
  const deliveredE = (pullE.json?.commands || []).find((c) => c.id === cE.commandId)
  check('pull #2 delivers timeout-test command', !!deliveredE)
  const timeoutE = await signedPost({ token: MAIN.token, deviceId: MAIN.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: cE.commandId, status: 'timeout', ackToken: deliveredE.ackToken, error: 'deadline exceeded' }, nonce: NONCE() })
  check('timeout report → requeued', timeoutE.status === 200 && timeoutE.json?.status === 'queued', JSON.stringify(timeoutE.json))
  const retriedE = q('SELECT status, retryCount, notBefore FROM AgentCommand WHERE id = ?', cE.commandId)
  check('timeout requeue: retryCount=1 + backoff', retriedE?.status === 'queued' && retriedE?.retryCount === 1 && !!retriedE?.notBefore)

  // ── 9. Delivery semantics — pagination / type filter / redelivery / sweep ──
  section('Delivery semantics — pagination, redelivery, requeue sweep')

  // Direct deliver 3 commands (deterministic; no HTTP rate-limit interference).
  const d1 = await fleetQueue.enqueueCommand({ deviceId: PAG.deviceId, type: 'force_upload', priority: 5, requestedBy: 'verify' })
  const d2 = await fleetQueue.enqueueCommand({ deviceId: PAG.deviceId, type: 'sync_now', priority: 1, requestedBy: 'verify' })
  const d3 = await fleetQueue.enqueueCommand({ deviceId: PAG.deviceId, type: 'restart_agent', priority: 1, requestedBy: 'verify' })
  const firstDeliver = await fleetQueue.deliverCommandsForDevice(PAG.deviceId)
  check('direct deliver returns all 3 w/ receipts', firstDeliver.commands.length === 3 && firstDeliver.commands.every((c) => !!c.ackToken))
  const oldTokenD1 = firstDeliver.commands.find((c) => c.id === d1.commandId)?.ackToken

  // HTTP cursor pagination (PAG gets exactly 2 pulls = burst 2).
  const p1cmd = await fleetQueue.enqueueCommand({ deviceId: PAG.deviceId, type: 'capture_screenshot', dedupKey: 'page-1', requestedBy: 'verify' })
  const p2cmd = await fleetQueue.enqueueCommand({ deviceId: PAG.deviceId, type: 'capture_screenshot', dedupKey: 'page-2', requestedBy: 'verify' })
  const page1 = await signedGet({ token: PAG.token, deviceId: PAG.deviceId, path: '/api/agent/v1/commands?limit=1', nonce: NONCE() })
  check('pagination page 1: 1 command + hasMore', page1.status === 200 && (page1.json?.commands || []).length === 1 && page1.json?.hasMore === true)
  check('pagination returns opaque cursor', typeof page1.json?.cursor === 'string' && page1.json.cursor.length > 0)
  const page2 = await signedGet({ token: PAG.token, deviceId: PAG.deviceId, path: '/api/agent/v1/commands?limit=1&cursor=' + encodeURIComponent(page1.json.cursor), nonce: NONCE() })
  check('pagination page 2: next command + hasMore false', page2.status === 200 && (page2.json?.commands || []).length === 1 && page2.json?.hasMore === false)
  const pageIds = [page1.json?.commands?.[0]?.id, page2.json?.commands?.[0]?.id].sort()
  check('pagination pages do not overlap', pageIds[0] !== pageIds[1])
  const paginatedBoth = [p1cmd.commandId, p2cmd.commandId].sort()
  check('pagination returns exactly the two queued commands', pageIds[0] === paginatedBoth[0] && pageIds[1] === paginatedBoth[1])

  // Type filter.
  const f1 = await fleetQueue.enqueueCommand({ deviceId: PAG.deviceId, type: 'force_upload', dedupKey: 'filter-1', requestedBy: 'verify' })
  const typeFiltered = await fleetQueue.deliverCommandsForDevice(PAG.deviceId, { type: 'force_upload' })
  check('type filter returns only requested type', typeFiltered.commands.length >= 1 && typeFiltered.commands.every((c) => c.type === 'force_upload' && c.id === f1.commandId))

  // Stale delivered → redelivered at-least-once with rotated receipt.
  run('UPDATE AgentCommand SET deliveredAt = ? WHERE id = ?', Date.now() - 31_000, d1.commandId)
  const staleDeliver = await fleetQueue.deliverCommandsForDevice(PAG.deviceId)
  const redeliveredD1 = staleDeliver.commands.find((c) => c.id === d1.commandId)
  check('stale delivered command redelivered', !!redeliveredD1)
  check('redelivery rotates the receipt', redeliveredD1?.ackToken && redeliveredD1.ackToken !== oldTokenD1)
  const redeliveredAudit = qa("SELECT detail FROM AuditLog WHERE action = 'fleet_command_delivered' AND entityId = ? ORDER BY createdAt DESC LIMIT 1", d1.commandId)
  check('audit flags redelivered:true', (redeliveredAudit[0]?.detail || '').includes('"redelivered":true'))
  const oldReceipt = await fleetQueue.reportCommandStatus({ commandId: d1.commandId, status: 'acknowledged', ackToken: oldTokenD1, deviceId: PAG.deviceId })
  check('stale receipt rejected after rotation', oldReceipt.ok === false && oldReceipt.code === 'bad_ack_token', JSON.stringify(oldReceipt))

  // Worker sweep: delivered untouched too long → queued (device offline).
  run('UPDATE AgentCommand SET deliveredAt = ? WHERE id = ?', Date.now() - 11 * 60_000, d1.commandId)
  const requeuedCount = await fleetQueue.requeueStaleDeliveredCommands()
  check('requeue sweep returns ≥1', requeuedCount >= 1, 'count=' + requeuedCount)
  const sweptD1 = q('SELECT status, deliveryToken, deliveredAt FROM AgentCommand WHERE id = ?', d1.commandId)
  check('sweep → queued + token cleared', sweptD1?.status === 'queued' && sweptD1?.deliveryToken === null && sweptD1?.deliveredAt === null)
  check('audit fleet_command_requeued', allActionsLazy().includes('fleet_command_requeued'))

  // ── 10. Summary truncation (cap enforced server-side) ───────────────────────
  section('Result summary truncation (stdout 8192 / stderr 8192 / error 4096)')

  const tCmd = await fleetQueue.enqueueCommand({ deviceId: PAG.deviceId, type: 'sync_now', dedupKey: 'trunc-1', requestedBy: 'verify' })
  const tDeliver = await fleetQueue.deliverCommandsForDevice(PAG.deviceId, { limit: 50 })
  const tDelivered = tDeliver.commands.find((c) => c.id === tCmd.commandId)
  await fleetQueue.reportCommandStatus({
    commandId: tCmd.commandId,
    status: 'completed',
    ackToken: tDelivered.ackToken,
    stdoutSummary: 'x'.repeat(9000),
    stderrSummary: 'y'.repeat(9000),
    error: 'z'.repeat(5000),
    deviceId: PAG.deviceId,
  })
  const tRow = q('SELECT stdoutSummary, stderrSummary FROM AgentCommand WHERE id = ?', tCmd.commandId)
  check('stdoutSummary capped at 8192', tRow?.stdoutSummary?.length === 8192, 'len=' + tRow?.stdoutSummary?.length)
  check('stderrSummary capped at 8192', tRow?.stderrSummary?.length === 8192, 'len=' + tRow?.stderrSummary?.length)

  // ── 11. Stage-2 rate limits (fresh device, full buckets) ────────────────────
  section('Stage-2 rate-limit rules (fresh device)')

  const r1 = await signedGet({ token: RATE.token, deviceId: RATE.deviceId, path: '/api/agent/v1/commands', nonce: NONCE() })
  const r2 = await signedGet({ token: RATE.token, deviceId: RATE.deviceId, path: '/api/agent/v1/commands', nonce: NONCE() })
  const r3 = await signedGet({ token: RATE.token, deviceId: RATE.deviceId, path: '/api/agent/v1/commands', nonce: NONCE() })
  check('commands rule: burst 2 allowed', r1.status === 200 && r2.status === 200, `r1=${r1.status} r2=${r2.status}`)
  check('commands rule: 3rd request → 429', r3.status === 429, 'status=' + r3.status)
  check('429 carries Retry-After', !!r3.headers.get('retry-after'))
  check('429 envelope AGENT_RATE_LIMITED', r3.json?.error?.code === 'AGENT_RATE_LIMITED')

  const pR = []
  for (let i = 0; i < 3; i++) pR.push(await signedGet({ token: RATE.token, deviceId: RATE.deviceId, path: '/api/agent/v1/policy', nonce: NONCE() }))
  check('policy rule: burst 2 allowed, 3rd → 429', pR[0].status === 200 && pR[1].status === 200 && pR[2].status === 429, pR.map((r) => r.status).join(','))

  const cR = []
  for (let i = 0; i < 3; i++) cR.push(await signedGet({ token: RATE.token, deviceId: RATE.deviceId, path: '/api/agent/v1/config', nonce: NONCE() }))
  check('config rule: burst 2 allowed, 3rd → 429', cR[0].status === 200 && cR[1].status === 200 && cR[2].status === 429, cR.map((r) => r.status).join(','))

  const uR = []
  for (let i = 0; i < 3; i++) uR.push(await signedGet({ token: RATE.token, deviceId: RATE.deviceId, path: '/api/agent/v1/update', nonce: NONCE() }))
  check('update rule: burst 2 allowed, 3rd → 429', uR[0].status === 200 && uR[1].status === 200 && uR[2].status === 429, uR.map((r) => r.status).join(','))

  // Burst 20: fire all 22 concurrently so refill (~200ms) can't muddy the count.
  const resNonces = Array.from({ length: 22 }, () => NONCE())
  const resResults = await Promise.all(
    resNonces.map((nonce, i) =>
      signedPost({ token: RATE.token, deviceId: RATE.deviceId, path: '/api/agent/v1/commands/result', body: { commandId: 'rate-x-' + i, status: 'completed' }, nonce })
    )
  )
  check(
    'commandResult rule: burst 20 allowed (422 not_found), 2 → 429',
    resResults.filter((r) => r.status === 429).length === 2 && resResults.filter((r) => r.status === 422).length === 20,
    resResults.map((r) => r.status).join(',')
  )

  // ── 12. Admin command DTO surfaces Stage-2 lifecycle fields ─────────────────
  section('Admin command DTO — Stage-2 lifecycle fields')

  const history = await apiReq(ADMIN_TOKEN, 'GET', `/api/admin/agents/${MAIN.deviceId}/commands?limit=100`)
  check('GET commands history → 200', history.status === 200, 'status=' + history.status)
  const dtoA = (history.json?.commands || []).find((c) => c.id === cA.commandId)
  check('DTO exposes deliveredAt/acknowledgedAt/completedAt', !!dtoA?.deliveredAt && !!dtoA?.acknowledgedAt && !!dtoA?.completedAt)
  check('DTO exposes server executionMs', typeof dtoA?.executionMs === 'number' && dtoA.executionMs >= 0)
  check('DTO exposes stdoutSummary + exitCode', dtoA?.stdoutSummary === 'captured 1234 bytes' && dtoA?.exitCode === 0)
  check('DTO exposes metadata (advisory client executionMs)', !!dtoA?.metadata && typeof dtoA.metadata === 'object')
  const dtoE = (history.json?.commands || []).find((c) => c.id === cE.commandId)
  check('DTO exposes notBefore on retried command', !!dtoE?.notBefore && dtoE.retryCount === 1)

  // ── 13. Audit trail ─────────────────────────────────────────────────────────
  section('Audit trail (Stage-2 actions)')

  const allAudit = qa('SELECT DISTINCT action FROM AuditLog ORDER BY createdAt DESC LIMIT 2000').map((r) => r.action)
  const stage2Actions = [
    'fleet_command_delivered',
    'fleet_command_acknowledged',
    'fleet_command_started',
    'fleet_command_completed',
    'fleet_command_cancelled',
    'fleet_command_retried',
    'fleet_command_failed',
    'fleet_command_requeued',
    'fleet_policy_delivered',
    'fleet_config_delivered',
    'fleet_update_manifest_delivered',
    'fleet_release_created',
  ]
  for (const action of stage2Actions) check(`audit: ${action}`, allAudit.includes(action))

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(76))
  console.log(`M009 Stage-2 Verification: ${passed} passed, ${failed} failed`)
  if (failures.length > 0) {
    console.log('\nFailed checks:')
    for (const f of failures) console.log('  - ' + f)
    process.exitCode = 1
  } else {
    console.log('All checks passed.')
  }
} finally {
  // ── Cleanup (keep demo data intact) ─────────────────────────────────────────
  console.log('\n--- Cleanup ---')
  for (const deviceId of createdDevices) {
    db.query('DELETE FROM AgentCommand WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM AgentUpdate WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM DeviceAssignment WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM AgentPolicy WHERE scope = ? AND scopeId = ?').run('device', deviceId)
    db.query('DELETE FROM ActivityEvent WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM AgentCredential WHERE deviceId = ?').run(deviceId)
    db.query('DELETE FROM Device WHERE id = ?').run(deviceId)
  }
  for (const userId of createdUsers) {
    db.query('UPDATE User SET deviceId = NULL WHERE id = ?').run(userId)
    db.query('DELETE FROM User WHERE id = ?').run(userId)
  }
  db.query("DELETE FROM AgentRelease WHERE version IN ('99.99.99-stage2', '9.9.9', '2.0.0')").run()
  console.log('cleanup complete')
}
