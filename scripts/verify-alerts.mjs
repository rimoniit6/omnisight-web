/**
 * M008 Stage-2 — Alert Engine & Live Monitoring — Automated Verification (live server)
 *
 * Covers the complete real-time monitoring pipeline end-to-end:
 *   rules:       10 config-driven mission rules (thresholds from AlertRule
 *                 rows — never code), admin rules API (create/update/validate)
 *   evaluation:  HighCpu / LowMemory / LowDisk / HealthDegraded /
 *                 DeviceOffline / MissingHeartbeat / HighIdle /
 *                 RepeatedOcrFailures / ScreenshotUploadFailures /
 *                 AgentVersionOutdated — every alert from persisted telemetry
 *   lifecycle:   OPEN → ACKNOWLEDGED → RESOLVED + automatic reopen (audited)
 *   dedup:       duplicate suppression on re-run (no alert/notification dupes)
 *   checkpoint:  RollupCheckpoint key='alert-eval' — crash resume idempotency
 *                 + worker-gap recovery (device that went offline during a gap)
 *   queue:       NotificationQueue rows (payload/priority/status), no sending
 *   APIs:        GET /api/alerts (filters + pagination) · GET /api/alerts/:id
 *                 · POST acknowledge · POST resolve · /api/live/status ·
 *                 /api/live/devices
 *   auth:        Admin org-wide · Manager org-scoped · Employee self-only ·
 *                 cross-tenant isolation · 401s
 *   concurrency: parallel evaluate triggers share one in-flight run (no dupes)
 *   rollback:    failed transaction leaves no partial alert/event/notification;
 *                 corrupt rule config disables the rule gracefully
 *   regression:  dashboard / analytics / timeline / rollup / legacy endpoints
 *
 * Run with bun (matches repo convention) against a dev server started with
 * ALERT_WORKER_ENABLED=false (deterministic — evaluation is only triggered via
 * POST /api/admin/alerts/evaluate):
 *   ALERT_WORKER_ENABLED=false npx next dev -p 3100
 *   BASE_URL=http://localhost:3100 bun scripts/verify-alerts.mjs
 *
 * Env: BASE_URL (default http://localhost:3100) · DB_PATH (default db/custom.db)
 *      · SUPER_ADMIN_EMAIL · SUPER_ADMIN_PASSWORD (auto-loaded from .env by bun)
 */

import { randomBytes } from 'node:crypto'
import { Database } from 'bun:sqlite'
import bcrypt from 'bcryptjs'

const BASE = process.env.BASE_URL || 'http://localhost:3100'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'aria.martin@umbrella.com'
const ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || ''

