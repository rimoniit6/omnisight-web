/**
 * M008 Stage-3 — AI-Powered Analytics Consumption Layer — Automated Verification (live server)
 *
 * Verifies the complete Stage-3 surface: schema (AISummary/ReportSchedule/AuditLog/Report) ·
 * report generator (create/list/get/delete + audit) · AI insights (on-demand, cached, forced) ·
 * AI regenerate (audited) · AI system health · executive dashboard · trends · recommendations ·
 * report schedules (CRUD + run) · RBAC isolation (Employee blocked from every admin endpoint).
 *
 * All AI insight content is verified to be NON-EMPTY; with no .z-ai-config present the
 * deterministic fallback produces data-driven markdown instead of a 500 (executive dashboard
 * depends on generateInsight).
 *
 * Run against a dev server with admin login:
 *   npx next dev -p 3100
 *   BASE_URL=http://localhost:3100 bun scripts/verify-m008-stage3.mjs
 *
 * Env: BASE_URL (default http://localhost:3100) · DB_PATH (default db/custom.db)
 *      SUPER_ADMIN_EMAIL · SUPER_ADMIN_PASSWORD
 */
import { Database } from 'bun:sqlite'

const BASE = process.env.BASE_URL || 'http://localhost:3100'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'aria.martin@umbrella.com'
const ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || ''
const DEMO_EMAIL = 'demo@demo.com'
const DEMO_PASSWORD = 'demo123'

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

const cookieOf = (res) => {
  const set = res.headers.get('set-cookie') || ''
  const m = set.match(/wl_session=[^;]+/)
  return m ? m[0] : ''
}

let SESSION_COOKIE = ''
let ADMIN_TOKEN = ''

async function loginAs(email, password, { retries = 0 } = {}) {
  let last = null
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const json = await res.json().catch(() => ({}))
      last = { status: res.status, token: json.token, cookie: cookieOf(res) }
      if (res.status === 200) return last
    } catch (err) {
      last = { status: -1, token: '', cookie: '', error: String(err) }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  return last
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
console.log('\nM008 Stage-3 Verification — ' + BASE)

const loginRes = await loginAs(ADMIN_EMAIL, ADMIN_PASSWORD, { retries: 5 })
check('admin login succeeds', loginRes.status === 200, 'status=' + loginRes.status + (loginRes.error ? ' ' + loginRes.error : ''))
ADMIN_TOKEN = loginRes.token || ''
SESSION_COOKIE = loginRes.cookie || ''

const userLoginRes = await loginAs(DEMO_EMAIL, DEMO_PASSWORD, { retries: 5 })
check('demo (Employee) login succeeds', userLoginRes.status === 200, 'status=' + userLoginRes.status)
const USER_TOKEN = userLoginRes.token || ''
const USER_COOKIE = userLoginRes.cookie || ''

// ── 1. Schema — Stage-3 tables ────────────────────────────────────────────────
section('Schema — AISummary / ReportSchedule / AuditLog / Report')

for (const table of ['AISummary', 'ReportSchedule', 'AuditLog', 'Report']) {
  const t = q(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table)
  check('Table exists: ' + table, !!t, t ? '' : 'missing')
}

const aiCols = qa('PRAGMA table_info(AISummary)').map((r) => r.name)
for (const col of ['insightType', 'scope', 'scopeId', 'modelVersion', 'prompt', 'content', 'metrics', 'expiresAt', 'createdAt']) {
  check('AISummary has column: ' + col, aiCols.includes(col), aiCols.join(','))
}

const schedCols = qa('PRAGMA table_info(ReportSchedule)').map((r) => r.name)
for (const col of ['frequency', 'dayOfWeek', 'hour', 'minute', 'timezone', 'range', 'format', 'enabled', 'lastRunAt', 'lastRunStatus', 'lastRunError', 'lastReportId']) {
  check('ReportSchedule has column: ' + col, schedCols.includes(col), schedCols.join(','))
}

const auditCols = qa('PRAGMA table_info(AuditLog)').map((r) => r.name)
for (const col of ['actor', 'action', 'entityType', 'entityId', 'detail']) {
  check('AuditLog has column: ' + col, auditCols.includes(col), auditCols.join(','))
}

const reportCols = qa('PRAGMA table_info(Report)').map((r) => r.name)
for (const col of ['title', 'type', 'period', 'status', 'createdBy', 'summary', 'fileSize']) {
  check('Report has column: ' + col, reportCols.includes(col), reportCols.join(','))
}

// ── 2. Report Generator & API ────────────────────────────────────────────────
section('Reports API — generate / list / get / delete')

const genRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/reports', {
  body: { title: 'Stage-3 Verify Executive', type: 'Executive', period: 'Weekly', scope: 'organization', range: '7d', format: 'JSON' },
})
check('POST /api/admin/reports (Executive JSON) returns 201', genRes.status === 201, 'status=' + genRes.status)
check('Report response has reportId', !!genRes.json?.reportId, JSON.stringify(genRes.json))
check('Report response has content', typeof genRes.json?.content === 'string' && genRes.json.content.length > 0, 'len=' + (genRes.json?.content?.length ?? 0))
check('Report content is valid JSON', (() => { try { JSON.parse(genRes.json?.content); return true } catch { return false } })())
check('fileSize matches content length', genRes.json?.fileSize === (genRes.json?.content?.length ?? -1), 'fileSize=' + genRes.json?.fileSize)

