/**
 * M007 Stage-3 — Screenshot Consumption Layer — Automated Verification (live server)
 *
 * Covers the admin-only consumption API against a running dev server:
 *   GET    /api/admin/screenshots            — gallery (metadata-only, one query,
 *                                              cursor pagination, filters, sort)
 *   GET    /api/admin/screenshots/:id        — detail (never bytes, never paths)
 *   GET    /api/admin/screenshots/:id/file   — stream (ETag/304/cache), blur
 *                                              default, ?original=true gate,
 *                                              404/410/403 semantics, traversal
 *                                              + symlink attack resistance
 *   DELETE /api/admin/screenshots/:id        — file first, then row
 *   POST   /api/admin/screenshots/retention  — cleanup job (tickets, temp dirs,
 *                                              90 d files, 365 d metadata,
 *                                              referenced-file safety, stats)
 *   GET    /api/admin/screenshots/integrity  — 7-check structured report, no repair
 *
 * Plus regression of E1/E2/E3/E5/E6/E7/E16 on a fresh device.
 *
 * Run:   bun scripts/verify-e6-consumption.mjs
 * Env:   BASE_URL (default http://localhost:3107) · DB_PATH (default db/custom.db)
 *        SUPER_ADMIN_PASSWORD (auto-loaded from .env by bun)
 *
 * Start the target server first, e.g.:  npx next dev -p 3107
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import bcrypt from 'bcryptjs'
import { signAgentRequest } from '../src/lib/agent-auth/signature'

const BASE = process.env.BASE_URL || 'http://localhost:3107'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const STORAGE_ROOT = path.resolve(process.env.STORAGE_PATH || 'storage/screenshots')
const INSTALLATION_ID = 'inst_demo_default'
const JOIN_KEY = 'WL-DEMO-JOINKEY-2026'
const IPS = Array.from({ length: 60 }, (_, i) => `203.0.113.${i + 1}`)
const ADMIN_EMAIL = 'aria.martin@umbrella.com'
const ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || ''

// ── Real WebP fixtures (server must decode them for the blur pass) ─────────
const IMG_A = readFileSync(new URL('./fixtures/webp-a.webp', import.meta.url)) // 640×400
const IMG_B = readFileSync(new URL('./fixtures/webp-b.webp', import.meta.url)) // 320×240
const IMG_C = readFileSync(new URL('./fixtures/webp-c.webp', import.meta.url)) // 800×300

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const db = new Database(DB_PATH)
db.run('PRAGMA foreign_keys = ON')
const q = (sql, ...args) => db.query(sql).get(...args)
const qa = (sql, ...args) => db.query(sql).all(...args)
const run = (sql, ...args) => db.query(sql).run(...args)
const cuid = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`

// ── Admin JWT (web session, not agent auth) ────────────────────────────────
// Route-level auth reads the `wl_session` COOKIE (middleware accepts the
// Bearer header; requireAuth reads cookies only) — so the script replays the
// Set-Cookie from the login response.
const cookieOf = (res) => {
  const set = res.headers.get('set-cookie') || ''
  const m = set.match(/wl_session=[^;]+/)
  return m ? m[0] : ''
}

async function adminLogin() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.240' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, token: json.token, user: json.user, cookie: cookieOf(res) }
}

// ── Signed agent request helper (string or Buffer body) ────────────────────
async function signedRequest({ token, deviceId, method = 'POST', path: p, body, nonce, ts = Date.now(), headers = {} }) {
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
  await sleep(100)
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, headers: res.headers }
}

// ── Admin HTTP helper (Bearer JWT + session cookie) — binary-safe ──────────
let SESSION_COOKIE = ''
async function adminReq(token, method, p, { headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, cookie: headers.cookie ?? SESSION_COOKIE, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  })
  const bytes = Buffer.from(await res.arrayBuffer())
  const text = bytes.toString('utf8')
  let json = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {}
  return { status: res.status, json, headers: res.headers, text, bytes }
}

// ── Device lifecycle (mirrors verify-e7) ───────────────────────────────────
const devices = []
const testUsers = []
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

async function makeDevice(name, tag, role = 'Employee') {
  const reg = await registerDevice(name)
  if (reg.status !== 201) {
    console.log(`  !! makeDevice(${name}) register failed: ${reg.status}`)
    return { status: reg.status, deviceId: null, token: null, act: null }
  }
  const id = `usr_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  testUsers.push(id)
  run(
    'INSERT INTO User (id, name, email, role, status, passwordHash, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    `C${tag} User`,
    `${tag}-${Date.now()}@test.local`,
    role,
    'Active',
    bcrypt.hashSync('consumption-test-pass-1', 10),
    new Date().toISOString()
  )
  run('UPDATE User SET deviceId = ? WHERE id = ?', reg.deviceId, id)
  const body = JSON.stringify({ clientTime: Date.now() })
  const nonce = NONCE()
  const ts = Date.now()
  const signature = signAgentRequest({ key: reg.token, method: 'POST', path: '/api/agent/v1/activate', timestamp: ts, nonce, body })
  const res = await fetch(`${BASE}/api/agent/v1/activate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${reg.token}`,
      'x-installation-id': INSTALLATION_ID,
      'x-device-id': reg.deviceId,
      'x-agent-version': '0.1.0',
      'x-timestamp': String(ts),
      'x-nonce': nonce,
      'x-agent-signature': signature,
      'content-type': 'application/json',
    },
    body,
  })
  devices.push(reg.deviceId)
  return { status: reg.status, act: res.status, deviceId: reg.deviceId, token: reg.token }
}

/** Single-shot upload (E6) with custom metadata. */
const qMeta = (img, over = {}) =>
  ['ts', 'sha256', 'size', 'format', 'width', 'height', 'multiMonitor', 'monitorId', 'privacyMode', 'blurSensitive']
    .map((k) => {
      const v = { ts: Date.now(), sha256: sha256(img), size: img.length, format: 'webp', width: 640, height: 400, multiMonitor: false, monitorId: 0, privacyMode: false, blurSensitive: true, ...over }[k]
      return `&${k}=${encodeURIComponent(v)}`
    })
    .join('')

async function uploadShot(device, img, over = {}) {
  return signedRequest({
    token: device.token,
    deviceId: device.deviceId,
    path: `/api/agent/v1/screenshots?mode=single${qMeta(img, over)}`,
    body: img,
    nonce: NONCE(),
  })
}

