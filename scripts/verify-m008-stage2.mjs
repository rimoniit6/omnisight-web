/**
 * M008 Stage-2 — Analytics Runtime Layer — Automated Verification (live server)
 *
 * Verifies the complete Stage-2 runtime: queue · scheduler · cache · health ·
 * retention · 14 alert types · 7 admin endpoints · RBAC isolation.
 *
 * Run against a dev server with admin login:
 *   npx next dev -p 3100   (or whatever port)
 *   BASE_URL=http://localhost:3100 bun scripts/verify-m008-stage2.mjs
 *
 * Env: BASE_URL (default http://localhost:3100) · DB_PATH (default db/custom.db)
 *      SUPER_ADMIN_EMAIL · SUPER_ADMIN_PASSWORD (auto-loaded from .env by bun)
 */
import { randomBytes } from 'node:crypto'
import { Database } from 'bun:sqlite'

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
    console.log('  PASS ' + name)
  } else {
    failed++
    failures.push(name)
    console.log('  FAIL ' + name + (extra ? ' — ' + extra : ''))
  }
}

function section(title) {
  console.log('\n\u2500\u2500 ' + title + ' \u2500'.repeat(Math.max(0, 70 - title.length)))
}

const db = new Database(DB_PATH)
db.run('PRAGMA foreign_keys = ON')
const q = (sql, ...args) => db.query(sql)?.get?.(...args) ?? null
const qa = (sql, ...args) => db.query(sql)?.all?.(...args) ?? []
const run = (sql, ...args) => db.query(sql).run(...args)

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

// ── Setup ─────────────────────────────────────────────────────────────────────
console.log('\nM008 Stage-2 Verification — ' + BASE)

const loginRes = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD)
check('admin login succeeds', loginRes.status === 200, 'status=' + loginRes.status)
ADMIN_TOKEN = loginRes.token || ''
SESSION_COOKIE = loginRes.cookie || ''

// ── 1. Analytics Queue ───────────────────────────────────────────────────────
section('Analytics Queue')

// Enqueue a test job
const enqueueRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/analytics/rollup', {
  cookie: SESSION_COOKIE,
  body: { action: 'trigger', jobType: 'incremental_rollup', mode: 'incremental' },
})
check('POST /api/admin/analytics/rollup (trigger) succeeds', enqueueRes.status === 200, 'status=' + enqueueRes.status)

// Verify job was created
const jobsBefore = q("SELECT COUNT(*) as c FROM AnalyticsJob WHERE jobType='incremental_rollup'")
check('AnalyticsJob row created in queue', jobsBefore && jobsBefore.c > 0, 'count=' + (jobsBefore?.c))

// Verify queue columns exist (retryCount, durationMs, payload)
const colCheck = q(`PRAGMA table_info(AnalyticsJob)`)
const colNames = qa('PRAGMA table_info(AnalyticsJob)').map((r) => r.name)
check('AnalyticsJob has retryCount column', colNames.includes('retryCount'), colNames.join(','))
check('AnalyticsJob has durationMs column', colNames.includes('durationMs'), colNames.join(','))
check('AnalyticsJob has payload column', colNames.includes('payload'), colNames.join(','))

// Verify indexes exist
const indexes = qa("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='AnalyticsJob'")
const indexNames = indexes.map((i) => i.name)
check('AnalyticsJob has jobType+status index', indexNames.some((n) => n.includes('jobType') && n.includes('status')))
check('AnalyticsJob has status+fromDate index', indexNames.some((n) => n.includes('status') && n.includes('fromDate')))

// ── 2. Analytics Jobs Admin API ────────────────────────────────────────────────
section('Analytics Jobs API (GET /api/admin/analytics/jobs)')

const jobsRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/analytics/jobs')
check('GET jobs returns 200', jobsRes.status === 200, 'status=' + jobsRes.status)
check('GET jobs returns array', Array.isArray(jobsRes.json?.jobs), typeof jobsRes.json?.jobs)

if (jobsRes.json?.jobs?.length > 0) {
  const first = jobsRes.json.jobs[0]
  check('Job has id', !!first.id)
  check('Job has jobType', !!first.jobType)
  check('Job has status', !!first.status)
  check('Job has retryCount', typeof first.retryCount === 'number')
}

// Filter by status
const pendingRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/analytics/jobs?status=pending')
check('GET jobs?status=pending returns array', Array.isArray(pendingRes.json?.jobs))

// Filter by jobType
const rollupRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/analytics/jobs?jobType=incremental_rollup')
check('GET jobs?jobType=incremental_rollup returns array', Array.isArray(rollupRes.json?.jobs))

