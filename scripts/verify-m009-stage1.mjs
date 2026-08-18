/**
 * M009 Stage-1 — Agent Fleet Management & Enterprise Control Plane — Verification
 *
 * Verifies: fleet APIs · command queue (dedup/retry/timeout/priority/FIFO/
 * expiration/result persistence) · policy precedence · version management ·
 * fleet health · bulk operations · RBAC (Employee blocked) · audit trail ·
 * cross-org isolation · agent command plane · queue recovery.
 *
 * Run against a dev server:
 *   npx next dev -p 3100   (FLEET_WORKER_ENABLED=true default)
 *   BASE_URL=http://localhost:3100 bun scripts/verify-m009-stage1.mjs
 *
 * Env: BASE_URL (default http://localhost:3100) · DB_PATH (default db/custom.db)
 *      SUPER_ADMIN_EMAIL · SUPER_ADMIN_PASSWORD (auto-loaded from .env by bun)
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

// Deterministic queue control — import fleet functions directly (like verify-e16
// imports the signature module). These give exact state-machine coverage that a
// live worker's timing could otherwise flake.
const fleetQueue = await import('../src/lib/fleet/queue')
const fleetBulk = await import('../src/lib/fleet/bulk')
const fleetPolicy = await import('../src/lib/fleet/policy')
const fleetPolicyApply = await import('../src/lib/fleet/policy-apply')
const fleetVersions = await import('../src/lib/fleet/versions')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Helpers to create test users + a registered/activated agent ─────────────
function createTestUser(name, role = 'Employee', orgId = null) {
  const id = `m9u_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  db.query('INSERT INTO User (id, name, email, role, status, organizationId, updatedAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    name,
    `m9-${name.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}@test.local`,
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
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.81' },
    body: JSON.stringify({
      installationId: INSTALLATION_ID,
      joinKey: JOIN_KEY,
      clientTime: Date.now(),
      hostname: `VERIFY-M009-${hostnameSuffix}-${serial}`,
      os: { family: 'Windows', version: '11', build: '22631', arch: 'x64' },
      hardware: { cpu: 'Intel i7-13700K', ramGB: 32, diskGB: 512, mac: 'AA:BB:CC:DD:EE:F9', serial: `SN-M009-${serial}` },
      agentVersion: '1.0.3',
      capabilities: ['activity', 'health', 'commands'],
    }),
  })
  const json = await reg.json().catch(() => ({}))
  return { status: reg.status, deviceId: json.deviceId, token: json.agentToken }
}

const signedRequest = async ({ token, deviceId, path, body, nonce, ts = Date.now() }) => {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body)
  const signature = signAgentRequest({ key: token, method: 'POST', path, timestamp: ts, nonce, body: bodyStr })
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-installation-id': INSTALLATION_ID,
      'x-device-id': deviceId,
      'x-agent-version': '1.0.3',
      'x-timestamp': String(ts),
      'x-nonce': nonce,
      'x-agent-signature': signature,
      'content-type': 'application/json',
    },
    body: bodyStr,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, headers: res.headers }
}

async function activateAgent(token, deviceId, userId) {
  db.query('UPDATE User SET deviceId = ? WHERE id = ?').run(deviceId, userId)
  return signedRequest({ token, deviceId, path: '/api/agent/v1/activate', body: { clientTime: Date.now() }, nonce: NONCE() })
}

// ── Setup ─────────────────────────────────────────────────────────────────────
console.log('\nM009 Stage-1 Fleet Verification — ' + BASE)

const loginRes = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)
check('admin login succeeds', loginRes.status === 200, 'status=' + loginRes.status)
ADMIN_TOKEN = loginRes.token || ''
SESSION_COOKIE = loginRes.cookie || ''

// Fresh test device (E1 register → assign → E2 activate).
const reg = await registerDevice('A')
check('E1 register test device → 201', reg.status === 201, 'status=' + reg.status)
const testUserId = createTestUser('M009 Fleet User', 'Employee')
const act = await activateAgent(reg.token, reg.deviceId, testUserId)
check('E2 activate test device → 200', act.status === 200, 'status=' + act.status)
const TEST_DEVICE = reg.deviceId
const TEST_TOKEN = reg.token

// A second device (for cross-device isolation checks).
const reg2 = await registerDevice('B')
const testUserId2 = createTestUser('M009 Second User', 'Employee')
const act2 = await activateAgent(reg2.token, reg2.deviceId, testUserId2)
const DEVICE2 = reg2.deviceId

const createdDevices = [TEST_DEVICE, DEVICE2]
const createdUsers = [testUserId, testUserId2]

try {
  // ── 1. Fleet Management APIs ────────────────────────────────────────────────
  section('Fleet Management APIs')

  const listRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/agents?limit=100')
  check('GET /api/admin/agents → 200', listRes.status === 200, 'status=' + listRes.status)
  check('list returns agents array', Array.isArray(listRes.json?.agents))
  check('list returns total', typeof listRes.json?.total === 'number')
  check('list returns pagination', typeof listRes.json?.page === 'number' && typeof listRes.json?.pages === 'number')
  check('list agent has hostname', !!listRes.json?.agents?.[0]?.hostname)
  check('list agent has versionState', !!listRes.json?.agents?.[0]?.versionState)

  const findDevice = listRes.json?.agents?.find((a) => a.id === TEST_DEVICE)
  check('test device appears in fleet list', !!findDevice, JSON.stringify(listRes.json?.agents?.slice(0, 2)))

  // Filtering
  const onlineRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/agents?status=Online')
  check('filter by status=Online', Array.isArray(onlineRes.json?.agents) && onlineRes.json.agents.every((a) => a.status === 'Online'))
  const searchRes = await apiReq(ADMIN_TOKEN, 'GET', `/api/admin/agents?search=${encodeURIComponent('VERIFY-M009')}`)
  check('search finds test devices', Array.isArray(searchRes.json?.agents) && searchRes.json.agents.some((a) => a.hostname.startsWith('VERIFY-M009')))

  // Detail
  const detailRes = await apiReq(ADMIN_TOKEN, 'GET', `/api/admin/agents/${TEST_DEVICE}`)
  check('GET /api/admin/agents/{id} → 200', detailRes.status === 200, 'status=' + detailRes.status)
  const det = detailRes.json || {}
  check('details: device block', !!det.device?.id && det.device.id === TEST_DEVICE)
  check('details: installation block', typeof det.installation === 'object')
  check('details: assignment block', typeof det.assignment === 'object')
  check('details: heartbeat block', typeof det.heartbeat === 'object')
  check('details: health block', typeof det.health === 'object')
  check('details: latestScreenshot block', typeof det.latestScreenshot === 'object')
  check('details: policy block', typeof det.policy === 'object')
  check('details: version block', typeof det.version === 'object')
  check('details: alerts array', Array.isArray(det.alerts))
  check('details: analytics block', typeof det.analytics === 'object')
  check('details: storage block', typeof det.storage === 'object')
  check('details: activity block', typeof det.activity === 'object')
  check('details: aiSummary block', typeof det.aiSummary === 'object' || det.aiSummary === null)
  check('details: updateStatus block', typeof det.updateStatus === 'object')
  check('details: lastCommands array', Array.isArray(det.lastCommands))
  check('details: lastErrors array', Array.isArray(det.lastErrors))

  // PATCH
  const patchRes = await apiReq(ADMIN_TOKEN, 'PATCH', `/api/admin/agents/${TEST_DEVICE}`, { body: { location: 'HQ - Fleet Lab' } })
  check('PATCH agent → 200', patchRes.status === 200, 'status=' + patchRes.status)
  check('PATCH persists location', patchRes.json?.location === 'HQ - Fleet Lab')
  const patchBad = await apiReq(ADMIN_TOKEN, 'PATCH', `/api/admin/agents/${TEST_DEVICE}`, { body: {} })
  check('PATCH with no fields → 400', patchBad.status === 400)

  // 404
  const missingRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/agents/does-not-exist')
  check('GET unknown agent → 404', missingRes.status === 404)

  // ── 2. Command Queue — dedup / FIFO / priority / result persistence ────────
  section('Command Queue — dedup / priority / FIFO / result persistence')

  // Dedup: identical commands collapse.
  const c1 = await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'clear_cache', requestedBy: 'verify' })
  const c2 = await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'clear_cache', requestedBy: 'verify' })
  check('dedup: identical enqueue returns existing command', c2.duplicated === true && c2.commandId === c1.commandId)
  check('dedup: no duplicate rows', q('SELECT COUNT(*) c FROM AgentCommand WHERE id = ?', c1.commandId).c === 1)

  // Distinct params → distinct commands.
  const c3 = await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'clear_cache', params: { scope: 'admin' }, requestedBy: 'verify' })
  check('different params → separate command', c3.commandId !== c1.commandId)

  // Priority FIFO claim order (distinct dedupKeys so dedup doesn't collapse them).
  await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'sync_now', dedupKey: 'prio-1', priority: 1, requestedBy: 'verify' })
  await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'sync_now', dedupKey: 'prio-2', priority: 5, requestedBy: 'verify' })
  await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'sync_now', dedupKey: 'prio-3', priority: 5, requestedBy: 'verify' })
  const claimed = await fleetQueue.claimCommandsForDevice(TEST_DEVICE, 10)
  check('FIFO claim order: priority desc then queuedAt asc', claimed.length >= 3 && claimed[0].priority === 5 && claimed[1].priority === 5 && claimed[2].priority === 1,
    'got: ' + claimed.map((c) => c.priority).join(','))

  // Complete with result persistence.
  const completeOk = await fleetQueue.completeCommand(claimed[0].id, { captured: true, count: 42 }, 'verify')
  check('completeCommand → true', completeOk === true)
  const completedRow = q('SELECT status, result FROM AgentCommand WHERE id = ?', claimed[0].id)
  check('completed row persisted with result JSON', completedRow?.status === 'completed' && (completedRow.result || '').includes('42'))

  // ── 3. Command Queue — retry / timeout / cancellation / expiration ──────────
  section('Command Queue — retry / timeout / cancel / expiration')

  // Failure with retries left → requeued.
  const fr = await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'restart_agent', maxRetries: 2, requestedBy: 'verify' })
  const fc = await fleetQueue.claimCommandsForDevice(TEST_DEVICE, 10)
  const failCmd = fc.find((c) => c.id === fr.commandId)
  const failOutcome = await fleetQueue.failCommand(failCmd.id, 'simulated failure', 'verify')
  check('fail with retries left → requeued', failOutcome === 'requeued')
  const retriedRow = q('SELECT status, retryCount FROM AgentCommand WHERE id = ?', fr.commandId)
  check('requeued row is queued with retryCount=1', retriedRow?.status === 'queued' && retriedRow?.retryCount === 1)

  // Exhaust retries → failed.
  await fleetQueue.failCommand(fr.commandId, 'fail again', 'verify')
  await fleetQueue.failCommand(fr.commandId, 'fail third time', 'verify')
  const failedRow = q('SELECT status, retryCount, error FROM AgentCommand WHERE id = ?', fr.commandId)
  check('maxRetries exhausted → failed', failedRow?.status === 'failed' && failedRow?.retryCount >= 2)

  // Timeout sweep: mark a running command past deadline → timeout (maxRetries=0 → immediate failed).
  // NOTE: raw-SQL timestamps must be epoch ms (numbers) — Prisma stores SQLite
  // DATETIME as INTEGER; an ISO string would never satisfy the `lt` comparison.
  const tCmd = await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'sync_now', dedupKey: 'timeout-1', maxRetries: 0, requestedBy: 'verify' })
  await db.query('UPDATE AgentCommand SET status = ?, timeoutAt = ?, startedAt = ? WHERE id = ?').run(
    'running', Date.now() - 1000, Date.now() - 5000, tCmd.commandId
  )
  const timedOut = await fleetQueue.timeoutStaleCommands()
  check('timeoutStaleCommands transitions stale running', timedOut >= 1)
  const tRow = q('SELECT status, error FROM AgentCommand WHERE id = ?', tCmd.commandId)
  check('timeout → failed (maxRetries=0)', tRow?.status === 'failed' && (tRow?.error || '').includes('timeout'), 'status=' + tRow?.status)

  // Cancellation.
  const cn = await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'force_upload', requestedBy: 'verify' })
  const cancelled = await fleetQueue.cancelCommand(cn.commandId, 'verify', 'test cancel')
  check('cancelCommand → true', cancelled === true)
  check('cancelled row persisted', q('SELECT status FROM AgentCommand WHERE id = ?', cn.commandId)?.status === 'cancelled')
  const cancelTwice = await fleetQueue.cancelCommand(cn.commandId, 'verify')
  check('cancel terminal command → false', cancelTwice === false)

  // Expiration sweep (distinct dedupKey so it stays queued until expiry).
  const ex = await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'sync_now', dedupKey: 'expire-1', expiresAt: new Date(Date.now() - 5000), requestedBy: 'verify' })
  const expiredCount = await fleetQueue.expireQueuedCommands()
  check('expireQueuedCommands expires past-deadline queued', expiredCount >= 1)
  check('expired row cancelled', q('SELECT status FROM AgentCommand WHERE id = ?', ex.commandId)?.status === 'cancelled')

  // Queue recovery after "restart": stale running commands reset via timeout sweep (covered above).

  // ── 4. Command execution (server-side) + agent claim plane ──────────────────
  section('Command execution — server-side + agent claim plane')

  // Server-side clear_cache executes + completes with persisted result.
  const sCmd = await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'clear_cache', requestedBy: 'verify' })
  const { executeServerCommand } = await import('../src/lib/fleet/executor')
  const execRes = await executeServerCommand(sCmd.commandId)
  check('server-executable command executes ok', execRes.ok === true)
  const sRow = q('SELECT status, result FROM AgentCommand WHERE id = ?', sCmd.commandId)
  check('server command completed with result', sRow?.status === 'completed' && sRow?.result?.includes('cleared'))

  // Agent claim plane: enqueue a non-server command → agent claims → completes.
  const aCmd = await fleetQueue.enqueueCommand({ deviceId: TEST_DEVICE, type: 'capture_screenshot', requestedBy: 'verify' })
  const claimRes = await signedRequest({ token: TEST_TOKEN, deviceId: TEST_DEVICE, path: '/api/agent/v1/commands', body: { clientTime: Date.now() }, nonce: NONCE() })
  check('agent claim endpoint → 200', claimRes.status === 200, 'status=' + claimRes.status)
  const claimedByAgent = (claimRes.json?.commands || []).find((c) => c.id === aCmd.commandId)
  check('agent claim returns the command', !!claimedByAgent)
  check('agent claim marks it running', q('SELECT status FROM AgentCommand WHERE id = ?', aCmd.commandId)?.status === 'running')

  const completeRes = await signedRequest({
    token: TEST_TOKEN,
    deviceId: TEST_DEVICE,
    path: `/api/agent/v1/commands/${aCmd.commandId}/complete`,
    body: { ok: true, result: { success: true, screenshotId: 'shot-1' } },
    nonce: NONCE(),
  })
  check('agent complete endpoint → 200', completeRes.status === 200, 'status=' + completeRes.status)
  const aRow = q('SELECT status, result FROM AgentCommand WHERE id = ?', aCmd.commandId)
  check('agent-completed command persisted with result', aRow?.status === 'completed' && (aRow.result || '').includes('screenshotId'))

  // Command history endpoint.
  const historyRes = await apiReq(ADMIN_TOKEN, 'GET', `/api/admin/agents/${TEST_DEVICE}/commands`)
  check('GET commands history → 200', historyRes.status === 200, 'status=' + historyRes.status)
  check('history is array', Array.isArray(historyRes.json?.commands))

  // Admin enqueue via API.
  const enqueueApi = await apiReq(ADMIN_TOKEN, 'POST', `/api/admin/agents/${TEST_DEVICE}/commands`, { body: { type: 'collect_health' } })
  check('POST enqueue command → 202', enqueueApi.status === 202, 'status=' + enqueueApi.status)
  check('enqueue returns commandId', !!enqueueApi.json?.commandId)
  const enqueueDup = await apiReq(ADMIN_TOKEN, 'POST', `/api/admin/agents/${TEST_DEVICE}/commands`, { body: { type: 'collect_health' } })
  check('API dedup returns duplicate flag', enqueueDup.json?.duplicated === true || enqueueDup.json?.status === 'duplicate')

  // Cancel via API.
  const cancelApi = await apiReq(ADMIN_TOKEN, 'POST', `/api/admin/agents/${TEST_DEVICE}/commands/${aCmd.commandId}`)
  // command already completed → returns cancelled:false (terminal state)
  check('cancel terminal command via API → not cancelled', cancelApi.json?.cancelled === false)

  // ── 5. Policy management + precedence ───────────────────────────────────────
  section('Policy Management — precedence device > user > dept > org > global')

  // Create policies at each scope.
  // Give the test user an org + department and the device an org so all five
  // policy scopes (device>user>dept>org>global) are resolvable.
  const mgrOrgId0 = q('SELECT id FROM Organization LIMIT 1').id
  db.query('UPDATE User SET organizationId = ?, department = ? WHERE id = ?').run(mgrOrgId0, 'Engineering', testUserId)
  db.query('UPDATE Device SET organizationId = ? WHERE id = ?').run(mgrOrgId0, TEST_DEVICE)
  const orgId = q('SELECT organizationId FROM Device WHERE id = ?', TEST_DEVICE)?.organizationId
  const userId = q('SELECT userId FROM DeviceAssignment WHERE deviceId = ? AND revokedAt IS NULL', TEST_DEVICE)?.userId
  const user = q('SELECT department FROM User WHERE id = ?', userId)
  const dept = user?.department || 'Engineering'

  const createdPolicyIds = []
  const createdBulkIds = []
  const trackPolicy = (p) => { createdPolicyIds.push(p.id); return p }
  const trackBulk = (id) => { if (id) createdBulkIds.push(id); return id }

  const globalP = trackPolicy(await fleetPolicy.upsertPolicy({ name: 'global-policy', scope: 'global', scopeId: null, config: { source: 'global', captureInterval: 30, screenshotEnabled: false } }))
  const orgP = trackPolicy(await fleetPolicy.upsertPolicy({ name: 'org-policy', scope: 'organization', scopeId: orgId, config: { source: 'org', captureInterval: 20 } }))
  const deptP = trackPolicy(await fleetPolicy.upsertPolicy({ name: 'dept-policy', scope: 'department', scopeId: dept, config: { source: 'dept', captureInterval: 15 } }))
  const userP = trackPolicy(await fleetPolicy.upsertPolicy({ name: 'user-policy', scope: 'user', scopeId: userId, config: { source: 'user', screenshotEnabled: true } }))
  const deviceP = trackPolicy(await fleetPolicy.upsertPolicy({ name: 'device-policy', scope: 'device', scopeId: TEST_DEVICE, config: { source: 'device', captureInterval: 5 } }))

  const resolved = await fleetPolicy.resolveEffectivePolicy(TEST_DEVICE)
  check('device scope wins precedence', resolved.source?.scope === 'device', 'source=' + resolved.source?.scope)
  check('device config merged over lower scopes', resolved.policy.captureInterval === 5 && resolved.policy.screenshotEnabled === true, JSON.stringify(resolved.policy))

  // Remove device policy → user wins.
  await db.query('UPDATE AgentPolicy SET enabled = 0 WHERE id = ?').run(deviceP.id)
  const resolvedUser = await fleetPolicy.resolveEffectivePolicy(TEST_DEVICE)
  check('user scope wins after device removed', resolvedUser.source?.scope === 'user', 'source=' + resolvedUser.source?.scope)

  // Remove user policy → department wins.
  await db.query('UPDATE AgentPolicy SET enabled = 0 WHERE id = ?').run(userP.id)
  const resolvedDept = await fleetPolicy.resolveEffectivePolicy(TEST_DEVICE)
  check('department scope wins after user removed', resolvedDept.source?.scope === 'department', 'source=' + resolvedDept.source?.scope)

  // Remove department → org wins.
  await db.query('UPDATE AgentPolicy SET enabled = 0 WHERE id = ?').run(deptP.id)
  const resolvedOrg = await fleetPolicy.resolveEffectivePolicy(TEST_DEVICE)
  check('organization scope wins after dept removed', resolvedOrg.source?.scope === 'organization', 'source=' + resolvedOrg.source?.scope)

  // Remove org → global wins.
  await db.query('UPDATE AgentPolicy SET enabled = 0 WHERE id = ?').run(orgP.id)
  const resolvedGlobal = await fleetPolicy.resolveEffectivePolicy(TEST_DEVICE)
  check('global scope wins after org removed', resolvedGlobal.source?.scope === 'global', 'source=' + resolvedGlobal.source?.scope)

  // Persist effective policy onto device.
  await fleetPolicy.persistEffectivePolicy(TEST_DEVICE, 'verify')
  const devPolicy = q('SELECT effectivePolicy, effectivePolicyVersion FROM Device WHERE id = ?', TEST_DEVICE)
  check('effective policy persisted on Device', !!devPolicy?.effectivePolicy && devPolicy.effectivePolicyVersion >= 1)

  // API: GET effective policy.
  const policyApi = await apiReq(ADMIN_TOKEN, 'GET', `/api/admin/agents/${TEST_DEVICE}/policy`)
  check('GET device policy → 200', policyApi.status === 200, 'status=' + policyApi.status)
  check('GET device policy has chain', Array.isArray(policyApi.json?.chain))

  // API: list policies.
  const policiesApi = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/agents/policies')
  check('GET policies list → 200', policiesApi.status === 200)
  check('policies list has global policy', policiesApi.json?.policies?.some((p) => p.scope === 'global'))

  // API: create policy.
  const createPolicyApi = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/agents/policies', {
    body: { name: 'api-created', scope: 'global', config: { source: 'api' } },
  })
  check('POST policies → 201|200 (upsert of existing global)', createPolicyApi.status === 201 || createPolicyApi.status === 200, 'status=' + createPolicyApi.status)

  // API: assign policy to device via policyId.
  const assignApi = await apiReq(ADMIN_TOKEN, 'POST', `/api/admin/agents/${TEST_DEVICE}/policy`, { body: { policyId: globalP.id } })
  check('POST assign policy to device → 200', assignApi.status === 200, 'status=' + assignApi.status + ' ' + JSON.stringify(assignApi.json?.error || ''))

  // ── 6. Version management ───────────────────────────────────────────────────
  section('Version Management')

  const releaseRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/agents/versions', { body: { version: '2.0.0', notes: 'fleet release' } })
  check('POST create release → 200', releaseRes.status === 200, 'status=' + releaseRes.status)

  // Device at 1.0.3 → update available (latest 2.0.0).
  const vs = await fleetVersions.versionStateForDevice(TEST_DEVICE)
  check('update available detected', vs.latest === '2.0.0' && vs.updateAvailable === true)

  // Required release → update_required.
  await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/agents/versions', { body: { version: '2.0.0', required: true } })
  const vsReq = await fleetVersions.versionStateForDevice(TEST_DEVICE)
  check('required update detected', vsReq.updateRequired === true && vsReq.status === 'update_required')

  // Update history.
  await fleetVersions.recordUpdate({ deviceId: TEST_DEVICE, fromVersion: '1.0.3', toVersion: '2.0.0', status: 'completed' })
  const updates = await fleetVersions.listUpdatesForDevice(TEST_DEVICE)
  check('update history recorded', updates.length >= 1 && updates[0].status === 'completed')

  // API: version management overview.
  const versionsApi = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/agents/versions')
  check('GET versions → 200', versionsApi.status === 200, 'status=' + versionsApi.status)
  check('versions latest = 2.0.0', versionsApi.json?.latest === '2.0.0')
  check('versions has fleet byStatus', typeof versionsApi.json?.fleet?.byStatus === 'object')

  // ── 7. Fleet health dashboard ───────────────────────────────────────────────
  section('Fleet Health Dashboard')

  const healthRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/agents/health')
  check('GET fleet health → 200', healthRes.status === 200, 'status=' + healthRes.status)
  const summary = healthRes.json?.summary || {}
  check('health: total present', typeof summary.total === 'number')
  check('health: online present', typeof summary.online === 'number')
  check('health: offline present', typeof summary.offline === 'number')
  check('health: byStatus array', Array.isArray(summary.byStatus))
  check('health: byHealth array', Array.isArray(summary.byHealth))
  check('health: total equals online+offline', summary.online + summary.offline === summary.total)

  const healthDetail = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/agents/health?detail=true')
  check('health detail includes devices', Array.isArray(healthDetail.json?.devices))

  // ── 8. Bulk operations ──────────────────────────────────────────────────────
  section('Bulk Operations (async)')

  const bulkRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/agents/bulk', {
    body: { operation: 'collect_health', targetFilter: { deviceIds: [TEST_DEVICE, DEVICE2] } },
  })
  check('POST bulk collect_health → 202', bulkRes.status === 202, 'status=' + bulkRes.status)
  const bulkId = trackBulk(bulkRes.json?.operationId)
  check('bulk returns operationId + total=2', !!bulkId && bulkRes.json?.total === 2)

  // Execute synchronously (deterministic — the worker does the same thing).
  const bulkResult = await fleetBulk.processBulkOperation(bulkId)
  check('bulk processed (completed|partial)', bulkResult?.status === 'completed' || bulkResult?.status === 'partial', 'status=' + bulkResult?.status)
  check('bulk succeeded=2', bulkResult?.succeeded === 2, 'succeeded=' + bulkResult?.succeeded)
  const bulkDb = q('SELECT status, succeeded FROM AgentBulkOperation WHERE id = ?', bulkId)
  check('bulk row persisted as completed', bulkDb?.status === 'completed' && bulkDb?.succeeded === 2)

  const bulkGet = await apiReq(ADMIN_TOKEN, 'GET', `/api/admin/agents/bulk/${bulkId}`)
  check('GET bulk operation → 200', bulkGet.status === 200, 'status=' + bulkGet.status)
  check('bulk detail has per-device results', !!bulkGet.json?.results)

  const bulkList = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/agents/bulk')
  check('GET bulk list → 200', bulkList.status === 200)
  check('bulk list is array', Array.isArray(bulkList.json?.operations))

  // Bulk assign_policy.
  const bulkPolicy = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/agents/bulk', {
    body: { operation: 'assign_policy', targetFilter: { deviceIds: [TEST_DEVICE] }, params: { policyId: globalP.id } },
  })
  trackBulk(bulkPolicy.json?.operationId)
  const bulkPolicyResult = await fleetBulk.processBulkOperation(bulkPolicy.json?.operationId)
  check('bulk assign_policy succeeded', bulkPolicyResult?.succeeded === 1, 'succeeded=' + bulkPolicyResult?.succeeded)

  // Bulk delete (soft-retire).
  const bulkDel = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/agents/bulk', {
    body: { operation: 'delete', targetFilter: { deviceIds: [DEVICE2] } },
  })
  trackBulk(bulkDel.json?.operationId)
  const bulkDelResult = await fleetBulk.processBulkOperation(bulkDel.json?.operationId)
  check('bulk delete succeeded', bulkDelResult?.succeeded === 1, 'succeeded=' + bulkDelResult?.succeeded)
  const dev2State = q('SELECT status FROM Device WHERE id = ?', DEVICE2)
  check('bulk delete retired device', dev2State?.status === 'Retired')

  // ── 9. RBAC — Employee blocked; Manager org-scoped ──────────────────────────
  section('RBAC — employees blocked, roles ranked, org isolation')

  // Create test roles: Manager (org A), Viewer (org A), Employee (org B).
  const mgrOrgId = q('SELECT id FROM Organization LIMIT 1').id
  const otherOrgId = q('SELECT id FROM Organization LIMIT 1 OFFSET 1').id
  const managerId = createTestUser('M009 Manager', 'Manager', mgrOrgId)
  const viewerId = createTestUser('M009 Viewer', 'Viewer', mgrOrgId)
  const employeeId = createTestUser('M009 Employee', 'Employee', otherOrgId)
  createdUsers.push(managerId, viewerId, employeeId)

  // Give the manager a passwordHash so they can log in.
  const bcrypt = await import('bcryptjs')
  const pwHash = bcrypt.hashSync('M9-Test-Pass-2026', 10)
  for (const uid of [managerId, viewerId, employeeId]) {
    db.query('UPDATE User SET passwordHash = ? WHERE id = ?').run(pwHash, uid)
  }
  const emailOf = (uid) => q('SELECT email FROM User WHERE id = ?', uid).email

  const mgrLogin = await loginAs(emailOf(managerId), 'M9-Test-Pass-2026')
  check('manager login succeeds', mgrLogin.status === 200, 'status=' + mgrLogin.status)
  const mgrToken = mgrLogin.token || ''
  const mgrCookie = mgrLogin.cookie || ''

  const empLogin = await loginAs(emailOf(employeeId), 'M9-Test-Pass-2026')
  check('employee login succeeds', empLogin.status === 200, 'status=' + empLogin.status)
  const empToken = empLogin.token || ''
  const empCookie = empLogin.cookie || ''

  const viewLogin = await loginAs(emailOf(viewerId), 'M9-Test-Pass-2026')
  const viewToken = viewLogin.token || ''
  const viewCookie = viewLogin.cookie || ''

  // Employee → 403 on fleet APIs (per-role cookie — never the admin cookie).
  const empAgents = await apiReq(empToken, 'GET', '/api/admin/agents', { cookie: empCookie })
  check('Employee blocked from GET /api/admin/agents', empAgents.status === 403, 'status=' + empAgents.status)
  const empHealth = await apiReq(empToken, 'GET', '/api/admin/agents/health', { cookie: empCookie })
  check('Employee blocked from fleet health', empHealth.status === 403, 'status=' + empHealth.status)
  const empBulk = await apiReq(empToken, 'POST', '/api/admin/agents/bulk', { cookie: empCookie, body: {} })
  check('Employee blocked from bulk ops', empBulk.status === 403, 'status=' + empBulk.status)

  // Viewer → read allowed, write denied.
  const viewRead = await apiReq(viewToken, 'GET', '/api/admin/agents', { cookie: viewCookie })
  check('Viewer can read fleet', viewRead.status === 200, 'status=' + viewRead.status)
  const viewPatch = await apiReq(viewToken, 'PATCH', `/api/admin/agents/${TEST_DEVICE}`, { cookie: viewCookie, body: { location: 'hax' } })
  check('Viewer cannot PATCH device', viewPatch.status === 403, 'status=' + viewPatch.status)
  const viewCmd = await apiReq(viewToken, 'POST', `/api/admin/agents/${TEST_DEVICE}/commands`, { cookie: viewCookie, body: { type: 'sync_now' } })
  check('Viewer cannot enqueue commands', viewCmd.status === 403, 'status=' + viewCmd.status)
  const viewDel = await apiReq(viewToken, 'DELETE', `/api/admin/agents/${TEST_DEVICE}`, { cookie: viewCookie })
  check('Viewer cannot delete device', viewDel.status === 403, 'status=' + viewDel.status)

  // Manager → can read + command; cannot delete (Super Admin only).
  const mgrRead = await apiReq(mgrToken, 'GET', '/api/admin/agents', { cookie: mgrCookie })
  check('Manager can read fleet', mgrRead.status === 200, 'status=' + mgrRead.status)
  const mgrCmd = await apiReq(mgrToken, 'POST', `/api/admin/agents/${TEST_DEVICE}/commands`, { cookie: mgrCookie, body: { type: 'sync_now' } })
  check('Manager can enqueue commands', mgrCmd.status === 202 || mgrCmd.status === 200, 'status=' + mgrCmd.status)
  const mgrDel = await apiReq(mgrToken, 'DELETE', `/api/admin/agents/${TEST_DEVICE}`, { cookie: mgrCookie })
  check('Manager cannot delete device (Super Admin only)', mgrDel.status === 403, 'status=' + mgrDel.status)

  // Cross-org isolation: manager of org A cannot read org B device.
  const otherOrgDevice = q('SELECT id FROM Device WHERE organizationId = ? LIMIT 1', otherOrgId)
  const mgrOther = await apiReq(mgrToken, 'GET', `/api/admin/agents/${otherOrgDevice?.id}`, { cookie: mgrCookie })
  check('Manager blocked from other-org device (403)', mgrOther.status === 403 || mgrOther.status === 404, 'status=' + mgrOther.status)
  const mgrList = await apiReq(mgrToken, 'GET', '/api/admin/agents?limit=500', { cookie: mgrCookie })
  check('Manager list contains only own org devices', mgrList.json?.agents?.every((a) => a.organizationId === mgrOrgId))

  // ── 10. Token rotation (admin-initiated) ────────────────────────────────────
  section('Token rotation (admin-initiated, E16 mechanics)')

  const rotateRes = await apiReq(ADMIN_TOKEN, 'POST', `/api/admin/agents/${TEST_DEVICE}/token`)
  check('POST token rotate → 200', rotateRes.status === 200, 'status=' + rotateRes.status + ' ' + JSON.stringify(rotateRes.json?.error || ''))
  check('rotation returns plaintext once', typeof rotateRes.json?.token === 'string' && rotateRes.json.token.length >= 32)
  const credAfter = q('SELECT tokenHash, prevTokenHash, rotatedAt FROM AgentCredential WHERE deviceId = ? ORDER BY issuedAt DESC LIMIT 1', TEST_DEVICE)
  check('stored tokenHash = sha256(new)', credAfter?.tokenHash === sha256hex(rotateRes.json.token))
  check('prevTokenHash = sha256(old) (grace window)', credAfter?.prevTokenHash === sha256hex(TEST_TOKEN))

  // ── 11. Audit trail ─────────────────────────────────────────────────────────
  section('Audit trail (AuditLog)')

  const auditRows = qa('SELECT action FROM AuditLog ORDER BY createdAt DESC LIMIT 200')
  const actions = auditRows.map((r) => r.action)
  check('audit: command created logged', actions.includes('fleet_command_created'))
  check('audit: command cancelled logged', actions.includes('fleet_command_cancelled'))
  check('audit: command completed logged', actions.includes('fleet_command_completed'))
  check('audit: policy created/updated logged', actions.includes('fleet_policy_created') || actions.includes('fleet_policy_updated'))
  check('audit: device deleted (bulk) logged', actions.includes('fleet_device_deleted'))
  check('audit: bulk created logged', actions.includes('fleet_bulk_created'))
  check('audit: token rotation logged', actions.includes('fleet_token_rotated'))
  check('audit: release created logged', actions.includes('fleet_release_created'))

  // ── 12. No cross-org leakage in fleet data ──────────────────────────────────
  section('Isolation — no cross-org leakage')

  const orgScopeDevices = await apiReq(mgrToken, 'GET', '/api/admin/agents/health?detail=true', { cookie: mgrCookie })
  const mgrOrgs = new Set((orgScopeDevices.json?.devices || []).map((d) => d.organizationId))
  check('manager fleet health only own org', mgrOrgs.size <= 1 && (!mgrOrgs.has(otherOrgId) || mgrOrgs.size === 0))

  // ── 13. DELETE device (soft retire) + audit ────────────────────────────────
  section('DELETE device (soft-retire, Super Admin only)')

  const deleteRes = await apiReq(ADMIN_TOKEN, 'DELETE', `/api/admin/agents/${TEST_DEVICE}`)
  check('DELETE device → 200', deleteRes.status === 200, 'status=' + deleteRes.status)
  const deletedState = q('SELECT status FROM Device WHERE id = ?', TEST_DEVICE)
  check('device retired after delete', deletedState?.status === 'Retired')
  const credRevoked = q('SELECT revokedAt FROM AgentCredential WHERE deviceId = ? ORDER BY issuedAt DESC LIMIT 1', TEST_DEVICE)
  check('credential revoked on delete', credRevoked?.revokedAt !== null)

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(76))
  console.log(`M009 Stage-1 Verification: ${passed} passed, ${failed} failed`)
  if (failures.length > 0) {
    console.log('\nFailed checks:')
    for (const f of failures) console.log('  - ' + f)
    process.exit(1)
  } else {
    console.log('All checks passed.')
    process.exit(0)
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
  for (const pid of createdPolicyIds) db.query('DELETE FROM AgentPolicy WHERE id = ?').run(pid)
  for (const bid of createdBulkIds) db.query('DELETE FROM AgentBulkOperation WHERE id = ?').run(bid)
  db.query("DELETE FROM AgentRelease WHERE version IN ('2.0.0', '9.9.9')").run()
  db.query("DELETE FROM AgentPolicy WHERE name = 'api-created'").run()
  console.log('cleanup complete')
}