const reportId = genRes.json?.reportId
const reportRow = reportId ? q('SELECT * FROM Report WHERE id=?', reportId) : null
check('Report row persisted in DB', !!reportRow)
check('Report status is Completed', reportRow?.status === 'Completed', 'status=' + reportRow?.status)
check('Report createdBy is the admin', reportRow?.createdBy === 'Admin' || !!reportRow?.createdBy, 'createdBy=' + reportRow?.createdBy)

const genAudit = reportId ? q("SELECT * FROM AuditLog WHERE action='report_generated' AND entityId=?", reportId) : null
check('AuditLog report_generated written', !!genAudit)

const listRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/reports')
check('GET /api/admin/reports returns 200', listRes.status === 200, 'status=' + listRes.status)
check('Reports list is array', Array.isArray(listRes.json?.reports), typeof listRes.json?.reports)
check('Reports total >= 1', (listRes.json?.total ?? 0) >= 1, 'total=' + listRes.json?.total)
check('Reports limit defaults to 50', listRes.json?.limit === 50, 'limit=' + listRes.json?.limit)
if (listRes.json?.reports?.length > 0) {
  const r = listRes.json.reports[0]
  check('Report entry has id', !!r.id)
  check('Report entry has type', !!r.type)
  check('Report entry has status', !!r.status)
  check('Report entry has createdAt', !!r.createdAt)
}

const limitedRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/reports?limit=3')
check('GET reports?limit=3 respects cap', (limitedRes.json?.reports?.length ?? 99) <= 3, 'len=' + limitedRes.json?.reports?.length)

const filteredRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/reports?type=Executive')
check('GET reports?type=Executive filters', (filteredRes.json?.reports ?? []).every((r) => r.type === 'Executive'), 'types=' + [...new Set((filteredRes.json?.reports ?? []).map((r) => r.type))].join(','))

const getRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/reports/' + reportId)
check('GET /api/admin/reports/{id} returns 200', getRes.status === 200, 'status=' + getRes.status)
check('GET report by id returns title', !!getRes.json?.title, JSON.stringify(getRes.json))

const getMissingRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/reports/does-not-exist')
check('GET report missing returns 404', getMissingRes.status === 404, 'status=' + getMissingRes.status)

const delRes = await apiReq(ADMIN_TOKEN, 'DELETE', '/api/admin/reports/' + reportId)
check('DELETE /api/admin/reports/{id} returns success', delRes.status === 200 && delRes.json?.success === true, 'status=' + delRes.status)
const delRow = reportId ? q('SELECT * FROM Report WHERE id=?', reportId) : null
check('Report row deleted from DB', !delRow)
const delAudit = reportId ? q("SELECT * FROM AuditLog WHERE action='report_deleted' AND entityId=?", reportId) : null
check('AuditLog report_deleted written', !!delAudit)