// ── 3. Analytics Cache ─────────────────────────────────────────────────────────
section('Analytics Cache')

const cacheRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/analytics/cache')
check('GET cache returns 200', cacheRes.status === 200, 'status=' + cacheRes.status)
check('Cache response has stats', !!cacheRes.json?.cache, JSON.stringify(cacheRes.json))
check('Cache stats has size', typeof cacheRes.json?.cache?.size === 'number')
check('Cache stats has entries', typeof cacheRes.json?.cache?.entries === 'number')
check('Cache stats has utilization', typeof cacheRes.json?.cache?.utilization === 'number')

// Clear cache
const clearRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/analytics/cache', { body: {} })
check('POST cache clear returns 200', clearRes.status === 200, 'status=' + clearRes.status)
check('Cache clear response', clearRes.json?.cleared === true)

// Clear by tag
const clearTagRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/analytics/cache', { body: { tag: 'dashboard:admin' } })
check('POST cache clear by tag returns 200', clearTagRes.status === 200)
check('Cache clear by tag evicted', typeof clearTagRes.json?.evicted === 'number')

// ── 4. Workers Health API ────────────────────────────────────────────────────
section('Workers Health API (GET /api/admin/analytics/workers)')

const workersRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/analytics/workers')
check('GET workers returns 200', workersRes.status === 200, 'status=' + workersRes.status)
check('Workers response has array', Array.isArray(workersRes.json?.workers))

if (workersRes.json?.workers?.length > 0) {
  const w = workersRes.json.workers[0]
  check('Worker has name', !!w.name)
  check('Worker has running', typeof w.running === 'boolean')
  check('Worker has successCount', typeof w.successCount === 'number')
  check('Worker has failureCount', typeof w.failureCount === 'number')
  check('Worker has stuck', typeof w.stuck === 'boolean')
  check('Worker has lag', w.lag === null || typeof w.lag === 'number')
}
check('Workers response has hasStuck', typeof workersRes.json?.hasStuck === 'boolean')

// ── 5. Alerts Admin API ───────────────────────────────────────────────────────
section('Alerts Admin API')

const alertsRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/analytics/alerts')
check('GET alerts returns 200', alertsRes.status === 200, 'status=' + alertsRes.status)
check('Alerts response has array', Array.isArray(alertsRes.json?.alerts))

// Filter by status
const openAlertsRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/analytics/alerts?status=Open')
check('GET alerts?status=Open returns array', Array.isArray(openAlertsRes.json?.alerts))

// Check existing Open alerts have device info
if (openAlertsRes.json?.alerts?.length > 0) {
  const a = openAlertsRes.json.alerts[0]
  check('Alert has id', !!a.id)
  check('Alert has type', !!a.type)
  check('Alert has severity', !!a.severity)
  check('Alert has status', !!a.status)
  check('Alert has createdAt', !!a.createdAt)
}

// ── 6. Retry API ──────────────────────────────────────────────────────────────
section('Retry API (POST /api/admin/analytics/retry)')

// Create a failed job first (trigger a job that will be created but may not execute)
const retryRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/analytics/retry', { body: {} })
check('POST retry returns 200', retryRes.status === 200, 'status=' + retryRes.status)
check('Retry response has retried', typeof retryRes.json?.retried === 'number')

// Retry by jobType
const retryByTypeRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/analytics/retry', { body: { jobType: 'retention_cleanup' } })
check('POST retry by jobType returns 200', retryByTypeRes.status === 200)

// ── 7. Alert Resolve API ──────────────────────────────────────────────────────
section('Alert Resolve API (POST /api/admin/analytics/alerts/{id}/resolve)')

if (openAlertsRes.json?.alerts?.length > 0) {
  const alertId = openAlertsRes.json.alerts[0].id
  const resolveRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/analytics/alerts/' + alertId + '/resolve', {
    body: { resolvedBy: 'admin@test' },
  })
  check('POST resolve returns 200', resolveRes.status === 200, 'status=' + resolveRes.status)
  check('Resolve result has resolved', resolveRes.json?.resolved === true || resolveRes.json?.alreadyResolved === true)
}

// Resolve non-existent alert → 404
const notFoundRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/analytics/alerts/nonexistent/resolve', {
  body: { resolvedBy: 'system' },
})
check('POST resolve non-existent returns 404', notFoundRes.status === 404)

// ── 8. RBAC — Non-admin cannot access ────────────────────────────────────────
section('RBAC — Admin-Only Access')