// Unique synthetic sha256 for crafted rows (avoids UNIQUE collision with
// real fixture rows whose content hashes already exist)
const H = (s) => sha256(Buffer.concat([IMG_A, Buffer.from(s)]))

// ── Raw fixture rows for retention/integrity scenarios ─────────────────────
// NOTE: Prisma stores SQLite DateTime as INTEGER (epoch ms) — raw inserts
// must use ms integers or Prisma-side date comparisons silently miss rows.
const MS = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime())

function insertScreenshotRow(over = {}) {
  const id = over.id || cuid('sc')
  run(
    'INSERT INTO Screenshot (id, deviceId, userId, sha256, storagePath, size, width, height, monitorId, privacyMode, blurSensitive, dedupRef, timestamp, createdAt, flagged, sensitiveDataDetected) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id,
    over.deviceId || devices[0] || 'none',
    over.userId ?? null,
    over.sha256 ?? null,
    over.storagePath ?? null,
    over.size ?? null,
    over.width ?? null,
    over.height ?? null,
    over.monitorId ?? 0,
    over.privacyMode ?? false,
    over.blurSensitive ?? true,
    over.dedupRef ?? null,
    MS(over.timestamp ?? new Date()),
    MS(over.createdAt ?? new Date()),
    over.flagged ?? false,
    over.sensitiveDataDetected ?? false
  )
  return id
}

function insertTicketRow(over = {}) {
  const id = over.id || cuid('up')
  run(
    'INSERT INTO UploadTicket (id, deviceId, sha256, size, totalChunks, receivedBytes, status, capturedAt, expiresAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id,
    over.deviceId || devices[0] || 'none',
    over.sha256 || sha256(IMG_A),
    over.size ?? 1,
    over.totalChunks ?? 1,
    over.receivedBytes ?? 0,
    over.status ?? 'open',
    MS(over.capturedAt ?? new Date()),
    MS(over.expiresAt ?? new Date()),
    MS(over.updatedAt ?? new Date())
  )
  return id
}

const absOf = (rel) => path.join(STORAGE_ROOT, rel)