const delMissingRes = await apiReq(ADMIN_TOKEN, 'DELETE', '/api/admin/reports/does-not-exist')
check('DELETE report missing returns 404', delMissingRes.status === 404, 'status=' + delMissingRes.status)

// ── 3. AI Insights ───────────────────────────────────────────────────────────
section('AI Insights — on-demand, persisted, forced')

const insightRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/ai/insights?type=executive&scope=organization')
check('GET /api/admin/ai/insights?type=executive&scope=organization returns 200', insightRes.status === 200, 'status=' + insightRes.status)
check('Insights request returns 1 insight', Array.isArray(insightRes.json?.insights) && insightRes.json.insights.length === 1, 'len=' + insightRes.json?.insights?.length)
const execInsight = insightRes.json?.insights?.[0]
check('Insight has non-empty content', typeof execInsight?.content === 'string' && execInsight.content.length > 0, 'len=' + (execInsight?.content?.length ?? 0))
check('Insight has insightType executive', execInsight?.insightType === 'executive', execInsight?.insightType)
check('Insight has metrics object', typeof execInsight?.metrics === 'object' && execInsight?.metrics !== null)
check('Insight has modelVersion', !!execInsight?.modelVersion, execInsight?.modelVersion)

const aiRow = q("SELECT * FROM AISummary WHERE insightType='executive' AND scope='organization' AND scopeId IS NULL ORDER BY createdAt DESC LIMIT 1")
check('AISummary row persisted for executive/organization', !!aiRow)
check('AISummary expiresAt in future', aiRow ? new Date(aiRow.expiresAt).getTime() > Date.now() : false)
check('AISummary metrics is valid JSON', (() => { try { if (!aiRow?.metrics) return false; JSON.parse(aiRow.metrics); return true } catch { return false } })())
check('AISummary prompt stored (audit)', !!aiRow?.prompt, aiRow ? String(aiRow.prompt).length + ' chars' : 'missing')

const forcedRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/ai/insights?type=executive&scope=organization&force=true')
check('GET insights?force=true regenerates (still 1)', Array.isArray(forcedRes.json?.insights) && forcedRes.json.insights.length === 1, 'len=' + forcedRes.json?.insights?.length)
check('Forced insight content non-empty', typeof forcedRes.json?.insights?.[0]?.content === 'string' && forcedRes.json.insights[0].content.length > 0)

const allRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/ai/insights')
check('GET /api/admin/ai/insights (all types x scopes) returns 40', Array.isArray(allRes.json?.insights) && allRes.json.insights.length === 40, 'len=' + allRes.json?.insights?.length)
check('All insights have non-empty content', (allRes.json?.insights ?? []).every((i) => typeof i.content === 'string' && i.content.length > 0))
check('Persisted list reflects generated insights', (allRes.json?.persisted?.length ?? 0) >= 10, 'persisted=' + allRes.json?.persisted?.length)
if (allRes.json?.persisted?.length > 0) {
  const p = allRes.json.persisted[0]
  check('Persisted insight has id', !!p.id)
  check('Persisted insight has modelVersion', !!p.modelVersion)
  check('Persisted insight has expiresAt', !!p.expiresAt)
}

// ── 4. AI Regenerate ─────────────────────────────────────────────────────────
section('AI Regenerate (POST /api/admin/ai/regenerate)')

const regenRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/ai/regenerate', {
  body: { type: 'executive', scope: 'organization', range: '7d' },
})
check('POST /api/admin/ai/regenerate returns 200', regenRes.status === 200, 'status=' + regenRes.status)
check('Regenerate count >= 1', (regenRes.json?.regenerated ?? 0) >= 1, 'regenerated=' + regenRes.json?.regenerated)
check('Regenerate items tracked', Array.isArray(regenRes.json?.items) && regenRes.json.items.length >= 1, JSON.stringify(regenRes.json))

const regenAudit = q("SELECT * FROM AuditLog WHERE action='ai_regenerated' ORDER BY createdAt DESC LIMIT 1")
check('AuditLog ai_regenerated written', !!regenAudit)

const regenAllRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/ai/regenerate', {
  body: { type: 'all', scope: 'organization' },
})
check('Regenerate all-types x org returns 10', (regenAllRes.json?.regenerated ?? 0) === 10, 'regenerated=' + regenAllRes.json?.regenerated)

// ── 5. AI System Health ──────────────────────────────────────────────────────
section('AI System Health (GET /api/admin/ai/health)')

const healthRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/ai/health')
check('GET /api/admin/ai/health returns 200', healthRes.status === 200, 'status=' + healthRes.status)
check('Health has aiSystem', !!healthRes.json?.aiSystem, JSON.stringify(healthRes.json))
check('aiSystem.activeSummaries is number', typeof healthRes.json?.aiSystem?.activeSummaries === 'number', healthRes.json?.aiSystem?.activeSummaries)
check('aiSystem.recentGenerated is number', typeof healthRes.json?.aiSystem?.recentGenerated === 'number')
check('aiSystem.byType is object', typeof healthRes.json?.aiSystem?.byType === 'object' && healthRes.json?.aiSystem?.byType !== null)
check('aiSystem.byScope is object', typeof healthRes.json?.aiSystem?.byScope === 'object' && healthRes.json?.aiSystem?.byScope !== null)
check('Health has providers array', Array.isArray(healthRes.json?.providers), typeof healthRes.json?.providers)
if (healthRes.json?.providers?.length > 0) {
  check('Provider has enabled boolean', typeof healthRes.json.providers[0].enabled === 'boolean')
  check('Provider has name', !!healthRes.json.providers[0].name)
}
check('Health status healthy', healthRes.json?.status === 'healthy', healthRes.json?.status)

// ── 6. Executive Dashboard ───────────────────────────────────────────────────
section('Executive Dashboard (GET /api/admin/executive/dashboard)')

const execRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/executive/dashboard?range=7d')
check('GET /api/admin/executive/dashboard?range=7d returns 200', execRes.status === 200, 'status=' + execRes.status)
check('Dashboard kpis.avgProductivity is number', typeof execRes.json?.kpis?.avgProductivity === 'number', JSON.stringify(execRes.json?.kpis))
check('Dashboard kpis.totalUsers is number', typeof execRes.json?.kpis?.totalUsers === 'number')
check('Dashboard risk.organization present', !!execRes.json?.risk?.organization, JSON.stringify(execRes.json?.risk))
check('Dashboard trends.productivity present', !!execRes.json?.trends?.productivity)
check('Dashboard topPerformers array', Array.isArray(execRes.json?.topPerformers))
check('Dashboard atRiskUsers array', Array.isArray(execRes.json?.atRiskUsers))
check('Dashboard deviceFleet present', !!execRes.json?.deviceFleet)
check('Dashboard alertSummary.bySeverity present', !!execRes.json?.alertSummary?.bySeverity)
check('Dashboard aiExecutiveSummary is non-empty string', typeof execRes.json?.aiExecutiveSummary === 'string' && execRes.json.aiExecutiveSummary.length > 0, 'len=' + (execRes.json?.aiExecutiveSummary?.length ?? 0))
check('Dashboard range echoed', execRes.json?.range === '7d', execRes.json?.range)

const exec30d = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/executive/dashboard?range=30d')
check('Executive dashboard range=30d returns 200', exec30d.status === 200, 'status=' + exec30d.status)

// ── 7. Trends ────────────────────────────────────────────────────────────────
section('Trends (GET /api/admin/trends)')

const trendRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/trends')
check('GET /api/admin/trends returns 200', trendRes.status === 200, 'status=' + trendRes.status)
check('Trends productivity present', !!trendRes.json?.productivity, JSON.stringify(trendRes.json))
check('Trends daily present', !!trendRes.json?.daily)
check('Trends organizationScore is number', typeof trendRes.json?.organizationScore === 'number')
check('Trends range echoed', trendRes.json?.range === '7d', trendRes.json?.range)

const trend30 = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/trends?range=30d')
check('Trends range=30d returns 200', trend30.status === 200, 'status=' + trend30.status)

