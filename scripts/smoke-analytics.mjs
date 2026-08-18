// M008 Stage-1 smoke test — live endpoints + direct DB rollup verification.
// Usage: BASE_URL=http://localhost:3000 bun scripts/smoke-analytics.mjs
const BASE = process.env.BASE_URL || 'http://localhost:3000'
const EMAIL = 'aria.martin@umbrella.com'
const PASSWORD = '123456'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fail++; console.log(`  ✘ ${name} ${extra}`) }
}

// 1. Login → session cookie
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
const setCookie = login.headers.get('set-cookie')
ok('admin login 200', login.status === 200, `got ${login.status}`)
const cookie = setCookie ? setCookie.split(';')[0] : ''
ok('session cookie set', cookie.length > 0)

const jget = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

console.log('\n— /api/dashboard —')
const dash = await jget('/api/dashboard?range=7d')
ok('dashboard 200', dash.status === 200, `got ${dash.status}`)
ok('dashboard has kpis', dash.body.kpis && typeof dash.body.kpis === 'object')
ok('kpis avgProductivity number', typeof dash.body.kpis?.avgProductivity === 'number')
ok('departments array', Array.isArray(dash.body.departments))
ok('trend array', Array.isArray(dash.body.trend))
ok('topApps array', Array.isArray(dash.body.topApps))
ok('deviceStatuses array', Array.isArray(dash.body.deviceStatuses))

console.log('\n— /api/dashboard/activity —')
const act = await jget('/api/dashboard/activity?range=7d')
ok('activity 200', act.status === 200)
ok('activity active.minutes >= 0', typeof act.body.active?.minutes === 'number' && act.body.active.minutes >= 0)
ok('activity topApplications array', Array.isArray(act.body.topApplications))
ok('activity heatmap 24 buckets', Array.isArray(act.body.heatmap) && act.body.heatmap.length === 24)

console.log('\n— /api/dashboard/productivity —')
const prod = await jget('/api/dashboard/productivity?range=7d')
ok('productivity 200', prod.status === 200)
ok('productivity trend array', Array.isArray(prod.body.trend))
ok('productivity averages object', prod.body.averages && typeof prod.body.averages.productivity === 'number')
ok('productivity departments array', Array.isArray(prod.body.departments))

console.log('\n— /api/dashboard/devices —')
const dev = await jget('/api/dashboard/devices?range=7d')
ok('devices 200', dev.status === 200)
ok('devices summary.total number', typeof dev.body.summary?.total === 'number')
ok('devices list array', Array.isArray(dev.body.devices))
ok('devices healthAlerts object', dev.body.healthAlerts && typeof dev.body.healthAlerts.total === 'number')

console.log('\n— /api/dashboard/timeline —')
const tl = await jget('/api/dashboard/timeline?limit=20')
ok('timeline 200', tl.status === 200)
ok('timeline items array', Array.isArray(tl.body.items))
ok('timeline hasMore boolean', typeof tl.body.hasMore === 'boolean')
if (tl.body.items?.length) {
  const kinds = new Set(tl.body.items.map((i) => i.kind))
  console.log(`  timeline kinds: ${[...kinds].join(', ')}`)
  ok('timeline item has ts', typeof tl.body.items[0].ts === 'number')
  const next = tl.body.nextCursor
  if (next) {
    const tl2 = await jget(`/api/dashboard/timeline?limit=20&cursor=${encodeURIComponent(next)}`)
    ok('timeline cursor page 200', tl2.status === 200)
    ok('timeline cursor page items', Array.isArray(tl2.body.items))
  }
}

console.log('\n— /api/dashboard/heatmap —')
const hm = await jget('/api/dashboard/heatmap?range=7d')
ok('heatmap 200', hm.status === 200)
ok('heatmap hourly 24', Array.isArray(hm.body.hourly) && hm.body.hourly.length === 24)
ok('heatmap weekday 7', Array.isArray(hm.body.weekday) && hm.body.weekday.length === 7)
ok('heatmap application array', Array.isArray(hm.body.application))
ok('heatmap website array', Array.isArray(hm.body.website))

console.log('\n— /api/analytics —')
const an = await jget('/api/analytics?range=7d')
ok('analytics 200', an.status === 200)
ok('analytics weeklyTrend array', Array.isArray(an.body.weeklyTrend))
ok('analytics topUsers array', Array.isArray(an.body.topUsers))
ok('analytics radar array', Array.isArray(an.body.radar))
ok('analytics totalActivities number', typeof an.body.totalActivities === 'number')

console.log('\n— /api/timeline (legacy) —')
const lt = await jget('/api/timeline')
ok('legacy timeline 200', lt.status === 200)
ok('legacy sparkline array', Array.isArray(lt.body.sparkline))
ok('legacy live object', lt.body.live && typeof lt.body.live.activeUsers === 'number')

console.log('\n— no-auth —')
const na = await fetch(`${BASE}/api/dashboard`, {})
ok('dashboard without auth 401', na.status === 401, `got ${na.status}`)
const na2 = await fetch(`${BASE}/api/dashboard/timeline`, {})
ok('timeline without auth 401', na2.status === 401, `got ${na2.status}`)

console.log(`\nSMOKE RESULT: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