let passed = 0
let failed = 0
const failures = []
function check(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  FAIL ${name} ${extra}`)
  }
}
function section(title) {
  console.log(`\n── ${title} ─${'─'.repeat(Math.max(0, 64 - title.length))}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const db = new Database(DB_PATH)
db.run('PRAGMA foreign_keys = ON')
db.run('PRAGMA busy_timeout = 10000') // wait out worker flush locks during cleanup
const q = (sql, ...args) => db.query(sql).get(...args)
const qa = (sql, ...args) => db.query(sql).all(...args)
const run = (sql, ...args) => db.query(sql).run(...args)
const cuid = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`
const alnum = (n = 12) => randomBytes(n).toString('hex')
const iso = (ts = Date.now()) => new Date(ts).toISOString()
const HASH = (p) => bcrypt.hashSync(p, 10)

const cookieOf = (res) => {
  const set = res.headers.get('set-cookie') || ''
  const m = set.match(/wl_session=[^;]+/)
  return m ? m[0] : ''
}

let SESSION_COOKIE = ''
async function apiReq(token, method, p, { headers = {}, body } = {}) {
  // Route-level auth (src/lib/auth requireAuth/requireRole) reads the session
  // cookie, not the Bearer header, so every authenticated call must carry the
  // cookie of the user it acts as. Default to the admin session cookie
  // (SESSION_COOKIE); RBAC / unauthenticated callers must pass their own
  // headers.cookie (or '' for no auth).
  const cookie = headers.cookie ?? SESSION_COOKIE
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, cookie, 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, headers: res.headers }
}

let ipCounter = 0
async function loginAs(email, password) {
  const ip = `198.51.100.${(ipCounter++ % 240) + 1}`
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, password }),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, token: json.token, cookie: cookieOf(res) }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const F = {
  orgA: null, orgB: null,
  admin: null,
  managerA: null, employeeA: null, managerB: null, employeeB: null,
  inst: null,
}
const devIds = []
const ruleIds = []
const alertIds = [] // fixture alerts (populated as they are created)
const bulkDevices = []
const bulkAlerts = []
const screenshotIds = []
const eventIds = []
const ticketIds = []

function ensureOrgs() {
  F.orgA = cuid('al2oa')
  F.orgB = cuid('al2ob')
  run('INSERT INTO Organization (id, name, slug, createdAt, updatedAt) VALUES (?,?,?,?,?)', F.orgA, `AL2 Org A ${alnum(4)}`, `al2-a-${alnum(4)}`, iso(), iso())
  run('INSERT INTO Organization (id, name, slug, createdAt, updatedAt) VALUES (?,?,?,?,?)', F.orgB, `AL2 Org B ${alnum(4)}`, `al2-b-${alnum(4)}`, iso(), iso())
}

function insUser({ id, name, email, role, orgId, deviceId = null }) {
  run(
    'INSERT INTO User (id, name, email, passwordHash, role, organizationId, deviceId, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)',
    id, name, email, HASH('fixture-pass'), role, orgId, deviceId, iso(), iso()
  )
  return id
}

function insDevice({ hostname, status = 'Online', lastSeen = iso(), lastHeartbeatAt = null, agentVersion = '1.0.3', organizationId = null, installationId = null, updatedAt = iso() }) {
  const id = cuid('al2d')
  run(
    'INSERT INTO Device (id, hostname, os, status, lastSeen, lastHeartbeatAt, agentVersion, organizationId, installationId, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, hostname, 'Windows 11', status, lastSeen, lastHeartbeatAt, agentVersion, organizationId, installationId, iso(), updatedAt
  )
  devIds.push(id)
  return id
}

function insSnapshot(deviceId, { cpuPct = null, ramPct = null, diskFreeGB = null, batteryPct = null, avEnabled = null, ts = iso() }) {
  run('INSERT INTO DeviceHealthSnapshot (id, deviceId, ts, cpuPct, ramPct, diskFreeGB, batteryPct, avEnabled, createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
    cuid('al2h'), deviceId, ts, cpuPct, ramPct, diskFreeGB, batteryPct, avEnabled, iso())
}

function insIdleEvent(deviceId, userId, { duration = 3600, ts = iso(), receivedAt = null }) {
  const id = cuid('al2e')
  run('INSERT INTO ActivityEvent (id, userId, deviceId, type, title, kind, duration, focusTime, backgroundTime, timestamp, receivedAt, source, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, userId, deviceId, 'Idle', 'idle', 'idle', duration, 0, 0, ts, receivedAt ?? ts, 'agent', iso())
  eventIds.push(id)
  return id
}

function insActivityEvent(deviceId, userId, { kind = 'app', title = 'code.exe', duration = 300, ts = iso() }) {
  const id = cuid('al2e')
  run('INSERT INTO ActivityEvent (id, userId, deviceId, type, title, kind, duration, focusTime, backgroundTime, timestamp, receivedAt, source, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, userId, deviceId, kind === 'idle' ? 'Idle' : 'App', title, kind, duration, kind === 'idle' ? 0 : duration, 0, ts, ts, 'agent', iso())
  eventIds.push(id)
  return id
}

function insFailedScreenshot(deviceId, userId, { processedAt = iso() }) {
  const id = cuid('al2s')
  run('INSERT INTO Screenshot (id, deviceId, userId, ocrStatus, ocrProcessedAt, timestamp, createdAt) VALUES (?,?,?,?,?,?,?)',
    id, deviceId, userId, 'failed', processedAt, iso(), iso())
  screenshotIds.push(id)
  return id
}

function insTicket(deviceId, { status = 'expired', updatedAt = iso() }) {
  const id = cuid('al2t')
  run('INSERT INTO UploadTicket (id, deviceId, sha256, size, chunkSize, totalChunks, status, expiresAt, capturedAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, deviceId, alnum(64), 1000, 262144, 1, status, iso(), iso(), iso(), updatedAt)
  ticketIds.push(id)
  return id
}

function insRule({ type, severity = 'Medium', config = {}, organizationId = null }) {
  const id = cuid('al2r')
  const name = type
  run('INSERT INTO AlertRule (id, type, name, description, severity, enabled, config, organizationId, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, type, name, `rule ${type}`, severity, 1, JSON.stringify(config), organizationId, iso(), iso())
  ruleIds.push(id)
  return id
}

function insAlert({ type, severity = 'Medium', status = 'Open', deviceId = null, userId = null, organizationId = null, message = 'fixture', value = null }) {
  const id = cuid('al2a')
  run('INSERT INTO Alert (id, type, severity, message, status, value, deviceId, userId, organizationId, timestamp, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    id, type, severity, message, status, value, deviceId, userId, organizationId, iso(), iso(), iso())
  alertIds.push(id)
  return id
}

// Alerts + audit events + notifications for a device (state snapshot).
const alertsFor = (deviceId) => qa('SELECT * FROM Alert WHERE deviceId=? ORDER BY timestamp ASC, createdAt ASC', deviceId)
const countAlertsFor = (deviceId, type, status) =>
  q('SELECT COUNT(*) c FROM Alert WHERE deviceId=? AND type=? AND (? IS NULL OR status=?)', deviceId, type, status ?? null, status ?? null)?.c ?? 0
const notifCount = (ids) => ids.length
  ? q(`SELECT COUNT(*) c FROM NotificationQueue WHERE alertId IN (${ids.map(() => '?').join(',')})`, ...ids)?.c ?? 0
  : 0
const openCount = () => q('SELECT COUNT(*) c FROM Alert WHERE status=\'Open\'')?.c ?? 0

async function evaluate() {
  return apiReq(F.admin.token, 'POST', '/api/admin/alerts/evaluate')
}
const evaluateOk = async (name) => {
  const r = await evaluate()
  check(name, r.status === 200 && r.json?.status === 'completed', `(got ${r.status} ${JSON.stringify(r.json)?.slice(0, 120)})`)
  return r.json
}

// ── Setup fixtures ─────────────────────────────────────────────────────────
// Remove any state a prior run / background worker left behind (mission rule
// alerts + their audit trail/notifications, all rules, the eval checkpoint).
function cleanSlate() {
  const MISSION_TYPES = ['DeviceOffline', 'MissingHeartbeat', 'HighIdle', 'HighCpu', 'LowMemory', 'LowDisk', 'RepeatedOcrFailures', 'ScreenshotUploadFailures', 'AgentVersionOutdated', 'HealthDegraded']
  const tq = MISSION_TYPES.map(() => '?').join(',')
  run(`DELETE FROM AlertEvent WHERE alertId IN (SELECT id FROM Alert WHERE type IN (${tq}))`, ...MISSION_TYPES)
  run(`DELETE FROM NotificationQueue WHERE alertId IN (SELECT id FROM Alert WHERE type IN (${tq}))`, ...MISSION_TYPES)
  run(`DELETE FROM Alert WHERE type IN (${tq})`, ...MISSION_TYPES)
  run('DELETE FROM AlertRule')
  run("DELETE FROM RollupCheckpoint WHERE key='alert-eval'")
}

async function main() {
  try {
    cleanSlate()
    // Seeded admin + fixture users.
    const login = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)
    check('setup: seeded admin login', login.status === 200 && !!login.token, `(got ${login.status})`)
    F.admin = { token: login.token, id: q('SELECT id FROM User WHERE email=?', ADMIN_EMAIL)?.id }
    SESSION_COOKIE = login.cookie

    ensureOrgs()
    F.managerA = insUser({ id: cuid('al2m'), name: 'AL2 Manager A', email: `mgr-a-${alnum(6)}@test.local`, role: 'Manager', orgId: F.orgA })
    F.managerB = insUser({ id: cuid('al2m'), name: 'AL2 Manager B', email: `mgr-b-${alnum(6)}@test.local`, role: 'Manager', orgId: F.orgB })
    F.employeeA = insUser({ id: cuid('al2e'), name: 'AL2 Employee A', email: `emp-a-${alnum(6)}@test.local`, role: 'Employee', orgId: F.orgA })
    F.employeeB = insUser({ id: cuid('al2e'), name: 'AL2 Employee B', email: `emp-b-${alnum(6)}@test.local`, role: 'Employee', orgId: F.orgB })

    const mA = await loginAs(q('SELECT email FROM User WHERE id=?', F.managerA)?.email, 'fixture-pass')
    const mB = await loginAs(q('SELECT email FROM User WHERE id=?', F.managerB)?.email, 'fixture-pass')
    const eA = await loginAs(q('SELECT email FROM User WHERE id=?', F.employeeA)?.email, 'fixture-pass')
    const eB = await loginAs(q('SELECT email FROM User WHERE id=?', F.employeeB)?.email, 'fixture-pass')
    check('setup: manager/employee logins', mA.status === 200 && !!mA.token && !!mA.cookie && mB.status === 200 && !!mB.token && !!mB.cookie && eA.status === 200 && !!eA.token && !!eA.cookie && eB.status === 200 && !!eB.token && !!eB.cookie)
    F.mgrAToken = mA.token
    F.mgrBToken = mB.token
    F.empAToken = eA.token
    F.empBToken = eB.token
    F.mgrACookie = mA.cookie
    F.mgrBCookie = mB.cookie
    F.empACookie = eA.cookie
    F.empBCookie = eB.cookie

    // Fixture installation (min agent version policy for AgentVersionOutdated).
    F.inst = cuid('al2i')
    run('INSERT INTO Installation (id, name, joinKeyHash, minAgentVersion, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)',
      F.inst, 'AL2 Fixture Install', alnum(64), '1.2.0', 'Active', iso(), iso())

    // Fixture devices (orgA) + one foreign (orgB).
    const dCPU = insDevice({ hostname: 'al2-cpu', organizationId: F.orgA })
    const dMem = insDevice({ hostname: 'al2-mem', organizationId: F.orgA })
    const dDisk = insDevice({ hostname: 'al2-disk', organizationId: F.orgA })
    const dHealth = insDevice({ hostname: 'al2-health', organizationId: F.orgA })
    const dClean = insDevice({ hostname: 'al2-clean', organizationId: F.orgA })
    const dOffline = insDevice({ hostname: 'al2-offline', status: 'Offline', lastSeen: iso(Date.now() - 20 * 60000), lastHeartbeatAt: iso(Date.now() - 20 * 60000), organizationId: F.orgA })
    const dHB = insDevice({ hostname: 'al2-hb', status: 'Online', lastSeen: iso(Date.now() - 20 * 60000), lastHeartbeatAt: iso(Date.now() - 20 * 60000), organizationId: F.orgA })
    const dIdle = insDevice({ hostname: 'al2-idle', organizationId: F.orgA })
    const dOCR = insDevice({ hostname: 'al2-ocr', organizationId: F.orgA })
    const dUp = insDevice({ hostname: 'al2-up', organizationId: F.orgA })
    const dVer = insDevice({ hostname: 'al2-ver', agentVersion: '0.9.0', organizationId: F.orgA, installationId: F.inst })
    // dGap: went offline 40 min ago AND the row was last updated 25 h ago —
    // neither the presence window nor the updatedAt watermark ever catches it
    // in steady state (only a worker-gap rollback should).
    const dForeign = insDevice({ hostname: 'al2-foreign', organizationId: F.orgB })

    // Employee A is assigned to dClean (User.deviceId cursor).
    run('UPDATE User SET deviceId=? WHERE id=?', dClean, F.employeeA)
    run('INSERT INTO DeviceAssignment (id, deviceId, userId, assignedAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?)',
      cuid('al2as'), dClean, F.employeeA, iso(), iso(), iso())

    check('setup: 13 fixture devices', devIds.length === 13, `(n=${devIds.length})`)

    // ── Rules: clear + seed via the ADMIN API (tests creation) ──────────────
    run('DELETE FROM AlertRule')
    const ruleDefs = [
      { type: 'DeviceOffline', severity: 'Medium', config: { offlineMinutes: 5, missingMinutes: 5 } },
      { type: 'MissingHeartbeat', severity: 'High', config: { offlineMinutes: 5, missingMinutes: 5 } },
      { type: 'HighIdle', severity: 'Medium', config: { idleMinutes: 30 } },
      { type: 'HighCpu', severity: 'High', config: { cpuThreshold: 80 } },
      { type: 'LowMemory', severity: 'High', config: { ramThreshold: 85 } },
      { type: 'LowDisk', severity: 'High', config: { diskFreeGBThreshold: 15 } },
      { type: 'RepeatedOcrFailures', severity: 'Medium', config: { failures: 2, windowMinutes: 30 } },
      { type: 'ScreenshotUploadFailures', severity: 'Medium', config: { failures: 2, windowMinutes: 30 } },
      { type: 'AgentVersionOutdated', severity: 'Medium', config: {} },
      { type: 'HealthDegraded', severity: 'Medium', config: { degradedScore: 2 } },
    ]
    section('1) Rule management (admin API)')
    let seededRules = 0
    for (const d of ruleDefs) {
      const r = await apiReq(F.admin.token, 'POST', '/api/admin/alerts/rules', { body: { type: d.type, severity: d.severity, config: d.config } })
      if (r.status === 201 && r.json?.rule?.id) {
        seededRules++
        ruleIds.push(r.json.rule.id)
        const defaults = r.json.rule.config
        if (d.type === 'HighCpu') check('rules: HighCpu config parsed w/ defaults', defaults.cpuThreshold === 80 && defaults.ramThreshold === 90 && defaults.diskFreeGBThreshold === 10, JSON.stringify(defaults))
        if (d.type === 'AgentVersionOutdated') check('rules: AgentVersionOutdated accepts empty config', JSON.stringify(defaults) === '{}')
      }
    }
    check('rules: all 10 rules created via API', seededRules === 10, `(n=${seededRules})`)
    const listRules = await apiReq(F.admin.token, 'GET', '/api/admin/alerts/rules')
    check('rules: GET rules 200 + 10 rows', listRules.status === 200 && Array.isArray(listRules.json?.rules) && listRules.json.rules.length === 10, `(n=${listRules.json?.rules?.length})`)
    const badType = await apiReq(F.admin.token, 'POST', '/api/admin/alerts/rules', { body: { type: 'NotARule' } })
    check('rules: invalid type → 400', badType.status === 400)
    const badCfg = await apiReq(F.admin.token, 'POST', '/api/admin/alerts/rules', { body: { type: 'HighCpu', config: { cpuThreshold: -5 } } })
    check('rules: invalid config → 400', badCfg.status === 400)
    const rules403 = await apiReq(F.mgrAToken, 'GET', '/api/admin/alerts/rules', { headers: { cookie: F.mgrACookie } })
    check('rules: manager cannot manage rules → 403', rules403.status === 403, `(got ${rules403.status})`)
    const rules401 = await apiReq('', 'GET', '/api/admin/alerts/rules', { headers: { cookie: '' } })
    check('rules: unauthenticated → 401', rules401.status === 401, `(got ${rules401.status})`)

    // PUT update — raise HighCpu severity + tighten threshold via the API.
    const cpuRule = q('SELECT id FROM AlertRule WHERE type=? AND organizationId IS NULL', 'HighCpu')
    const put = await apiReq(F.admin.token, 'PUT', `/api/admin/alerts/rules/${cpuRule.id}`, { body: { severity: 'Critical', config: { cpuThreshold: 80, ramThreshold: 85, diskFreeGBThreshold: 15 } } })
    check('rules: PUT updates severity/config', put.status === 200 && put.json?.rule?.severity === 'Critical' && put.json?.rule?.config?.cpuThreshold === 80)
    const putBad = await apiReq(F.admin.token, 'PUT', `/api/admin/alerts/rules/${cpuRule.id}`, { body: { config: { cpuThreshold: 'high' } } })
    check('rules: PUT invalid config → 400', putBad.status === 400)
    const put404 = await apiReq(F.admin.token, 'PUT', `/api/admin/alerts/rules/${cuid('nope')}`, { body: {} })
    check('rules: PUT unknown rule → 404', put404.status === 404)

    // ── 2) Health rules (HighCpu / LowMemory / LowDisk / HealthDegraded) ─────
    section('2) Health rule evaluation + lifecycle (open → auto-resolve → reopen)')
    insSnapshot(dCPU, { cpuPct: 92, ramPct: 50, diskFreeGB: 100, batteryPct: 80, avEnabled: 1 })
    insSnapshot(dMem, { cpuPct: 40, ramPct: 90, diskFreeGB: 100, batteryPct: 80, avEnabled: 1 })
    insSnapshot(dDisk, { cpuPct: 40, ramPct: 50, diskFreeGB: 10, batteryPct: 80, avEnabled: 1 })
    insSnapshot(dHealth, { cpuPct: 75, ramPct: 50, diskFreeGB: 100, batteryPct: 8, avEnabled: 0 })
    let r = await evaluateOk('eval: health cycle completes')
    check('eval: health cycle created alerts', r.created >= 4, `(created=${r.created})`)
    check('rule HighCpu: alert OPEN + severity Critical + value', countAlertsFor(dCPU, 'HighCpu', 'Open') === 1 && (q('SELECT severity FROM Alert WHERE deviceId=? AND type=?', dCPU, 'HighCpu')?.severity) === 'Critical')
    check('rule HighCpu: value+message from persisted telemetry', (q('SELECT value, message FROM Alert WHERE deviceId=? AND type=?', dCPU, 'HighCpu')?.value) === '92%' && (q('SELECT message FROM Alert WHERE deviceId=? AND type=?', dCPU, 'HighCpu')?.message).includes('92'))
    check('rule LowMemory: alert OPEN', countAlertsFor(dMem, 'LowMemory', 'Open') === 1)
    check('rule LowDisk: alert OPEN + value 10GB', countAlertsFor(dDisk, 'LowDisk', 'Open') === 1 && (q('SELECT value FROM Alert WHERE deviceId=? AND type=?', dDisk, 'LowDisk')?.value) === '10GB free')
    check('rule HealthDegraded: alert OPEN (battery+AV = 2 issues)', countAlertsFor(dHealth, 'HealthDegraded', 'Open') === 1)
    check('no LowMemory/LowDisk/HighCpu false positives on dCPU', countAlertsFor(dCPU, 'LowMemory') === 0 && countAlertsFor(dCPU, 'LowDisk') === 0)
    const cpuAlertId = q('SELECT id FROM Alert WHERE deviceId=? AND type=?', dCPU, 'HighCpu').id
    const notif1 = notifCount([cpuAlertId])
    check('queue: 1 notification on create (priority critical)', notif1 === 1 && (q('SELECT priority FROM NotificationQueue WHERE alertId=?', cpuAlertId)?.priority) === 'critical', `(n=${notif1})`)
    const auditOpen = qa('SELECT toStatus, actor FROM AlertEvent WHERE alertId=? ORDER BY createdAt ASC', cpuAlertId)
    check('audit: OPEN transition recorded (actor system)', auditOpen.length === 1 && auditOpen[0].toStatus === 'Open' && auditOpen[0].actor === 'system', JSON.stringify(auditOpen))

    // Dedup / suppression — re-run without new telemetry.
    r = await evaluateOk('eval: re-run completes')
    check('dedup: no duplicate HighCpu alert on re-run', countAlertsFor(dCPU, 'HighCpu', 'Open') === 1, `(n=${countAlertsFor(dCPU, 'HighCpu')})`)
    check('dedup: suppression counted', r.suppressed > 0, `(suppressed=${r.suppressed})`)
    check('dedup: no duplicate notification on re-run', notifCount([cpuAlertId]) === notif1)

    // Condition clears → auto-resolve.
    insSnapshot(dCPU, { cpuPct: 40, ramPct: 50, diskFreeGB: 100, batteryPct: 80, avEnabled: 1 })
    await evaluateOk('eval: clean snapshot cycle')
    const afterClean = q('SELECT status, resolvedBy FROM Alert WHERE id=?', cpuAlertId)
    check('lifecycle: auto-resolve on condition clear', afterClean.status === 'Resolved' && afterClean.resolvedBy === 'system', JSON.stringify(afterClean))
    const auditResolved = qa('SELECT fromStatus, toStatus, actor FROM AlertEvent WHERE alertId=? ORDER BY createdAt ASC', cpuAlertId)
    check('audit: RESOLVED transition recorded', auditResolved.length === 2 && auditResolved[1].fromStatus === 'Open' && auditResolved[1].toStatus === 'Resolved' && auditResolved[1].actor === 'system')

    // Condition returns → automatic reopen.
    insSnapshot(dCPU, { cpuPct: 95, ramPct: 50, diskFreeGB: 100, batteryPct: 80, avEnabled: 1 })
    r = await evaluateOk('eval: bad snapshot cycle')
    check('lifecycle: automatic reopen (REOPENED)', countAlertsFor(dCPU, 'HighCpu', 'Open') === 1 && (q('SELECT resolvedBy FROM Alert WHERE id=?', cpuAlertId)?.resolvedBy) === null, `(reopened=${r.reopened})`)
    const auditReopen = qa('SELECT fromStatus, toStatus, actor FROM AlertEvent WHERE alertId=? ORDER BY createdAt ASC', cpuAlertId)
    check('audit: REOPENED transition recorded (Resolved→Open, system)', auditReopen.length === 3 && auditReopen[2].fromStatus === 'Resolved' && auditReopen[2].toStatus === 'Open' && auditReopen[2].actor === 'system')
    check('queue: reopen enqueues another notification', notifCount([cpuAlertId]) === notif1 + 1, `(n=${notifCount([cpuAlertId])})`)

    // Manual resolution is respected — no auto-reopen.
    const ack1 = await apiReq(F.admin.token, 'POST', `/api/alerts/${cpuAlertId}/acknowledge`, { body: { note: 'on it' } })
    check('api: acknowledge 200', ack1.status === 200 && ack1.json?.alert?.status === 'Acknowledged')
    const resolve1 = await apiReq(F.admin.token, 'POST', `/api/alerts/${cpuAlertId}/resolve`, { body: { note: 'fixed' } })
    check('api: resolve 200 (manual)', resolve1.status === 200 && resolve1.json?.alert?.status === 'Resolved')
    check('api: manual resolution actor = admin', (q('SELECT resolvedBy FROM Alert WHERE id=?', cpuAlertId)?.resolvedBy) === F.admin.id)
    const resolvedCountBefore = countAlertsFor(dCPU, 'HighCpu')
    await evaluateOk('eval: cycle while manually resolved')
    check('lifecycle: manual resolution respected (no reopen)', (q('SELECT status FROM Alert WHERE id=?', cpuAlertId)?.status) === 'Resolved')
    check('lifecycle: new occurrence creates a fresh OPEN alert', countAlertsFor(dCPU, 'HighCpu', 'Open') === 1 && countAlertsFor(dCPU, 'HighCpu') === resolvedCountBefore + 1, `(total=${countAlertsFor(dCPU, 'HighCpu')})`)

    // ── 3) Presence rules (DeviceOffline / MissingHeartbeat) ────────────────
    section('3) Presence rules — offline detection + heartbeat timeout')
    await evaluateOk('eval: presence cycle')
    const off = q('SELECT value FROM Alert WHERE deviceId=? AND type=?', dOffline, 'DeviceOffline')
    check('rule DeviceOffline: alert OPEN + offline minutes value', off && off.value === 'offline 20m', JSON.stringify(off))
    check('rule MissingHeartbeat: alert OPEN (no heartbeat 20m)', countAlertsFor(dHB, 'MissingHeartbeat', 'Open') === 1)
    check('rule MissingHeartbeat: severity High', (q('SELECT severity FROM Alert WHERE deviceId=? AND type=?', dHB, 'MissingHeartbeat')?.severity) === 'High')
    const hbAlertId = q('SELECT id FROM Alert WHERE deviceId=? AND type=?', dHB, 'MissingHeartbeat').id
    check('queue: presence alert notification enqueued', notifCount([hbAlertId]) === 1)

    // Heartbeat timeout recovery → auto-resolve.
    run('UPDATE Device SET lastHeartbeatAt=?, lastSeen=?, status=\'Online\' WHERE id=?', iso(), iso(), dHB)
    await evaluateOk('eval: heartbeat recovery cycle')
    check('presence: MissingHeartbeat auto-resolved after heartbeat', (q('SELECT status FROM Alert WHERE id=?', hbAlertId)?.status) === 'Resolved')

    // Offline recovery + re-offline → reopen.
    run('UPDATE Device SET lastHeartbeatAt=?, lastSeen=?, status=\'Online\' WHERE id=?', iso(), iso(), dOffline)
    await evaluateOk('eval: offline recovery cycle')
    const offAlert = q('SELECT id, status FROM Alert WHERE deviceId=? AND type=? ORDER BY updatedAt DESC', dOffline, 'DeviceOffline')
    check('presence: DeviceOffline auto-resolved on recovery', offAlert && offAlert.status === 'Resolved')
    run('UPDATE Device SET lastHeartbeatAt=?, lastSeen=?, status=\'Offline\' WHERE id=?', iso(Date.now() - 25 * 60000), iso(Date.now() - 25 * 60000), dOffline)
    await evaluateOk('eval: re-offline cycle')
    check('presence: DeviceOffline reopened', (q('SELECT status FROM Alert WHERE id=?', offAlert.id)?.status) === 'Open')

    // ── 4) HighIdle ─────────────────────────────────────────────────────────
    section('4) HighIdle rule')
    insIdleEvent(dIdle, F.employeeA, { duration: 3600 }) // 60 min ≥ 30 min threshold
    await evaluateOk('eval: idle cycle')
    check('rule HighIdle: alert OPEN + value', countAlertsFor(dIdle, 'HighIdle', 'Open') === 1 && (q('SELECT value FROM Alert WHERE deviceId=? AND type=?', dIdle, 'HighIdle')?.value) === 'idle 60m')
    // Short idle → no alert; stale idle → no alert.
    const dIdle2 = insDevice({ hostname: 'al2-idle2', organizationId: F.orgA })
    insIdleEvent(dIdle2, F.employeeA, { duration: 600 })
    insIdleEvent(dIdle2, F.employeeA, { duration: 7200, ts: iso(Date.now() - 4 * 3600000) })
    await evaluateOk('eval: short+stale idle cycle')
    check('rule HighIdle: short idle → no alert', countAlertsFor(dIdle2, 'HighIdle') === 0)
    check('rule HighIdle: stale idle streak → no alert', countAlertsFor(dIdle2, 'HighIdle') === 0)

    // ── 5) RepeatedOcrFailures ──────────────────────────────────────────────
    section('5) OCR failure rule')
    insFailedScreenshot(dOCR, F.employeeA, { processedAt: iso() })
    insFailedScreenshot(dOCR, F.employeeA, { processedAt: iso() })
    await evaluateOk('eval: ocr cycle')
    check('rule RepeatedOcrFailures: 2 failures ≥ threshold 2 → OPEN', countAlertsFor(dOCR, 'RepeatedOcrFailures', 'Open') === 1, `(n=${countAlertsFor(dOCR, 'RepeatedOcrFailures')})`)
    check('rule RepeatedOcrFailures: value carries count', (q('SELECT value FROM Alert WHERE deviceId=? AND type=?', dOCR, 'RepeatedOcrFailures')?.value).startsWith('2 in'))
    // Window cutoff: failures older than the 30-min window do not count.
    const dOCR2 = insDevice({ hostname: 'al2-ocr2', organizationId: F.orgA })
    insFailedScreenshot(dOCR2, F.employeeA, { processedAt: iso(Date.now() - 2 * 3600000) })
    insFailedScreenshot(dOCR2, F.employeeA, { processedAt: iso(Date.now() - 2 * 3600000) })
    await evaluateOk('eval: stale ocr failures cycle')
    const ocr2Alerts = qa('SELECT type, status FROM Alert WHERE deviceId=?', dOCR2)
    check('rule RepeatedOcrFailures: out-of-window failures → no alert', countAlertsFor(dOCR2, 'RepeatedOcrFailures') === 0, `(alerts=${JSON.stringify(ocr2Alerts)})`)

    // ── 6) ScreenshotUploadFailures ─────────────────────────────────────────
    section('6) Upload failure rule')
    insTicket(dUp, { status: 'expired' })
    insTicket(dUp, { status: 'aborted' })
    await evaluateOk('eval: upload cycle')
    check('rule ScreenshotUploadFailures: 2 failed tickets → OPEN', countAlertsFor(dUp, 'ScreenshotUploadFailures', 'Open') === 1)
    check('rule ScreenshotUploadFailures: aborted counts as failure', (q('SELECT value FROM Alert WHERE deviceId=? AND type=?', dUp, 'ScreenshotUploadFailures')?.value).startsWith('2 in'))

    // ── 7) AgentVersionOutdated ─────────────────────────────────────────────
    section('7) Agent version policy')
    await evaluateOk('eval: version cycle')
    check('rule AgentVersionOutdated: v0.9.0 < min 1.2.0 → OPEN', countAlertsFor(dVer, 'AgentVersionOutdated', 'Open') === 1, `(n=${countAlertsFor(dVer, 'AgentVersionOutdated')})`)
    check('rule AgentVersionOutdated: value carries versions', (q('SELECT value FROM Alert WHERE deviceId=? AND type=?', dVer, 'AgentVersionOutdated')?.value).includes('0.9.0'))
    const dCur = insDevice({ hostname: 'al2-cur', agentVersion: '1.2.1', organizationId: F.orgA, installationId: F.inst })
    await evaluateOk('eval: current-version cycle')
    check('rule AgentVersionOutdated: compliant version → no alert', countAlertsFor(dCur, 'AgentVersionOutdated') === 0)

    // ── 8) Cross-org rule scoping ───────────────────────────────────────────
    section('8) Org-scoped rule override')
    const orgRule = await apiReq(F.admin.token, 'POST', '/api/admin/alerts/rules', { body: { type: 'HighCpu', severity: 'Low', config: { cpuThreshold: 10 }, organizationId: F.orgB } })
    check('rules: org-scoped rule created', orgRule.status === 201)
    const dCPU2 = insDevice({ hostname: 'al2-cpu2', organizationId: F.orgA })
    insSnapshot(dForeign, { cpuPct: 50, ramPct: 30, diskFreeGB: 200, batteryPct: 90, avEnabled: 1 })
    insSnapshot(dCPU2, { cpuPct: 60, ramPct: 50, diskFreeGB: 100, batteryPct: 80, avEnabled: 1 }) // 60 < global 80 → no new alert
    await evaluateOk('eval: org-rule cycle')
    check('org rule: foreign device uses orgB threshold 10 → alert', countAlertsFor(dForeign, 'HighCpu', 'Open') === 1)
    check('org rule: orgA device keeps global threshold 80 → no new alert', countAlertsFor(dCPU2, 'HighCpu') === 0, `(n=${countAlertsFor(dCPU2, 'HighCpu')})`)
    check('org rule: foreign alert carries orgB scope', (q('SELECT organizationId FROM Alert WHERE deviceId=? AND type=?', dForeign, 'HighCpu')?.organizationId) === F.orgB)
    run('DELETE FROM AlertRule WHERE id=?', orgRule.json.rule.id)

    // ── 9) Alert APIs — list / detail / filters / lifecycle ────────────────
    section('9) Alert API — list, detail, filters, lifecycle')
    const listAll = await apiReq(F.admin.token, 'GET', '/api/alerts')
    check('api: GET /api/alerts 200 + payload shape', listAll.status === 200 && Array.isArray(listAll.json?.alerts) && typeof listAll.json.total === 'number')
    const totalAlerts = listAll.json.total
    check('api: list total > 0', totalAlerts > 0)
    const filtStatus = await apiReq(F.admin.token, 'GET', '/api/alerts?status=Open')
    check('api: filter status=Open', filtStatus.json.alerts.every((a) => a.status === 'Open'))
    const filtType = await apiReq(F.admin.token, 'GET', `/api/alerts?type=HighCpu&deviceId=${dCPU}`)
    check('api: filter type+deviceId', filtType.json.alerts.every((a) => a.type === 'HighCpu' && a.deviceId === dCPU) && filtType.json.total >= 2)
    const filtSeverity = await apiReq(F.admin.token, 'GET', '/api/alerts?severity=Critical')
    check('api: filter severity=Critical returns only Critical', filtSeverity.json.alerts.every((a) => a.severity === 'Critical'))
    const badStatus = await apiReq(F.admin.token, 'GET', '/api/alerts?status=Bogus')
    check('api: invalid status filter → 400', badStatus.status === 400)
    const badLimit = await apiReq(F.admin.token, 'GET', '/api/alerts?limit=0')
    check('api: limit=0 → 400', badLimit.status === 400)

    const detail = await apiReq(F.admin.token, 'GET', `/api/alerts/${cpuAlertId}`)
    check('api: GET /api/alerts/:id 200 + events trail', detail.status === 200 && Array.isArray(detail.json?.alert?.events) && detail.json.alert.events.length >= 3)
    const detail404 = await apiReq(F.admin.token, 'GET', `/api/alerts/${cuid('nope')}`)
    check('api: GET unknown alert → 404', detail404.status === 404)

    // Acknowledge + resolve full cycle on a fresh alert (dDisk).
    const diskAlertId = q('SELECT id FROM Alert WHERE deviceId=? AND type=?', dDisk, 'LowDisk').id
    const ackDisk = await apiReq(F.admin.token, 'POST', `/api/alerts/${diskAlertId}/acknowledge`)
    check('api: acknowledge → Acknowledged + actor', ackDisk.status === 200 && ackDisk.json.alert.status === 'Acknowledged' && ackDisk.json.alert.acknowledgedBy === F.admin.id)
    check('api: acknowledge audited', qa('SELECT toStatus FROM AlertEvent WHERE alertId=?', diskAlertId).some((e) => e.toStatus === 'Acknowledged'))
    const ackDisk2 = await apiReq(F.admin.token, 'POST', `/api/alerts/${diskAlertId}/acknowledge`)
    check('api: re-acknowledge idempotent (already)', ackDisk2.status === 200 && ackDisk2.json.transition === 'already')
    const ackResolved = await apiReq(F.admin.token, 'POST', `/api/alerts/${cpuAlertId}/acknowledge`)
    check('api: acknowledge a resolved alert → 409', ackResolved.status === 409, `(got ${ackResolved.status})`)
    const resDisk = await apiReq(F.admin.token, 'POST', `/api/alerts/${diskAlertId}/resolve`, { body: { note: 'disk replaced' } })
    check('api: resolve acknowledged → Resolved + note', resDisk.status === 200 && resDisk.json.alert.status === 'Resolved' && resDisk.json.alert.resolvedAt !== null)
    const resDisk2 = await apiReq(F.admin.token, 'POST', `/api/alerts/${diskAlertId}/resolve`)
    check('api: re-resolve idempotent', resDisk2.status === 200 && resDisk2.json.transition === 'already')

    // ── 10) Pagination ──────────────────────────────────────────────────────
    section('10) Pagination + bulk evaluation')
    for (let i = 0; i < 25; i++) {
      const d = insDevice({ hostname: `al2-bulk-${i}`, organizationId: F.orgA })
      bulkDevices.push(d)
      insSnapshot(d, { cpuPct: 95, ramPct: 40, diskFreeGB: 200, batteryPct: 90, avEnabled: 1 })
    }
    const bulkBefore = openCount()
    const bulkEval = await evaluateOk(`eval: bulk cycle (25 devices)`)
    check('pagination: 25 bulk HighCpu alerts created', countAlertsFor(bulkDevices[0], 'HighCpu') === 1 && countAlertsFor(bulkDevices[24], 'HighCpu') === 1)
    for (const d of bulkDevices) bulkAlerts.push(q('SELECT id FROM Alert WHERE deviceId=? AND type=?', d, 'HighCpu').id)
    check('pagination: open count increased by 25', openCount() === bulkBefore + 25, `(${bulkBefore} → ${openCount()})`)

    const p1 = await apiReq(F.admin.token, 'GET', '/api/alerts?limit=10&offset=0')
    const p2 = await apiReq(F.admin.token, 'GET', '/api/alerts?limit=10&offset=10')
    const p3 = await apiReq(F.admin.token, 'GET', '/api/alerts?limit=10&offset=20')
    check('pagination: limit honored', p1.json.alerts.length === 10 && p2.json.alerts.length === 10)
    check('pagination: hasMore flags', p1.json.hasMore === true && p2.json.hasMore === true)
    const ids1 = new Set(p1.json.alerts.map((a) => a.id))
    const overlap = p2.json.alerts.filter((a) => ids1.has(a.id)).length
    check('pagination: no overlap across pages', overlap === 0)
    check('pagination: total consistent', p1.json.total === p2.json.total && p2.json.total >= 25)
    const p4 = await apiReq(F.admin.token, 'GET', '/api/alerts?limit=10&offset=30')
    check('pagination: final page returns remaining', p4.json.alerts.length >= 0 && p4.json.offset === 30)
    const bigLimit = await apiReq(F.admin.token, 'GET', '/api/alerts?limit=500')
    check('pagination: limit clamped to 100', bigLimit.json.alerts.length <= 100)

    // ── 11) Authorization & scoping ─────────────────────────────────────────
    section('11) Authorization — org isolation + self-only')
    // Employee-visible alert: a HighIdle alert on the employee's own device.
    insIdleEvent(dClean, F.employeeA, { duration: 7200 })
    await evaluateOk('eval: employee-device idle cycle')
    check('auth: employee device alert created (own device)', countAlertsFor(dClean, 'HighIdle', 'Open') === 1)
    const mgrA = await apiReq(F.mgrAToken, 'GET', '/api/alerts', { headers: { cookie: F.mgrACookie } })
    check('auth: manager A sees only orgA alerts', mgrA.status === 200 && mgrA.json.alerts.every((a) => a.organizationId === F.orgA))
    const mgrB = await apiReq(F.mgrBToken, 'GET', '/api/alerts', { headers: { cookie: F.mgrBCookie } })
    check('auth: manager B never sees orgA alerts', mgrB.json.alerts.every((a) => a.organizationId === F.orgB))
    const foreignAlert = q('SELECT id FROM Alert WHERE deviceId=? AND type=?', dForeign, 'HighCpu')
    const mgrAForeign = await apiReq(F.mgrAToken, 'GET', `/api/alerts/${foreignAlert.id}`, { headers: { cookie: F.mgrACookie } })
    check('auth: manager A cannot read foreign alert → 404', mgrAForeign.status === 404, `(got ${mgrAForeign.status})`)
    const empA = await apiReq(F.empAToken, 'GET', '/api/alerts', { headers: { cookie: F.empACookie } })
    check('auth: employee sees only own-device alerts', empA.status === 200 && empA.json.alerts.every((a) => a.deviceId === dClean || a.userId === F.employeeA) && empA.json.alerts.length === 1, `(n=${empA.json.alerts.length})`)
    check('auth: employee does not see orgA fleet alerts', empA.json.alerts.every((a) => a.deviceId !== dCPU && a.deviceId !== dHB))
    const empAck = await apiReq(F.empAToken, 'POST', `/api/alerts/${cpuAlertId}/acknowledge`, { headers: { cookie: F.empACookie } })
    check('auth: employee cannot acknowledge foreign alert → 404', empAck.status === 404)
    const noAuth = await apiReq('', 'GET', '/api/alerts', { headers: { cookie: '' } })
    check('auth: unauthenticated /api/alerts → 401', noAuth.status === 401)
    const empLive = await apiReq(F.empAToken, 'GET', '/api/live/status', { headers: { cookie: F.empACookie } })
    check('auth: employee live status self-scoped 200', empLive.status === 200)
    const empAck2 = await apiReq(F.empBToken, 'POST', `/api/alerts/${cpuAlertId}/acknowledge`, { headers: { cookie: F.empBCookie } })
    check('auth: employee B cross-tenant ack → 404', empAck2.status === 404)

    // ── 12) Live APIs ───────────────────────────────────────────────────────
    section('12) Live status + live devices')
    insActivityEvent(dClean, F.employeeA, { kind: 'app', title: 'code.exe' })
    insActivityEvent(dClean, F.employeeA, { kind: 'app', title: 'slack.exe' })
    const live = await apiReq(F.admin.token, 'GET', '/api/live/status')
    check('live: status 200 + fields', live.status === 200 && typeof live.json.onlineDevices === 'number' && typeof live.json.alertCount === 'number')
    check('live: totals consistent (online+offline=total)', live.json.onlineDevices + live.json.offlineDevices === live.json.totalDevices, JSON.stringify({ on: live.json.onlineDevices, off: live.json.offlineDevices, total: live.json.totalDevices }))
    check('live: degraded devices counted', live.json.degradedDevices >= 1, `(n=${live.json.degradedDevices})`)
    check('live: stale devices counted (Online but silent > 15m)', live.json.staleDevices >= 1, `(n=${live.json.staleDevices})`)
    check('live: open alert count matches', live.json.alertCount === openCount(), `(${live.json.alertCount} vs ${openCount()})`)
    check('live: alert by severity includes Critical', Array.isArray(live.json.alertBySeverity) && live.json.alertBySeverity.some((s) => s.severity === 'Critical'))
    check('live: active users ≥ 1 (recent activity)', live.json.activeUsers >= 1, `(n=${live.json.activeUsers})`)
    check('live: current activity non-empty', Array.isArray(live.json.currentActivity) && live.json.currentActivity.length >= 1)
    check('live: latest heartbeat present', typeof live.json.latestHeartbeat === 'string')
    const liveMgrA = await apiReq(F.mgrAToken, 'GET', '/api/live/status', { headers: { cookie: F.mgrACookie } })
    check('live: manager scoping (orgA devices only)', liveMgrA.status === 200 && liveMgrA.json.totalDevices >= 40 && liveMgrA.json.totalDevices <= 60, `(total=${liveMgrA.json.totalDevices})`)
    const liveEmp = await apiReq(F.empAToken, 'GET', '/api/live/status', { headers: { cookie: F.empACookie } })
    check('live: employee sees only own device', liveEmp.json.totalDevices === 1, `(total=${liveEmp.json.totalDevices})`)

    const ldev = await apiReq(F.admin.token, 'GET', '/api/live/devices')
    check('live-devices: 200 + rows', ldev.status === 200 && Array.isArray(ldev.json.devices) && ldev.json.devices.length >= 13)
    const cpuRow = ldev.json.devices.find((d) => d.id === dCPU)
    check('live-devices: per-device health present', cpuRow && cpuRow.health && cpuRow.health.cpuPct === 95)
    check('live-devices: per-device openAlerts count', cpuRow && typeof cpuRow.openAlerts === 'number' && cpuRow.openAlerts >= 1)
    check('live-devices: latest alert surfaced', cpuRow && cpuRow.latestAlert && cpuRow.latestAlert.type === 'HighCpu')
    const offlineRow = ldev.json.devices.find((d) => d.id === dOffline)
    check('live-devices: offline flag', offlineRow && offlineRow.online === false)
    const badLimit2 = await apiReq(F.admin.token, 'GET', '/api/live/devices?limit=-1')
    check('live-devices: invalid limit → 400', badLimit2.status === 400)

    // ── 13) Concurrency ─────────────────────────────────────────────────────
    section('13) Concurrency — parallel evaluate triggers')
    const beforeConc = q('SELECT COUNT(*) c FROM Alert')?.c ?? 0
    const beforeNotif = q('SELECT COUNT(*) c FROM NotificationQueue')?.c ?? 0
    const results = await Promise.all([
      evaluate(), evaluate(), evaluate(), evaluate(), evaluate(),
    ])
    check('concurrency: all parallel triggers 200', results.every((r) => r.status === 200))
    check('concurrency: no duplicate alerts from concurrent runs', (q('SELECT COUNT(*) c FROM Alert')?.c ?? 0) === beforeConc, `(${beforeConc} → ${q('SELECT COUNT(*) c FROM Alert')?.c})`)
    check('concurrency: no duplicate notifications', (q('SELECT COUNT(*) c FROM NotificationQueue')?.c ?? 0) === beforeNotif)

    // ── 14) Rollback + graceful degradation ────────────────────────────────
    section('14) Transaction rollback + corrupt config')
    const rbId = cuid('al2rb')
    db.run('BEGIN')
    let rbThrew = false
    try {
      run('INSERT INTO Alert (id, type, severity, message, status, timestamp, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)', rbId, 'HighCpu', 'High', 'rb', 'Open', iso(), iso(), iso())
      run('INSERT INTO AlertEvent (id, alertId, fromStatus, toStatus, actor, createdAt) VALUES (?,?,?,?,?,?)', cuid('al2ev'), rbId, null, 'Open', 'system', iso())
      run('INSERT INTO NotificationQueue (id, alertId, kind, payload, status, createdAt) VALUES (?,?,?,?,?,?)', cuid('al2nq'), rbId, 'alert', null, 'pending', iso()) // payload NOT NULL → fails
    } catch {
      rbThrew = true
    }
    db.run('ROLLBACK')
    check('rollback: forced constraint violation threw', rbThrew === true)
    check('rollback: alert rolled back (no partial rows)', (q('SELECT COUNT(*) c FROM Alert WHERE id=?', rbId)?.c ?? 0) === 0)
    check('rollback: audit event rolled back', (q('SELECT COUNT(*) c FROM AlertEvent WHERE alertId=?', rbId)?.c ?? 0) === 0)

    // Corrupt rule config → rule disabled gracefully, cycle still completes.
    const idleRule = q('SELECT id FROM AlertRule WHERE type=? AND organizationId IS NULL', 'HighIdle')
    run('UPDATE AlertRule SET config=? WHERE id=?', '{broken-json', idleRule.id)
    const corruptEval = await evaluateOk('eval: corrupt rule cycle completes')
    check('rollback: corrupt rule produced no HighIdle alert', countAlertsFor(dIdle, 'HighIdle', 'Open') === 1, `(n=${countAlertsFor(dIdle, 'HighIdle')})`)
    check('rollback: corrupt rule did not block other rules', countAlertsFor(dCPU, 'HighCpu', 'Open') === 1)
    run('UPDATE AlertRule SET config=? WHERE id=?', JSON.stringify({ idleMinutes: 30 }), idleRule.id)

    // ── 15) Checkpoint / worker restart / gap recovery ─────────────────────
    section('15) Checkpoint — idempotent resume + gap recovery')
    const cp = q('SELECT * FROM RollupCheckpoint WHERE key=?', 'alert-eval')
    check('checkpoint: row exists', !!cp)
    check('checkpoint: status idle after completed cycle', cp?.status === 'idle')
    check('checkpoint: lastRunAt recent (< 2 min old)', cp && Date.now() - new Date(cp.lastRunAt).getTime() < 120000)

    // Gap recovery: dGap goes offline 40 min ago — OUTSIDE the steady-state
    // presence horizon (now − 30 min) and the row was last updated 25 h ago
    // (outside the updatedAt watermark) — only a worker-gap rollback catches it.
    const dGap = insDevice({ hostname: 'al2-gap', lastSeen: iso(Date.now() - 40 * 60000), lastHeartbeatAt: iso(Date.now() - 40 * 60000), organizationId: F.orgA, updatedAt: iso(Date.now() - 25 * 3600000) })
    const gapAlertBefore = countAlertsFor(dGap, 'DeviceOffline')
    check('gap: no alert before gap simulation (outside horizon)', gapAlertBefore === 0, `(n=${gapAlertBefore})`)
    run("UPDATE RollupCheckpoint SET lastRunAt=? WHERE key='alert-eval'", iso(Date.now() - 2 * 3600000))
    await evaluateOk('eval: post-gap cycle')
    check('gap: device offline during worker downtime alerted', countAlertsFor(dGap, 'DeviceOffline', 'Open') === 1, `(n=${countAlertsFor(dGap, 'DeviceOffline')})`)
    check('gap: value reflects 40m offline', (q('SELECT value FROM Alert WHERE deviceId=? AND type=?', dGap, 'DeviceOffline')?.value) === 'offline 40m')
    await evaluateOk('eval: post-gap re-run idempotent')
    check('gap: no duplicate after post-gap re-run', countAlertsFor(dGap, 'DeviceOffline') === 1)

    // Crash-simulated re-run from an older watermark → no duplicates (dGap's
    // alert now exists and is Open, so a resumed run only suppresses).
    const alertsBeforeCrash = q('SELECT COUNT(*) c FROM Alert')?.c ?? 0
    const notifsBeforeCrash = q('SELECT COUNT(*) c FROM NotificationQueue')?.c ?? 0
    run("UPDATE RollupCheckpoint SET lastRunAt=? WHERE key='alert-eval'", iso(Date.now() - 60 * 60000))
    await evaluateOk('eval: resume from stale checkpoint')
    check('checkpoint: crash-resume produces no duplicate alerts', (q('SELECT COUNT(*) c FROM Alert')?.c ?? 0) === alertsBeforeCrash, `(${alertsBeforeCrash} → ${q('SELECT COUNT(*) c FROM Alert')?.c})`)
    check('checkpoint: crash-resume produces no duplicate notifications', (q('SELECT COUNT(*) c FROM NotificationQueue')?.c ?? 0) === notifsBeforeCrash)

    // ── 16) Regression ──────────────────────────────────────────────────────
    section('16) Regression — Stage-1 endpoints stay green')
    for (const [name, p, method] of [
      ['dashboard', '/api/dashboard?range=7d', 'GET'],
      ['dashboard/activity', '/api/dashboard/activity?range=7d', 'GET'],
      ['dashboard/devices', '/api/dashboard/devices?range=7d', 'GET'],
      ['dashboard/timeline', '/api/dashboard/timeline?limit=10', 'GET'],
      ['dashboard/heatmap', '/api/dashboard/heatmap?range=7d', 'GET'],
      ['analytics', '/api/analytics?range=7d', 'GET'],
      ['timeline', '/api/timeline', 'GET'],
    ]) {
      const r = await apiReq(F.admin.token, method, p)
      check(`regression: ${name} 200`, r.status === 200, `(got ${r.status})`)
    }
    const rollup = await apiReq(F.admin.token, 'POST', '/api/admin/analytics/rollup')
    check('regression: analytics rollup trigger 200', rollup.status === 200 && rollup.json.status === 'completed', `(got ${rollup.status} ${rollup.json?.status})`)
    const live401 = await apiReq('', 'GET', '/api/live/status', { headers: { cookie: '' } })
    check('regression: unauthenticated /api/live/status → 401', live401.status === 401)

    // ── Cleanup ─────────────────────────────────────────────────────────────
    section('17) Cleanup')
    const delAlertRows = qa(`SELECT id FROM Alert WHERE deviceId IN (${devIds.map(() => '?').join(',')})`, ...devIds)
    const delAlertIds = delAlertRows.map((r) => r.id)
    if (delAlertIds.length) {
      run(`DELETE FROM NotificationQueue WHERE alertId IN (${delAlertIds.map(() => '?').join(',')})`, ...delAlertIds)
      run(`DELETE FROM AlertEvent WHERE alertId IN (${delAlertIds.map(() => '?').join(',')})`, ...delAlertIds)
      run(`DELETE FROM Alert WHERE id IN (${delAlertIds.map(() => '?').join(',')})`, ...delAlertIds)
    }
    if (screenshotIds.length) run(`DELETE FROM Screenshot WHERE id IN (${screenshotIds.map(() => '?').join(',')})`, ...screenshotIds)
    if (ticketIds.length) run(`DELETE FROM UploadTicket WHERE id IN (${ticketIds.map(() => '?').join(',')})`, ...ticketIds)
    if (eventIds.length) run(`DELETE FROM ActivityEvent WHERE id IN (${eventIds.map(() => '?').join(',')})`, ...eventIds)
    run(`DELETE FROM DeviceHealthSnapshot WHERE deviceId IN (${devIds.map(() => '?').join(',')})`, ...devIds)
    run(`DELETE FROM DeviceAssignment WHERE deviceId IN (${devIds.map(() => '?').join(',')})`, ...devIds)
    run(`DELETE FROM User WHERE id IN (?,?,?,?)`, F.managerA, F.managerB, F.employeeA, F.employeeB)
    run(`DELETE FROM Device WHERE id IN (${devIds.map(() => '?').join(',')})`, ...devIds)
    run('DELETE FROM Installation WHERE id=?', F.inst)
    if (ruleIds.length) run(`DELETE FROM AlertRule WHERE id IN (${ruleIds.map(() => '?').join(',')})`, ...ruleIds)
    run("DELETE FROM RollupCheckpoint WHERE key='alert-eval'")
    run('DELETE FROM Organization WHERE id IN (?,?)', F.orgA, F.orgB)
    check('cleanup: no fixture devices left', (q('SELECT COUNT(*) c FROM Device WHERE hostname LIKE \'al2-%\'')?.c ?? 0) === 0)
    check('cleanup: no fixture rules left', (q(`SELECT COUNT(*) c FROM AlertRule WHERE id IN (${ruleIds.map(() => '?').join(',')})`, ...ruleIds)?.c ?? 0) === 0)
    check('cleanup: no fixture alerts left', delAlertIds.length === 0 || (q(`SELECT COUNT(*) c FROM Alert WHERE id IN (${delAlertIds.map(() => '?').join(',')})`, ...delAlertIds)?.c ?? 0) === 0)
    // Restore pristine state for mission-rule alerts (worker may run later).
    cleanSlate()

    console.log(`\n=========================================================`)
    console.log(`M008 Stage-2 alert verification: ${passed} passed, ${failed} failed (${((passed / (passed + failed || 1)) * 100).toFixed(1)}%)`)
    if (failures.length) console.log('\nFailures:\n  ' + failures.join('\n  '))
    process.exit(failed === 0 ? 0 : 1)
  } catch (err) {
    console.error('FATAL:', err)
    console.log(`M008 Stage-2 alert verification CRASHED — ${passed} passed, ${failed} failed`)
    process.exitCode = 2
  }
}

await main()