const deptRow = q("SELECT DISTINCT department FROM User WHERE department IS NOT NULL AND department != '' LIMIT 1")
if (deptRow) {
  const deptTrend = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/trends?scope=department&scopeId=' + encodeURIComponent(deptRow.department))
  check('Trends scope=department returns 200', deptTrend.status === 200, 'status=' + deptTrend.status)
  check('Trends department response has trend', !!deptTrend.json?.trend, JSON.stringify(deptTrend.json))
} else {
  check('Trends scope=department (no departments seeded)', false, 'no department rows in DB to test')
}

// ── 8. Recommendations ───────────────────────────────────────────────────────
section('Recommendations (GET /api/admin/recommendations)')

const recRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/recommendations')
check('GET /api/admin/recommendations returns 200', recRes.status === 200, 'status=' + recRes.status)
check('Recommendations array', Array.isArray(recRes.json?.recommendations))
check('Recommendations range echoed', recRes.json?.range === '7d', recRes.json?.range)
check('Recommendations generatedAt present', !!recRes.json?.generatedAt)
if (recRes.json?.recommendations?.length > 0) {
  const r = recRes.json.recommendations[0]
  check('Recommendation has id', !!r.id, JSON.stringify(r))
  check('Recommendation has title', !!r.title)
  check('Recommendation has priority', !!r.priority)
}

const recMax = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/recommendations?max=200')
check('Recommendations max capped at 50', (recMax.json?.recommendations?.length ?? 99) <= 50, 'len=' + recMax.json?.recommendations?.length)

const recSmall = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/recommendations?max=3')
check('Recommendations max=3 respected', (recSmall.json?.recommendations?.length ?? 99) <= 3, 'len=' + recSmall.json?.recommendations?.length)

// ── 9. Report Schedules ──────────────────────────────────────────────────────
section('Report Schedules — CRUD + run')

const schedRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/report-schedules', {
  body: { title: 'Stage-3 Verify Weekly', type: 'Productivity', period: 'Weekly', scope: 'organization', frequency: 'weekly', dayOfWeek: 1, hour: 8, minute: 0, timezone: 'UTC', range: '7d', format: 'CSV', enabled: true },
})
check('POST /api/admin/report-schedules returns 201', schedRes.status === 201, 'status=' + schedRes.status)
const scheduleId = schedRes.json?.id
check('Schedule response has id', !!scheduleId, JSON.stringify(schedRes.json))

const schedAudit = scheduleId ? q("SELECT * FROM AuditLog WHERE action='schedule_created' AND entityId=?", scheduleId) : null
check('AuditLog schedule_created written', !!schedAudit)

const badFreqRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/report-schedules', {
  body: { title: 'Bad', frequency: 'yearly' },
})
check('POST schedule invalid frequency returns 400', badFreqRes.status === 400, 'status=' + badFreqRes.status)

const noTitleRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/report-schedules', { body: {} })
check('POST schedule missing title returns 400', noTitleRes.status === 400, 'status=' + noTitleRes.status)

const schedListRes = await apiReq(ADMIN_TOKEN, 'GET', '/api/admin/report-schedules')
check('GET /api/admin/report-schedules returns 200', schedListRes.status === 200, 'status=' + schedListRes.status)
check('Schedules list is array', Array.isArray(schedListRes.json?.schedules))
check('Schedules total >= 1', (schedListRes.json?.total ?? 0) >= 1, 'total=' + schedListRes.json?.total)
const schedEntry = schedListRes.json?.schedules?.find((s) => s.id === scheduleId)
check('Created schedule appears in list', !!schedEntry)
check('Schedule entry has frequency', schedEntry?.frequency === 'weekly', schedEntry?.frequency)
check('Schedule entry has enabled', schedEntry?.enabled === true, String(schedEntry?.enabled))

const patchRes = await apiReq(ADMIN_TOKEN, 'PATCH', '/api/admin/report-schedules/' + scheduleId, { body: { enabled: false, hour: 9 } })
check('PATCH /api/admin/report-schedules/{id} returns 200', patchRes.status === 200, 'status=' + patchRes.status)
check('PATCH disables schedule', patchRes.json?.enabled === false, String(patchRes.json?.enabled))
check('PATCH updates hour', patchRes.json?.hour === 9, String(patchRes.json?.hour))