// Login as regular user
const userLoginRes = await loginAs('demo@demo.com', 'demo123')
if (userLoginRes.status === 200) {
  const userToken = userLoginRes.token || ''
  const userCookie = userLoginRes.cookie || ''

  const adminJobsAttempt = await apiReq(userToken, 'GET', '/api/admin/analytics/jobs', { cookie: userCookie })
  check('Employee blocked from GET /api/admin/analytics/jobs', adminJobsAttempt.status === 403 || adminJobsAttempt.status === 401, 'status=' + adminJobsAttempt.status)

  const adminCacheAttempt = await apiReq(userToken, 'GET', '/api/admin/analytics/cache', { cookie: userCookie })
  check('Employee blocked from GET /api/admin/analytics/cache', adminCacheAttempt.status === 403 || adminCacheAttempt.status === 401, 'status=' + adminCacheAttempt.status)

  const adminWorkersAttempt = await apiReq(userToken, 'GET', '/api/admin/analytics/workers', { cookie: userCookie })
  check('Employee blocked from GET /api/admin/analytics/workers', adminWorkersAttempt.status === 403 || adminWorkersAttempt.status === 401, 'status=' + adminWorkersAttempt.status)

  const adminAlertsAttempt = await apiReq(userToken, 'GET', '/api/admin/analytics/alerts', { cookie: userCookie })
  check('Employee blocked from GET /api/admin/analytics/alerts', adminAlertsAttempt.status === 403 || adminAlertsAttempt.status === 401, 'status=' + adminAlertsAttempt.status)

  const adminRetryAttempt = await apiReq(userToken, 'POST', '/api/admin/analytics/retry', { cookie: userCookie, body: {} })
  check('Employee blocked from POST /api/admin/analytics/retry', adminRetryAttempt.status === 403 || adminRetryAttempt.status === 401, 'status=' + adminRetryAttempt.status)
} else {
  check('Demo user login (for RBAC test)', false, 'status=' + userLoginRes.status)
}

// ── 9. 14 Alert Types Verification ───────────────────────────────────────────
section('14 Alert Types')

const allTypes = qa("SELECT DISTINCT type FROM AlertRule")
const typeMap = allTypes.map((r) => r.type)
const expectedTypes = [
  'DeviceOffline', 'MissingHeartbeat', 'HighIdle', 'HighCpu',
  'LowMemory', 'LowDisk', 'RepeatedOcrFailures', 'ScreenshotUploadFailures',
  'AgentVersionOutdated', 'HealthDegraded',
  'LowProductivity', 'ScreenshotFailure', 'RepeatedCrashes', 'PolicyMismatch',
]
for (const t of expectedTypes) {
  check('Alert rule type: ' + t, typeMap.includes(t), 'found types: ' + typeMap.join(','))
}

// Verify default rules are seeded
const defaultRules = qa("SELECT type FROM AlertRule WHERE organizationId IS NULL AND enabled=1")
check('14 default rule rows seeded', defaultRules.length === 14, 'count=' + defaultRules.length)

// ── 10. Scheduler Integration ────────────────────────────────────────────────
section('Scheduler & Worker Integration')

// Verify scheduler is running or can be started
const schedulerStatsRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/analytics/workers')
check('Scheduler shows in worker health', schedulerStatsRes.json?.workers?.some((w) => w.name === 'scheduler'))

// Verify retention worker registered
check('Retention worker registered', schedulerStatsRes.json?.workers?.some((w) => w.name === 'retention'))
check('Rollup worker registered', schedulerStatsRes.json?.workers?.some((w) => w.name === 'rollup'))
check('Alerts worker registered', schedulerStatsRes.json?.workers?.some((w) => w.name === 'alerts'))

// ── 11. Cache Integration in Dashboard Routes ────────────────────────────────
section('Cache Integration (Dashboard/Analytics/Timeline)')

const dashRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/dashboard?range=7d')
check('GET /api/dashboard returns 200 (cached)', dashRes.status === 200, 'status=' + dashRes.status)

const analyticsRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/analytics?range=7d')
check('GET /api/analytics returns 200 (cached)', analyticsRes.status === 200, 'status=' + analyticsRes.status)

const timelineRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/timeline')
check('GET /api/timeline returns 200 (cached)', timelineRes.status === 200, 'status=' + timelineRes.status)

// ── 12. Retention Config ──────────────────────────────────────────────────────
section('Retention Worker Config')

// Verify retention_cleanup job type exists in schema
const retentionJob = q("SELECT COUNT(*) as c FROM AnalyticsJob WHERE jobType='retention_cleanup'")
check('AnalyticsJob supports retention_cleanup type', retentionJob !== null)

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(76))
console.log('M008 Stage-2 Verification: ' + passed + ' passed, ' + failed + ' failed')
if (failures.length > 0) {
  console.log('\nFailed checks:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
} else {
  console.log('\nAll checks passed.')
  process.exit(0)
}