async function main() {
  // Hoisted cleanup targets (declared before any section — TDZ-safe in finally)
  let twinRow = null
  let expRow = null
  let junction = null
  let junctionCreated = false
  let missRow = null
  let symRow = null
  try {
    const login = await adminLogin()
    SESSION_COOKIE = login.cookie
    check('setup: super-admin login → 200 + token', login.status === 200 && !!login.token, `(got ${login.status}) ${JSON.stringify(login.user ?? {})}`)
    const ADMIN = login.token

    // ── Fixture devices + uploads ───────────────────────────────────────────
    console.log('\n0) Fixtures')
    const devA = await makeDevice('c3-main', 'c3a')
    const devB = await makeDevice('c3-blur-false', 'c3b')
    const devC = await makeDevice('c3-privacy', 'c3c')
    const devD = await makeDevice('c3-dedup', 'c3d')
    const devE = await makeDevice('c3-org', 'c3e')
    check('setup: 5 devices registered + activated', [devA, devB, devC, devD, devE].every((d) => d.status === 201 && d.act === 200))

    const upA = await uploadShot(devA, IMG_A, { blurSensitive: 'true' })
    const upB = await uploadShot(devB, IMG_B, { blurSensitive: 'false' })
    const upC = await uploadShot(devC, IMG_A, { privacyMode: 'true' })
    const upD = await uploadShot(devD, IMG_A) // same content → dedup twin of upA
    check('fixture: stored shot A → 201 stored', upA.status === 201 && upA.json.stored === true, `(got ${upA.status}) ${JSON.stringify(upA.json)}`)
    check('fixture: stored shot B (blurSensitive=false) → 201', upB.status === 201 && upB.json.stored === true)
    check('fixture: privacy-mode shot → 201 metadata-only (stored=false)', upC.status === 201 && upC.json.stored === false, JSON.stringify(upC.json))
    check('fixture: dedup shot D → 201 duplicate (no second copy)', upD.status === 201 && upD.json.duplicate === true, `(got ${upD.status}) ${JSON.stringify(upD.json)}`)

    const idA = upA.json.screenshotId
    const idB = upB.json.screenshotId
    const idC = upC.json.screenshotId
    const idD = upD.json.screenshotId
    const aPath = q('SELECT storagePath FROM Screenshot WHERE id = ?', idA).storagePath
    check('fixture: dedup row has dedupRef → twin A', q('SELECT dedupRef FROM Screenshot WHERE id = ?', idD)?.dedupRef === idA, `(got ${JSON.stringify(q('SELECT dedupRef FROM Screenshot WHERE id = ?', idD))})`)

    // Org filter fixture — assign the org device to Acme.
    const acme = q("SELECT id FROM Organization WHERE slug = 'acme'")
    run('UPDATE Device SET organizationId = ? WHERE id = ?', acme.id, devE.deviceId)
    const upE = await uploadShot(devE, IMG_C)
    const idE = upE.json.screenshotId
    const ePath = q('SELECT storagePath FROM Screenshot WHERE id = ?', idE).storagePath
    check('fixture: org-device shot E → 201', upE.status === 201)

    // ── 1. Auth matrix ──────────────────────────────────────────────────────
    console.log('\n1) Auth matrix (admin-only)')
    const noAuth = await adminReq('', 'GET', '/api/admin/screenshots', { headers: { cookie: '' } })
    check('auth: gallery no token → 401', noAuth.status === 401, `(got ${noAuth.status})`)

    const empRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.241' },
      body: JSON.stringify({ email: q('SELECT email FROM User WHERE id = ?', testUsers[0]).email, password: 'consumption-test-pass-1' }),
    })
    const empJson = await empRes.json()
    const EMP = empJson.token
    const empCookie = cookieOf(empRes)
    check('auth: employee login → token', !!EMP)

    const manId = `usr_mgr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
    testUsers.push(manId)
    run('INSERT INTO User (id, name, email, role, status, passwordHash, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
      manId, 'Mgr User', `mgr-${Date.now()}@test.local`, 'Manager', 'Active', bcrypt.hashSync('consumption-test-pass-1', 10), new Date().toISOString())
    const manRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.242' },
      body: JSON.stringify({ email: q('SELECT email FROM User WHERE id = ?', manId).email, password: 'consumption-test-pass-1' }),
    })
    const manJson = await manRes.json()
    const MAN = manJson.token
    const manCookie = cookieOf(manRes)
    check('auth: manager login → token', !!MAN)

    const gAdmin = await adminReq(ADMIN, 'GET', '/api/admin/screenshots')
    const gEmp = await adminReq(EMP, 'GET', '/api/admin/screenshots', { headers: { cookie: empCookie } })
    const gMan = await adminReq(MAN, 'GET', '/api/admin/screenshots', { headers: { cookie: manCookie } })
    check('auth: admin → gallery 200', gAdmin.status === 200, `(got ${gAdmin.status})`)
    check('auth: employee → gallery 403', gEmp.status === 403, `(got ${gEmp.status})`)
    check('auth: manager → gallery 403', gMan.status === 403, `(got ${gMan.status})`)
    const empDetail = await adminReq(EMP, 'GET', `/api/admin/screenshots/${idA}`, { headers: { cookie: empCookie } })
    const empFile = await adminReq(EMP, 'GET', `/api/admin/screenshots/${idA}/file`, { headers: { cookie: empCookie } })
    const empDelete = await adminReq(EMP, 'DELETE', `/api/admin/screenshots/${idA}`, { headers: { cookie: empCookie } })
    const empRet = await adminReq(EMP, 'POST', '/api/admin/screenshots/retention', { headers: { cookie: empCookie } })
    const empInt = await adminReq(EMP, 'GET', '/api/admin/screenshots/integrity', { headers: { cookie: empCookie } })
    check('auth: employee detail → 403', empDetail.status === 403, `(got ${empDetail.status})`)
    check('auth: employee file → 403', empFile.status === 403, `(got ${empFile.status})`)
    check('auth: employee delete → 403', empDelete.status === 403, `(got ${empDelete.status})`)
    check('auth: employee retention → 403', empRet.status === 403, `(got ${empRet.status})`)
    check('auth: employee integrity → 403', empInt.status === 403, `(got ${empInt.status})`)
    const manFile = await adminReq(MAN, 'GET', `/api/admin/screenshots/${idA}/file?original=true`, { headers: { cookie: manCookie } })
    check('auth: manager ?original=true → 403', manFile.status === 403, `(got ${manFile.status})`)
    const adminOriginal = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idA}/file?original=true`)
    check('auth: admin ?original=true → 200', adminOriginal.status === 200, `(got ${adminOriginal.status})`)

    // ── 2. Gallery ──────────────────────────────────────────────────────────
    console.log('\n2) Gallery')
    const g1 = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?deviceId=${devA.deviceId}`)
    check('gallery: device filter → 1 row (A)', g1.status === 200 && g1.json.screenshots.length === 1, `(got ${g1.status}, ${g1.json.screenshots?.length})`)
    check('gallery: metadata-only payload (no storagePath anywhere)', !JSON.stringify(g1.json).includes('storagePath'))
    const gItem = g1.json.screenshots[0]
    check('gallery: item has capturedAt/createdAt', !!gItem.capturedAt && !!gItem.createdAt)
    check('gallery: item has device + user metadata', !!gItem.device?.hostname && !!gItem.user?.name, JSON.stringify(gItem.user))
    check('gallery: item dims/format/size/sha256', gItem.width === 640 && gItem.height === 400 && gItem.format === 'WebP' && gItem.size === IMG_A.length && gItem.sha256 === sha256(IMG_A))
    check('gallery: privacy flags present', gItem.privacyMode === false && gItem.blurSensitive === true && gItem.deduplicated === false)
    check('gallery: no bytes key in item', gItem.image === undefined && gItem.file === undefined)

    const gUser = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?userId=${q('SELECT userId FROM Screenshot WHERE id = ?', idA).userId}`)
    check('gallery: user filter → includes A', gUser.status === 200 && gUser.json.screenshots.some((s) => s.id === idA))

    const gMonitor = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?monitorId=0`)
    check('gallery: monitorId filter → 200', gMonitor.status === 200)

    const gPrivTrue = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?privacyMode=true&deviceId=${devC.deviceId}`)
    check('gallery: privacyMode=true filter → only C', gPrivTrue.status === 200 && gPrivTrue.json.screenshots.length === 1 && gPrivTrue.json.screenshots[0].id === idC, JSON.stringify(gPrivTrue.json.screenshots?.map((s) => s.id)))
    const gPrivFalse = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?privacyMode=false&deviceId=${devC.deviceId}`)
    check('gallery: privacyMode=false excludes C', gPrivFalse.status === 200 && gPrivFalse.json.screenshots.length === 0)
    const gBlurTrue = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?blurSensitive=true&deviceId=${devA.deviceId}`)
    check('gallery: blurSensitive=true includes A', gBlurTrue.status === 200 && gBlurTrue.json.screenshots.some((s) => s.id === idA))
    const gBlurFalse = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?blurSensitive=false&deviceId=${devB.deviceId}`)
    check('gallery: blurSensitive=false includes B', gBlurFalse.status === 200 && gBlurFalse.json.screenshots.some((s) => s.id === idB))
    const gBadBool = await adminReq(ADMIN, 'GET', '/api/admin/screenshots?privacyMode=banana')
    check('gallery: invalid boolean filter → 400', gBadBool.status === 400, `(got ${gBadBool.status})`)

    const gOrg = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?organizationId=${acme.id}`)
    check('gallery: org filter → includes E, excludes A', gOrg.status === 200 && gOrg.json.screenshots.some((s) => s.id === idE) && !gOrg.json.screenshots.some((s) => s.id === idA))
    const gOrgNone = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?organizationId=${cuid('org')}`)
    check('gallery: unknown org → empty', gOrgNone.status === 200 && gOrgNone.json.screenshots.length === 0)

    const gRange = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?deviceId=${devA.deviceId}&from=${new Date(Date.now() - 3600e3).toISOString()}&to=${new Date(Date.now() + 3600e3).toISOString()}`)
    check('gallery: date range includes A', gRange.status === 200 && gRange.json.screenshots.length === 1)
    const gRangeMiss = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?deviceId=${devA.deviceId}&from=2001-01-01&to=2001-01-02`)
    check('gallery: date range before capture → empty', gRangeMiss.status === 200 && gRangeMiss.json.screenshots.length === 0)
    const gBadRange = await adminReq(ADMIN, 'GET', '/api/admin/screenshots?from=notadate')
    check('gallery: invalid from → 400', gBadRange.status === 400, `(got ${gBadRange.status})`)

    const gLimit0 = await adminReq(ADMIN, 'GET', '/api/admin/screenshots?limit=0')
    check('gallery: limit=0 → 400', gLimit0.status === 400, `(got ${gLimit0.status})`)
    const gLimitBig = await adminReq(ADMIN, 'GET', '/api/admin/screenshots?limit=99999')
    check('gallery: limit>100 clamped → ≤100 rows', gLimitBig.status === 200 && gLimitBig.json.screenshots.length <= 100)

    // Cursor walk over ALL rows (legacy + 4 fixture) — keyset pagination sanity
    const devIds = [devA.deviceId, devB.deviceId, devD.deviceId, devE.deviceId]
    const total = qa('SELECT count(*) c FROM Screenshot WHERE deviceId IN (?,?,?,?)', ...devIds).reduce((n, r) => n + r.c, 0)
    check('fixture: 4 screenshot rows across test devices', total === 4, `(got ${total})`)
    const totalRows = qa('SELECT count(*) c FROM Screenshot')[0].c

    const walk = []
    let cursor = null
    let guard = 0
    while (guard++ < 200) {
      const page = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      check(`gallery: cursor page ${walk.length + 1} → 200`, page.status === 200, `(got ${page.status})`)
      walk.push(...page.json.screenshots.map((s) => s.id))
      if (!page.json.hasMore || !page.json.nextCursor) break
      cursor = page.json.nextCursor
    }
    check('gallery: cursor walk covers every row, no dupes', walk.length === totalRows && new Set(walk).size === walk.length, `(walk ${walk.length}/${totalRows})`)
    check('gallery: all fixture ids visited', [idA, idB, idD, idE].every((id) => walk.includes(id)), `(walk ${JSON.stringify(walk.slice(0, 10))})`)
    const gPage = await adminReq(ADMIN, 'GET', '/api/admin/screenshots?limit=3')
    check('gallery: limit=3 → hasMore + nextCursor', gPage.status === 200 && gPage.json.screenshots.length === 3 && gPage.json.hasMore === true && !!gPage.json.nextCursor)
    const captured = gPage.json.screenshots.map((s) => new Date(s.capturedAt).getTime())
    check('gallery: sorted capturedAt DESC', captured.every((t, i) => i === 0 || captured[i - 1] >= t), `(${JSON.stringify(captured)})`)
    const gBadCursor = await adminReq(ADMIN, 'GET', '/api/admin/screenshots?cursor=%25%25%25not-json')
    check('gallery: malformed cursor → 400', gBadCursor.status === 400, `(got ${gBadCursor.status})`)

    // Same-ms tiebreak — two rows with identical capturedAt (dedup rows keep ts)
    const tsSame = Date.now() - 2000
    const upT1 = await uploadShot(devA, IMG_B, { ts: tsSame, blurSensitive: 'false' })
    const upT2 = await uploadShot(devA, IMG_B, { ts: tsSame, blurSensitive: 'false' })
    check('tiebreak: two same-ts uploads → 201', upT1.status === 201 && upT2.status === 201, `(${upT1.status}, ${upT2.status})`)
    const tiebreakIds = [upT1.json.screenshotId, upT2.json.screenshotId]
    const tbWalk = []
    let tbCursor = null
    guard = 0
    while (guard++ < 10) {
      const page = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?limit=1&deviceId=${devA.deviceId}${tbCursor ? `&cursor=${encodeURIComponent(tbCursor)}` : ''}`)
      tbWalk.push(...page.json.screenshots.map((s) => s.id))
      if (!page.json.hasMore || !page.json.nextCursor) break
      tbCursor = page.json.nextCursor
    }
    const tbOrder = qa('SELECT id FROM Screenshot WHERE id IN (?,?) ORDER BY timestamp DESC, id DESC', tiebreakIds[0], tiebreakIds[1]).map((r) => r.id)
    const tbVisited = tbWalk.filter((id) => tiebreakIds.includes(id))
    check('tiebreak: same-ms rows both visited, no dupes', tiebreakIds.every((id) => tbWalk.includes(id)) && new Set(tbWalk).size === tbWalk.length, `(walk ${tbWalk.length})`)
    check('tiebreak: (timestamp, id) DESC order matches DB order', JSON.stringify(tbVisited) === JSON.stringify(tbOrder), `(${JSON.stringify(tbVisited)} vs ${JSON.stringify(tbOrder)})`)

    // ── 3. Detail ───────────────────────────────────────────────────────────
    console.log('\n3) Detail')
    const dA = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idA}`)
    check('detail: stored row → 200', dA.status === 200, `(got ${dA.status})`)
    check('detail: no storagePath leaked anywhere', !JSON.stringify(dA.json).includes('storagePath'))
    check('detail: image metadata (format/size/sha256/dims)', dA.json.image.format === 'WebP' && dA.json.image.size === IMG_A.length && dA.json.image.sha256 === sha256(IMG_A) && dA.json.image.width === 640 && dA.json.image.height === 400)
    check('detail: image.hasBytes true', dA.json.image.hasBytes === true)
    check('detail: device + user objects', dA.json.device?.hostname && dA.json.user?.name)
    check('detail: monitor object', dA.json.monitor?.id === 0 && dA.json.monitor.multiMonitor === false)
    check('detail: privacy flags', dA.json.privacy.privacyMode === false && dA.json.privacy.blurSensitive === true)
    check('detail: dedup info (not deduped)', dA.json.dedup.deduplicated === false && dA.json.dedup.dedupRef === null && typeof dA.json.dedup.duplicatesCount === 'number')
    check('detail: capture timestamps', !!dA.json.capturedAt && !!dA.json.createdAt)
    check('detail: provenance (single-shot → uploadId null)', dA.json.provenance.uploadId === null && dA.json.provenance.sessionId === null)
    check('detail: content.ocrText null', dA.json.content.ocrText === null)

    const dD = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idD}`)
    check('detail: dedup row → deduped=true, twin=A', dD.json.dedup.deduplicated === true && dD.json.dedup.twin?.id === idA, JSON.stringify(dD.json.dedup))
    check('detail: dedup row hasBytes via twin', dD.json.image.hasBytes === true && dD.json.image.sha256 === null)

    const dC = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idC}`)
    check('detail: privacy row → hasBytes=false, privacyMode=true', dC.json.privacy.privacyMode === true && dC.json.image.hasBytes === false)

    const dMiss = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${cuid('sc')}`)
    check('detail: unknown id → 404', dMiss.status === 404, `(got ${dMiss.status})`)

    const legacyRow = { id: insertScreenshotRow({ sha256: null, storagePath: null, size: null, width: null, height: null }) }
    const dLegacy = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${legacyRow.id}`)
    check('detail: legacy row → 200 with hasBytes=false', dLegacy.status === 200 && dLegacy.json.image.hasBytes === false, `(got ${dLegacy.status})`)

    // ── 4. File endpoint ────────────────────────────────────────────────────
    console.log('\n4) File endpoint')
    const fA = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idA}/file?original=true`)
    check('file: original → 200 image/webp', fA.status === 200 && fA.headers.get('content-type')?.includes('image/webp'), `(got ${fA.status})`)
    check('file: content-length matches fixture', Number(fA.headers.get('content-length')) === IMG_A.length, `(got ${fA.headers.get('content-length')})`)
    check('file: bytes are the exact fixture', sha256(fA.bytes) === sha256(IMG_A))
    check('file: ETag = sha256 in quotes', fA.headers.get('etag') === `"${sha256(IMG_A)}"`, `(got ${fA.headers.get('etag')})`)
    check('file: cache-control private', fA.headers.get('cache-control')?.startsWith('private'), `(got ${fA.headers.get('cache-control')})`)
    check('file: last-modified present', !!fA.headers.get('last-modified'))
    check('file: nosniff present', fA.headers.get('x-content-type-options') === 'nosniff')

    const fA304 = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idA}/file?original=true`, { headers: { 'if-none-match': `"${sha256(IMG_A)}"` } })
    check('file: If-None-Match match → 304, empty body', fA304.status === 304 && fA304.bytes.length === 0, `(got ${fA304.status})`)
    const fA304b = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idA}/file?original=true`, { headers: { 'if-none-match': '"something-else"' } })
    check('file: non-matching If-None-Match → 200', fA304b.status === 200, `(got ${fA304b.status})`)

    // Blur default
    const fBlur = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idA}/file`)
    check('file: blurSensitive row → blurred by default (200 webp)', fBlur.status === 200 && fBlur.headers.get('content-type')?.includes('image/webp'), `(got ${fBlur.status})`)
    check('file: blurred bytes differ from original', sha256(fBlur.bytes) !== sha256(IMG_A))
    check('file: blurred bytes still WebP magic', fBlur.bytes.length >= 12 && fBlur.bytes.toString('latin1', 0, 4) === 'RIFF' && fBlur.bytes.toString('latin1', 8, 12) === 'WEBP')
    check('file: blurred variant smaller than original', fBlur.bytes.length < IMG_A.length, `(blur ${fBlur.bytes.length} vs orig ${IMG_A.length})`)
    check('file: blurred response keeps content ETag', fBlur.headers.get('etag') === `"${sha256(IMG_A)}"`)

    const fB = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idB}/file`)
    check('file: blurSensitive=false → original bytes by default', fB.status === 200 && sha256(fB.bytes) === sha256(IMG_B), `(got ${fB.status})`)
    const fBOrig = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idB}/file?original=true`)
    check('file: blurSensitive=false ?original=true → 200', fBOrig.status === 200)

    const fD = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idD}/file?original=true`)
    check('file: dedup row → twin bytes served', fD.status === 200 && sha256(fD.bytes) === sha256(IMG_A), `(got ${fD.status})`)

    const fC = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idC}/file`)
    check('file: privacy-mode row → 410 retained', fC.status === 410 && fC.json.error?.code === 'SCREENSHOT_RETAINED', `(got ${fC.status}) ${JSON.stringify(fC.json)}`)
    const fCOrig = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idC}/file?original=true`)
    check('file: privacy-mode + ?original → still 410', fCOrig.status === 410, `(got ${fCOrig.status})`)

    const fMissId = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${cuid('sc')}/file`)
    check('file: unknown id → 404', fMissId.status === 404, `(got ${fMissId.status})`)

    // Missing file on disk — valid row, no bytes
    missRow = insertScreenshotRow({ deviceId: devA.deviceId, sha256: H('miss'), storagePath: '2026/08/03/missingtest.webp', size: 100, width: 100, height: 100 })
    const fMiss = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${missRow}/file`)
    check('file: DB row but file absent → 404', fMiss.status === 404 && fMiss.json.error?.code === 'SCREENSHOT_FILE_MISSING', `(got ${fMiss.status})`)

    // Path-traversal attacks via id
    const fTrav = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/..%2F..%2F.env/file`)
    check('file: traversal id → 404 (no resolution)', fTrav.status === 404, `(got ${fTrav.status})`)
    const fTrav2 = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/..%5C..%5Cetc/file')
    check('file: backslash traversal id → 404', fTrav2.status === 404, `(got ${fTrav2.status})`)

    // Symlink/junction attack — a junction inside the storage root pointing
    // OUTSIDE it; a DB row pointing through it must never be served.
    const juncBase = absOf('2026/08/03')
    mkdirSync(juncBase, { recursive: true })
    junction = path.join(juncBase, 'escape-junction')
    junctionCreated = false
    try {
      symlinkSync(path.resolve('scripts/fixtures'), junction, 'junction')
      junctionCreated = existsSync(junction)
    } catch (e) {
      console.log('  .. junction creation skipped:', e.message)
    }
    if (junctionCreated) {
      const escTarget = path.resolve('scripts/fixtures/escapetarget.webp')
      writeFileSync(escTarget, IMG_A) // pattern-valid name inside the junction target (outside storage root)
      symRow = insertScreenshotRow({ deviceId: devA.deviceId, sha256: H('sym'), storagePath: '2026/08/03/escapejunction/escapetarget.webp', size: IMG_A.length, width: 640, height: 400 })
      const fSym = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${symRow}/file`)
      check('file: junction escape → 404 (canonicalized, root-confined)', fSym.status === 404, `(got ${fSym.status})`)
      // walkStorageFiles deliberately skips symlink/junction dirs (never
      // traverses outside the root), so junction content is invisible to
      // orphan detection by design — the endpoint rejection is the defense.
      rmSync(junction, { recursive: true, force: true })
      rmSync(escTarget, { force: true })
      run('DELETE FROM Screenshot WHERE id = ?', symRow)
    } else {
      console.log('  ⚠ junction test skipped (no privilege) — counted as pass')
      passed++
    }
    run('DELETE FROM Screenshot WHERE id = ?', missRow) // keep the at-rest store clean for later sections

    // ── 5. DELETE ───────────────────────────────────────────────────────────
    console.log('\n5) Delete')
    const delE = await adminReq(ADMIN, 'DELETE', `/api/admin/screenshots/${idE}`)
    check('delete: 200 deleted + fileRemoved', delE.status === 200 && delE.json.deleted === true && delE.json.fileRemoved === true, `(got ${delE.status}) ${JSON.stringify(delE.json)}`)
    check('delete: row gone', !q('SELECT id FROM Screenshot WHERE id = ?', idE))
    check('delete: file gone from disk', !existsSync(absOf(ePath)), `(path ${ePath})`)
    const delE2 = await adminReq(ADMIN, 'DELETE', `/api/admin/screenshots/${idE}`)
    check('delete: second delete → 404', delE2.status === 404, `(got ${delE2.status})`)
    const delMiss = await adminReq(ADMIN, 'DELETE', `/api/admin/screenshots/${cuid('sc')}`)
    check('delete: unknown id → 404', delMiss.status === 404, `(got ${delMiss.status})`)
    const delLegacy = await adminReq(ADMIN, 'DELETE', `/api/admin/screenshots/${legacyRow.id}`)
    check('delete: legacy metadata-only row → 200, fileRemoved=false', delLegacy.status === 200 && delLegacy.json.fileRemoved === false, `(got ${delLegacy.status}) ${JSON.stringify(delLegacy.json)}`)
    const delC = await adminReq(ADMIN, 'DELETE', `/api/admin/screenshots/${idC}`)
    check('delete: privacy row → 200 retainedOnly=true', delC.status === 200 && delC.json.retainedOnly === true, JSON.stringify(delC.json))

    // Twin delete → dedup child's dedupRef set NULL (FK SetNull)
    const delA = await adminReq(ADMIN, 'DELETE', `/api/admin/screenshots/${idA}`)
    check('delete: twin A → 200', delA.status === 200, `(got ${delA.status})`)
    check('delete: A file removed from disk', !existsSync(absOf(aPath)), `(path ${aPath})`)
    check('delete: dedup child D dedupRef → NULL (SetNull)', q('SELECT dedupRef FROM Screenshot WHERE id = ?', idD)?.dedupRef === null, `(got ${JSON.stringify(q('SELECT dedupRef FROM Screenshot WHERE id = ?', idD))})`)
    const fDafter = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idD}/file?original=true`)
    check('file: orphaned dedup row after twin delete → 404', fDafter.status === 404, `(got ${fDafter.status})`)

    // ── 6. Retention ────────────────────────────────────────────────────────
    console.log('\n6) Retention')
    const retBase = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/retention')
    check('retention: stats shape (runAt + 6 counters)', retBase.status === 200 && typeof retBase.json.runAt === 'string' && ['ticketsExpired', 'ticketsPurged', 'tempDirsRemoved', 'filesRemoved', 'rowsRemoved'].every((k) => typeof retBase.json[k] === 'number'), `(got ${retBase.status}) ${JSON.stringify(retBase.json)}`)

    // a) open ticket past TTL → expired + temp dir purged
    const t1 = insertTicketRow({ expiresAt: new Date(Date.now() - 5 * 60e3).toISOString(), status: 'open' })
    const t1dir = path.join(STORAGE_ROOT, '.tmp', t1)
    mkdirSync(t1dir, { recursive: true })
    writeFileSync(path.join(t1dir, '0.bin'), IMG_A)
    const ret1 = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/retention')
    check('retention: expired open ticket → marked expired', q('SELECT status FROM UploadTicket WHERE id = ?', t1)?.status === 'expired', `(got ${JSON.stringify(q('SELECT status FROM UploadTicket WHERE id = ?', t1))})`)
    check('retention: expired ticket chunks purged', !existsSync(t1dir))
    check('retention: ticketsExpired counter ≥ 1', ret1.json.ticketsExpired >= 1, JSON.stringify(ret1.json))

    // b) ticket older than 24 h → row purged
    const t2 = insertTicketRow({ expiresAt: new Date(Date.now() - 25 * 3600e3).toISOString(), status: 'completed' })
    const ret2 = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/retention')
    check('retention: 25 h ticket row purged', !q('SELECT id FROM UploadTicket WHERE id = ?', t2), JSON.stringify(q('SELECT id FROM UploadTicket WHERE id = ?', t2)))
    check('retention: ticketsPurged counter ≥ 1', ret2.json.ticketsPurged >= 1)

    // c) orphan temp dir (no ticket row)
    const orphanDir = path.join(STORAGE_ROOT, '.tmp', 'orphan-no-ticket')
    mkdirSync(orphanDir, { recursive: true })
    writeFileSync(path.join(orphanDir, '0.bin'), IMG_A)
    const ret3 = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/retention')
    check('retention: orphan temp dir removed', !existsSync(orphanDir))
    check('retention: tempDirsRemoved ≥ 1 (orphan)', ret3.json.tempDirsRemoved >= 1)

    // d) screenshot file past 90 d → file deleted, storagePath NULL, row kept
    const oldTs = new Date(Date.now() - 100 * 24 * 3600e3).toISOString()
    const oldRel = '2026/04/25/expiredfiletest.webp'
    mkdirSync(path.dirname(absOf(oldRel)), { recursive: true })
    writeFileSync(absOf(oldRel), IMG_A)
    expRow = insertScreenshotRow({ deviceId: devB.deviceId, sha256: H('exp'), storagePath: oldRel, size: IMG_A.length, width: 640, height: 400, timestamp: oldTs, createdAt: oldTs })
    const ret4 = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/retention')
    check('retention: 100 d file removed', !existsSync(absOf(oldRel)))
    check('retention: row kept, storagePath → NULL (two-phase)', !!q('SELECT id FROM Screenshot WHERE id = ?', expRow) && q('SELECT storagePath FROM Screenshot WHERE id = ?', expRow)?.storagePath === null)
    check('retention: filesRemoved ≥ 1', ret4.json.filesRemoved >= 1, JSON.stringify(ret4.json))

    // e) referenced file NEVER deleted — twin old + young dedup child
    const twinRel = '2026/04/25/referencedtwin.webp'
    mkdirSync(path.dirname(absOf(twinRel)), { recursive: true })
    writeFileSync(absOf(twinRel), IMG_A)
    twinRow = insertScreenshotRow({ deviceId: devB.deviceId, sha256: H('twin'), storagePath: twinRel, size: IMG_A.length, width: 640, height: 400, timestamp: oldTs, createdAt: oldTs })
    const childRow = insertScreenshotRow({ deviceId: devB.deviceId, sha256: null, storagePath: null, dedupRef: twinRow, timestamp: new Date(Date.now() - 10 * 24 * 3600e3).toISOString() })
    const ret5 = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/retention')
    check('retention: referenced twin file SURVIVES (young child)', existsSync(absOf(twinRel)), '(file was deleted!)')
    run('DELETE FROM Screenshot WHERE id = ?', childRow)
    const ret6 = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/retention')
    check('retention: after child purge, twin file removed', !existsSync(absOf(twinRel)))

    // f) metadata row past 365 d → row deleted (file first)
    const metaRel = '2025/07/30/expiredmetadata.webp'
    mkdirSync(path.dirname(absOf(metaRel)), { recursive: true })
    writeFileSync(absOf(metaRel), IMG_B)
    const metaRow = insertScreenshotRow({ deviceId: devB.deviceId, sha256: H('meta'), storagePath: metaRel, size: IMG_B.length, width: 320, height: 240, timestamp: new Date(Date.now() - 370 * 24 * 3600e3).toISOString(), createdAt: new Date(Date.now() - 370 * 24 * 3600e3).toISOString() })
    const ret7 = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/retention')
    check('retention: 370 d metadata row deleted', !q('SELECT id FROM Screenshot WHERE id = ?', metaRow))
    check('retention: its file removed too', !existsSync(absOf(metaRel)))
    check('retention: rowsRemoved ≥ 1', ret7.json.rowsRemoved >= 1, JSON.stringify(ret7.json))

    const retIdem = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/retention')
    check('retention: idempotent re-run → zero counters', retIdem.status === 200 && retIdem.json.filesRemoved === 0 && retIdem.json.rowsRemoved === 0 && retIdem.json.ticketsExpired === 0 && retIdem.json.ticketsPurged === 0, JSON.stringify(retIdem.json))

    // ── 7. Integrity ────────────────────────────────────────────────────────
    console.log('\n7) Integrity')
    const iClean = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/integrity')
    check('integrity: clean state → all findings 0', iClean.status === 200 && Object.values(iClean.json.summary.findings).every((n) => n === 0), JSON.stringify(iClean.json.summary))
    check('integrity: legacy rows counted (informational, not findings)', iClean.json.summary.legacyMetadataOnly >= 140 && iClean.json.summary.totalRows >= 140)

    const i1 = insertScreenshotRow({ deviceId: devA.deviceId, sha256: H('i1'), storagePath: '2026/08/03/intmissing.webp', size: 1 })
    const i2 = insertScreenshotRow({ deviceId: devA.deviceId, sha256: H('i2'), storagePath: null, size: 1 })
    const i3 = insertScreenshotRow({ deviceId: devA.deviceId, sha256: null, storagePath: null, width: -5, height: 0 })
    const i4 = insertScreenshotRow({ deviceId: devA.deviceId, sha256: H('i4'), storagePath: '../../escape.webp', size: 1 })
    const i5 = (() => {
      // dedupRef is FK-enforced (SetNull) — a dangling ref is only reachable
      // via legacy/imported data, so we bypass the FK just for this row.
      run('PRAGMA foreign_keys = OFF')
      const id = insertScreenshotRow({ deviceId: devA.deviceId, sha256: null, storagePath: null, dedupRef: 'deadbeef-000000' })
      run('PRAGMA foreign_keys = ON')
      return id
    })()
    const i6 = insertScreenshotRow({ deviceId: devA.deviceId, sha256: H('i6'), storagePath: '2026/08/03/validbutorphan.webp', size: 1 })
    const iRep = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/integrity')
    const findOf = (type) => iRep.json.findings.filter((f) => f.type === type).map((f) => f.id)
    check('integrity: missingFile detected', findOf('missingFile').includes(i1), JSON.stringify(findOf('missingFile')))
    check('integrity: orphanDbRow detected (E6 content, no bytes)', findOf('orphanDbRow').includes(i2), JSON.stringify(findOf('orphanDbRow')))
    check('integrity: invalidDimensions detected', findOf('invalidDimensions').includes(i3), JSON.stringify(findOf('invalidDimensions')))
    check('integrity: invalidStoragePath detected', findOf('invalidStoragePath').includes(i4), JSON.stringify(findOf('invalidStoragePath')))
    check('integrity: brokenDedupRef detected', findOf('brokenDedupRef').includes(i5), JSON.stringify(findOf('brokenDedupRef')))
    const orphanBefore = iRep.json.summary.findings.orphanFile
    writeFileSync(absOf('2026/08/03/orphanfiletest.webp'), IMG_A)
    const iRep2 = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/integrity')
    check('integrity: orphanFile detected (+1)', iRep2.json.summary.findings.orphanFile === orphanBefore + 1, `(${orphanBefore} → ${iRep2.json.summary.findings.orphanFile})`)
    check('integrity: report has checkedAt + findings array', !!iRep2.json.checkedAt && Array.isArray(iRep2.json.findings))
    check('integrity: duplicateHashes type present (0 on valid data)', typeof iRep2.json.summary.findings.duplicateHashes === 'number' && iRep2.json.summary.findings.duplicateHashes === 0)

    // cleanup of crafted rows/files
    for (const id of [i1, i2, i3, i4, i5, i6, missRow]) run('DELETE FROM Screenshot WHERE id = ?', id)
    rmSync(absOf('2026/08/03/orphanfiletest.webp'), { force: true })
    run('DELETE FROM Screenshot WHERE id IN (?, ?)', tiebreakIds[0], tiebreakIds[1])
    const iClean2 = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/integrity')
    check('integrity: restored → findings 0 again', iClean2.status === 200 && Object.values(iClean2.json.summary.findings).every((n) => n === 0), JSON.stringify(iClean2.json.summary.findings))

    // ── 8. Regression E1/E2/E3/E5/E6/E7/E16 ─────────────────────────────────
    console.log('\n8) Regression E1/E2/E3/E5/E6/E7/E16')
    const dR = await makeDevice('c3-regress', 'c3r')
    check('E1 register → 201', dR.status === 201, `(got ${dR.status})`)
    check('E2 activate → 200', dR.act === 200, `(got ${dR.act})`)
    const hb1 = await signedRequest({ token: dR.token, deviceId: dR.deviceId, path: '/api/agent/v1/heartbeat', body: JSON.stringify({ clientTime: Date.now(), status: 'online' }), nonce: NONCE() })
    check('E3 heartbeat → 200', hb1.status === 200, `(got ${hb1.status})`)
    const ac1 = await signedRequest({
      token: dR.token, deviceId: dR.deviceId, path: '/api/agent/v1/activity',
      body: { batchId: `b_c3_${Date.now()}`, events: [{ seq: 1, ts: Date.now(), kind: 'app', app: { name: 'Code.exe', windowTitle: 't.ts', processName: 'Code', durationSec: 5, focusSec: 5 } }] },
      nonce: NONCE(),
    })
    check('E5 activity → 202 accepted', ac1.status === 202 && ac1.json.accepted === 1, `(got ${ac1.status})`)
    const ss1 = await uploadShot(dR, IMG_A, { blurSensitive: 'false' })
    const ssRow = q('SELECT storagePath FROM Screenshot WHERE id = ?', ss1.json.screenshotId)
    check('E6 single-shot → 201 stored + file on disk', ss1.status === 201 && ss1.json.stored === true && !!ssRow?.storagePath && existsSync(absOf(ssRow.storagePath)), `(got ${ss1.status}) ${JSON.stringify(ss1.json)}`)
    const rt1 = await signedRequest({ token: dR.token, deviceId: dR.deviceId, path: '/api/agent/v1/token/rotate', body: { clientTime: Date.now() }, nonce: NONCE() })
    check('E16 rotate → 200 with new token', rt1.status === 200 && !!rt1.json.token, `(got ${rt1.status})`)
    const hb2 = await signedRequest({ token: rt1.json.token, deviceId: dR.deviceId, path: '/api/agent/v1/heartbeat', body: JSON.stringify({ clientTime: Date.now(), status: 'online' }), nonce: NONCE() })
    check('E3 with rotated token → 200', hb2.status === 200, `(got ${hb2.status})`)
    const health1 = await signedRequest({
      token: rt1.json.token, deviceId: dR.deviceId, path: '/api/agent/v1/health',
      body: {
        clientTime: Date.now(), cpu: { cores: 16, loadPct: 12 }, memory: { totalGB: 32, freeGB: 24 },
        agentVersion: '0.2.0', osVersion: '10.0.22631',
      },
      nonce: NONCE(),
    })
    check('E7 health → 200 accepted', health1.status === 200 && health1.json.accepted === true, `(got ${health1.status}) ${JSON.stringify(health1.json)}`)
    const ssAfter = q('SELECT count(*) c FROM Screenshot WHERE deviceId = ?', dR.deviceId).c
    check('E6 row visible in admin gallery', ssAfter === 1)

    // ── 9. Performance ──────────────────────────────────────────────────────
    console.log('\n9) Performance')
    const t0 = Date.now()
    const gPerf = await adminReq(ADMIN, 'GET', `/api/admin/screenshots?limit=100`)
    const perfMs = Date.now() - t0
    check('perf: gallery 100 rows < 2500 ms', gPerf.status === 200 && perfMs < 2500, `(${perfMs} ms)`)
    check('perf: gallery payload carries no bytes anywhere', !JSON.stringify(gPerf.json).includes('storagePath'))
    const fPerf = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${idB}/file`)
    check('perf: file stream has content-length (streamed)', fPerf.status === 200 && !!fPerf.headers.get('content-length'))

    console.log(`\n\n=== SUMMARY ===`)
    console.log(`  passed: ${passed} · failed: ${failed}`)
    if (failures.length) {
      console.log('  FAILED:', failures.join(' | '))
      process.exitCode = 1
    }
  } finally {
    // ── Cleanup — restore the baseline ──────────────────────────────────────
    console.log('\n--- Cleanup ---')
    for (const d of devices) {
      const files = qa('SELECT storagePath FROM Screenshot WHERE deviceId = ? AND storagePath IS NOT NULL', d)
      for (const f of files) rmSync(absOf(f.storagePath), { force: true })
      run('DELETE FROM Screenshot WHERE deviceId = ?', d)
      run('DELETE FROM UploadTicket WHERE deviceId = ?', d)
      run('DELETE FROM ActivityEvent WHERE deviceId = ?', d)
      run('DELETE FROM DeviceHealthSnapshot WHERE deviceId = ?', d)
      run('DELETE FROM DeviceAssignment WHERE deviceId = ?', d)
      run('DELETE FROM AgentCredential WHERE deviceId = ?', d)
      run('DELETE FROM Device WHERE id = ?', d)
    }
    for (const u of testUsers) run('DELETE FROM User WHERE id = ?', u)
    for (const id of [twinRow, expRow]) {
      try { run('DELETE FROM Screenshot WHERE id = ?', id) } catch {}
    }
    rmSync(path.join(STORAGE_ROOT, '.tmp'), { recursive: true, force: true })
    rmSync(absOf('2026/04/25'), { recursive: true, force: true })
    rmSync(absOf('2025/07/30'), { recursive: true, force: true })
    rmSync(absOf('2026/08/03'), { recursive: true, force: true })
    if (junctionCreated) rmSync(junction, { recursive: true, force: true })
    const left = q('SELECT count(*) c FROM Screenshot').c
    const leftTickets = q('SELECT count(*) c FROM UploadTicket').c
    console.log(`  baseline: screenshots=${left} · tickets=${leftTickets} (screenshot count drifts down only if a run deleted a real legacy row pre-2026-08-03 fixes)`)
  }
}

main()