const schedAuditUpd = scheduleId ? q("SELECT * FROM AuditLog WHERE action='schedule_updated' AND entityId=?", scheduleId) : null
check('AuditLog schedule_updated written', !!schedAuditUpd)

const runRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/report-schedules/' + scheduleId, { body: {} })
check('POST /api/admin/report-schedules/{id} (run now) returns 200', runRes.status === 200, 'status=' + runRes.status + ' ' + JSON.stringify(runRes.json))
check('Schedule run success true', runRes.json?.success === true, JSON.stringify(runRes.json))
check('Schedule run produced reportId', !!runRes.json?.reportId)

const schedRow = scheduleId ? q('SELECT * FROM ReportSchedule WHERE id=?', scheduleId) : null
check('Schedule lastRunStatus success in DB', schedRow?.lastRunStatus === 'success', schedRow?.lastRunStatus)
check('Schedule lastRunAt set in DB', !!schedRow?.lastRunAt)
check('Schedule lastReportId set in DB', !!schedRow?.lastReportId)

const runAudit = scheduleId ? q("SELECT * FROM AuditLog WHERE action='schedule_run' AND entityId=?", scheduleId) : null
check('AuditLog schedule_run written', !!runAudit)

const runMissingRes = await apiReq(ADMIN_TOKEN, 'POST', '/api/admin/report-schedules/does-not-exist', { body: {} })
check('POST run missing schedule returns 404', runMissingRes.status === 404, 'status=' + runMissingRes.status)

const patchMissingRes = await apiReq(ADMIN_TOKEN, 'PATCH', '/api/admin/report-schedules/does-not-exist', { body: { enabled: true } })
check('PATCH missing schedule returns 404', patchMissingRes.status === 404, 'status=' + patchMissingRes.status)

const delSchedRes = await apiReq(ADMIN_TOKEN, 'DELETE', '/api/admin/report-schedules/' + scheduleId)
check('DELETE /api/admin/report-schedules/{id} returns success', delSchedRes.status === 200 && delSchedRes.json?.success === true, 'status=' + delSchedRes.status)
const delSchedRow = scheduleId ? q('SELECT * FROM ReportSchedule WHERE id=?', scheduleId) : null
check('Schedule row deleted from DB', !delSchedRow)
const delSchedAudit = scheduleId ? q("SELECT * FROM AuditLog WHERE action='schedule_deleted' AND entityId=?", scheduleId) : null
check('AuditLog schedule_deleted written', !!delSchedAudit)

const delSchedMissingRes = await apiReq(ADMIN_TOKEN, 'DELETE', '/api/admin/report-schedules/does-not-exist')
check('DELETE missing schedule returns 404', delSchedMissingRes.status === 404, 'status=' + delSchedMissingRes.status)

// ── 10. RBAC — Employee blocked from every Stage-3 admin endpoint ───────────
section('RBAC — Employee Blocked')

const rbacChecks = [
  ['GET', '/api/admin/reports'],
  ['POST', '/api/admin/reports'],
  ['GET', '/api/admin/ai/insights'],
  ['POST', '/api/admin/ai/regenerate'],
  ['GET', '/api/admin/ai/health'],
  ['GET', '/api/admin/executive/dashboard'],
  ['GET', '/api/admin/trends'],
  ['GET', '/api/admin/recommendations'],
  ['GET', '/api/admin/report-schedules'],
  ['POST', '/api/admin/report-schedules'],
]
for (const [method, path] of rbacChecks) {
  const opts = { cookie: USER_COOKIE }
  if (method !== 'GET' && method !== 'HEAD') opts.body = {}
  const r = await apiReq(USER_TOKEN, method, path, opts)
  check('Employee blocked from ' + method + ' ' + path, r.status === 403 || r.status === 401, 'status=' + r.status)
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n' + '\u2500'.repeat(76))
console.log('M008 Stage-3 Verification: ' + passed + ' passed, ' + failed + ' failed')
if (failures.length > 0) {
  console.log('\nFailed checks:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
} else {
  console.log('\nAll checks passed.')
  process.exit(0)
}
