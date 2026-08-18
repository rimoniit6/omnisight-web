/**
 * M007 Stage-4 — OCR Pipeline & Search Index — Automated Verification (live server)
 *
 * Covers the db-backed OCR pipeline end-to-end against a running dev server:
 *   queue:    POST /api/admin/screenshots/:id/ocr   (enqueue, dedupe, 422s, 404)
 *             GET  /api/admin/screenshots/:id/ocr   (status + result)
 *             POST /api/admin/screenshots/ocr/retry (retry budget + exceeding)
 *   worker:   FIFO claim, success persist (text/keywords/confidence/engine),
 *             failure recovery (missing-file retryable, corrupt/unsupported
 *             permanent), retry counting, stall reclaim (graceful restart),
 *             deleted-while-queued, burst concurrency in FIFO order
 *   search:   GET /api/admin/screenshots/search — keyword, case-insensitive,
 *             filters (deviceId/confidence/from/to), keyset cursor pagination
 *   auth:     Super-Admin-only gate (401 without token)
 *
 * Run with bun (node verify scripts match the repo):
 *   bun scripts/verify-ocr.mjs
 * Env: BASE_URL (default http://localhost:3100) · DB_PATH (default db/custom.db)
 *      · SUPER_ADMIN_EMAIL · SUPER_ADMIN_PASSWORD (auto-loaded from .env by bun)
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import bcrypt from 'bcryptjs'
import { signAgentRequest } from '../src/lib/agent-auth/signature'

const BASE = process.env.BASE_URL || 'http://localhost:3100'
const DB_PATH = process.env.DB_PATH || 'db/custom.db'
const STORAGE_ROOT = path.resolve(process.env.STORAGE_PATH || 'storage/screenshots')
const INSTALLATION_ID = 'inst_demo_default'
const JOIN_KEY = 'WL-DEMO-JOINKEY-2026'
const ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'aria.martin@umbrella.com'
const ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || ''
const MAX_ATTEMPTS = 3
const STALL_MS = 10 * 60 * 1000

const IMG_HELLO = readFileSync(new URL('./fixtures/ocr-hello.webp', import.meta.url))
const IMG_CODE = readFileSync(new URL('./fixtures/ocr-code-review.webp', import.meta.url))
const IMG_SALES = readFileSync(new URL('./fixtures/ocr-sales.webp', import.meta.url))
const IMG_MEETING = readFileSync(new URL('./fixtures/ocr-meeting.webp', import.meta.url))
const CORRUPT_WEBP = readFileSync(new URL('./fixtures/corrupt-webp.webp', import.meta.url))
const NOT_IMAGE = readFileSync(new URL('./fixtures/not-image.txt', import.meta.url))

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

const NONCE = () => Buffer.from(randomBytes(16)).toString('base64url')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const db = new Database(DB_PATH)
db.run('PRAGMA foreign_keys = ON')
const q = (sql, ...args) => db.query(sql).get(...args)
const qa = (sql, ...args) => db.query(sql).all(...args)
const run = (sql, ...args) => db.query(sql).run(...args)
const cuid = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e9)}`
const alnum = (n = 16) => randomBytes(n).toString('hex')
const MS = (v) => (v instanceof Date ? v.getTime() : typeof v === 'number' ? v : new Date(v).getTime())

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
  return { status: res.status, token: json.token, cookie: cookieOf(res) }
}

let SESSION_COOKIE = ''
async function adminReq(token, method, p, { headers = {}, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, cookie: headers.cookie ?? SESSION_COOKIE, ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, headers: res.headers }
}

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
  await sleep(120)
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

const qMeta = (img, over = {}) =>
  ['ts', 'sha256', 'size', 'format', 'width', 'height', 'multiMonitor', 'monitorId', 'privacyMode', 'blurSensitive']
    .map((k) => {
      const v = { ts: Date.now(), sha256: sha256(img), size: img.length, format: 'webp', width: 640, height: 400, multiMonitor: false, monitorId: 0, privacyMode: false, blurSensitive: true, ...over }[k]
      return `&${k}=${encodeURIComponent(v)}`
    })
    .join('')

const devices = []
const testUsers = []

async function registerDevice(hostname) {
  const serial = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const reg = await fetch(`${BASE}/api/agent/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.251' },
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

async function makeDevice(name, tag) {
  const reg = await registerDevice(name)
  if (reg.status !== 201) return { status: reg.status, deviceId: null, token: null, act: null }
  const id = `usr_ocr_${tag}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  testUsers.push(id)
  run('INSERT INTO User (id, name, email, role, status, passwordHash, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, `OCR${tag} User`, `${tag}-${Date.now()}@test.local`, 'Employee', 'Active',
    bcrypt.hashSync('ocr-test-pass-1', 10), new Date().toISOString())
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

async function uploadShot(device, img, over = {}) {
  return signedRequest({ token: device.token, deviceId: device.deviceId, path: `/api/agent/v1/screenshots?mode=single${qMeta(img, over)}`, body: img, nonce: NONCE() })
}

function insertScreenshotRow(over = {}) {
  const id = over.id || cuid('sc')
  run('INSERT INTO Screenshot (id, deviceId, userId, sha256, storagePath, size, width, height, monitorId, privacyMode, blurSensitive, dedupRef, timestamp, createdAt, flagged, sensitiveDataDetected) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?)',
    id, over.deviceId || devices[0], over.userId ?? null, over.sha256 ?? null, over.storagePath ?? null,
    over.size ?? null, over.width ?? null, over.height ?? null, over.monitorId ?? 0, over.privacyMode ?? false,
    over.blurSensitive ?? true, over.dedupRef ?? null, MS(over.timestamp ?? new Date()), MS(over.createdAt ?? new Date()),
    over.flagged ?? false, over.sensitiveDataDetected ?? false)
  return id
}

const absOf = (rel) => path.join(STORAGE_ROOT, rel)

const ocrStatus = async (token, id) => (await adminReq(token, 'GET', `/api/admin/screenshots/${id}/ocr`)).json
const enqueueJob = async (token, id) => adminReq(token, 'POST', `/api/admin/screenshots/${id}/ocr`)

async function waitStatus(token, id, want, timeoutMs = 60000, step = 700) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await ocrStatus(token, id)
    if (want.includes(last?.status)) return last
    await sleep(step)
  }
  return last
}

function row(id) {
  const r = q('SELECT ocrStatus, ocrQueuedAt, ocrLockedAt, ocrAttempts, ocrRetryable, ocrFailure, ocrLanguage, ocrEngine, ocrEngineVersion, ocrText, ocrKeywords, ocrConfidence, ocrProcessedAt, ocrDuration FROM Screenshot WHERE id = ?', id)
  if (r) r.ocrRetryable = !!r.ocrRetryable
  return r
}

function dateSlug(d = new Date()) {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
}

async function main() {
  try {
    const login = await adminLogin()
    SESSION_COOKIE = login.cookie
    check('setup: super-admin login → 200 + token', login.status === 200 && !!login.token, `(got ${login.status})`)
    const ADMIN = login.token
    const enq = (id) => enqueueJob(ADMIN, id)

    console.log('\n0) Devices + OCR fixtures')
    const devA = await makeDevice('ocr-a', 'a')
    const devB = await makeDevice('ocr-b', 'b')
    check('setup: 2 devices registered + activated', devA.status === 201 && devA.act === 200 && devB.status === 201 && devB.act === 200, `(A ${devA.status}/${devA.act} B ${devB.status}/${devB.act})`)

    const upHello = await uploadShot(devA, IMG_HELLO)
    const upCode = await uploadShot(devA, IMG_CODE)
    const upSales = await uploadShot(devB, IMG_SALES)
    const upMeeting = await uploadShot(devB, IMG_MEETING)
    check('fixture: hello shot stored', upHello.status === 201 && (upHello.json?.stored === true || upHello.json?.duplicate === true), JSON.stringify(upHello.json ?? {}))
    check('fixture: code shot stored', upCode.status === 201 && (upCode.json?.stored === true || upCode.json?.duplicate === true), JSON.stringify(upCode.json ?? {}))
    check('fixture: sales shot stored', upSales.status === 201 && (upSales.json?.stored === true || upSales.json?.duplicate === true))
    check('fixture: meeting shot stored', upMeeting.status === 201 && (upMeeting.json?.stored === true || upMeeting.json?.duplicate === true))
    const helloId = upHello.json?.screenshotId
    const codeId = upCode.json?.screenshotId
    const salesId = upSales.json?.screenshotId
    const meetingId = upMeeting.json?.screenshotId
    check('fixture: 4 screenshot ids', !!(helloId && codeId && salesId && meetingId))
    const storagePathOf = (id) => q('SELECT storagePath FROM Screenshot WHERE id = ?', id)?.storagePath
    const helloPath = storagePathOf(helloId) ?? q('SELECT storagePath FROM Screenshot WHERE id = (SELECT dedupRef FROM Screenshot WHERE id = ?)', helloId)?.storagePath
    check('fixture: hello storagePath', typeof helloPath === 'string' && helloPath.length > 0)
    check('fixture: real webp on disk', existsSync(absOf(helloPath)))

    console.log('\n1) Enqueue (POST /:id/ocr)')
    const en1 = await enq(helloId)
    check('enqueue: none→pending 202', en1.status === 202 && en1.json?.status === 'pending', `(got ${en1.status}) ${JSON.stringify(en1.json ?? {})}`)
    check('db: ocrQueuedAt set + attempts=0', row(helloId)?.ocrQueuedAt !== null && row(helloId)?.ocrAttempts === 0)
    const en2 = await enq(helloId)
    check('enqueue: duplicate → 409 OCR_ALREADY_QUEUED', en2.status === 409 && en2.json?.error?.code === 'OCR_ALREADY_QUEUED', `(got ${en2.status}) ${JSON.stringify(en2.json ?? {})}`)
    const en404 = await enq(cuid('nobody'))
    check('enqueue: unknown id → 404 OCR_ROW_NOT_FOUND', en404.status === 404 && en404.json?.error?.code === 'OCR_ROW_NOT_FOUND', `(got ${en404.status})`)
    const authNone = await adminReq('', 'GET', '/api/admin/screenshots/search', { headers: { cookie: '' } })
    check('auth: OCR search without token → 401', authNone.status === 401, `(got ${authNone.status})`)

    const privacyId = insertScreenshotRow({ deviceId: devA.deviceId, privacyMode: true })
    const pri = await enq(privacyId)
    check('enqueue: privacy-mode → 422 OCR_NOT_ENQUEUEABLE', pri.status === 422 && pri.json?.error?.code === 'OCR_NOT_ENQUEUEABLE', `(got ${pri.status}) ${JSON.stringify(pri.json ?? {})}`)

    const ghostId = insertScreenshotRow({ deviceId: devA.deviceId, storagePath: null, dedupRef: null, sha256: null })
    const gh = await enq(ghostId)
    check('enqueue: byte-less row → 422 OCR_NOT_ENQUEUEABLE', gh.status === 422 && gh.json?.error?.code === 'OCR_NOT_ENQUEUEABLE', `(got ${gh.status})`)

    const missingPath = `${dateSlug()}/m${alnum(12)}.webp`
    const missId = insertScreenshotRow({ deviceId: devA.deviceId, sha256: sha256(Buffer.concat([IMG_HELLO, Buffer.from(`m:${alnum(6)}`)])), storagePath: missingPath, size: 10 })
    const missEnq = await enq(missId)
    check('enqueue: crafted missing-file row → 202', missEnq.status === 202, `(got ${missEnq.status})`)

    console.log('\n2) Worker — success path')
    const helloDone = await waitStatus(ADMIN, helloId, ['completed', 'failed'])
    check('worker: hello job completed', helloDone?.status === 'completed', `(got ${helloDone?.status})`)
    check('worker: text "HELLO WORLD 24680"', helloDone?.result?.text === 'HELLO WORLD 24680', `(got ${JSON.stringify(helloDone?.result?.text)})`)
    check('worker: confidence ∈ (0,100]', helloDone?.result?.confidence > 0 && helloDone?.result?.confidence <= 100, `(got ${helloDone?.result?.confidence})`)
    check('worker: engine = tesseract', helloDone?.result?.engine === 'tesseract', `(got ${JSON.stringify(helloDone?.result?.engine)})`)
    check('worker: engineVersion present', typeof helloDone?.result?.engineVersion === 'string' && helloDone?.result?.engineVersion.length > 0, `(got ${JSON.stringify(helloDone?.result?.engineVersion)})`)
    check('worker: language = eng', helloDone?.result?.language === 'eng', `(got ${JSON.stringify(helloDone?.result?.language)})`)
    check('worker: durationMs > 0', typeof helloDone?.result?.durationMs === 'number' && helloDone?.result?.durationMs > 0, `(got ${helloDone?.result?.durationMs})`)
    check('worker: processedAt string', typeof helloDone?.result?.processedAt === 'string')
    check('worker: ocrFailure cleared', row(helloId)?.ocrFailure === null)
    check('worker: ocrLockedAt cleared', row(helloId)?.ocrLockedAt === null)
    const storedKw = JSON.parse(row(helloId)?.ocrKeywords ?? '[]')
    check('worker: keywords [.. hello .. world]', Array.isArray(storedKw) && storedKw.includes('hello') && storedKw.includes('world'), `(got ${JSON.stringify(storedKw)})`)

    const ec = await enq(codeId)
    const es = await enq(salesId)
    const em = await enq(meetingId)
    check('enqueue: code/sales/meeting → 202', [ec.status, es.status, em.status].every((s) => s === 202), `(got ${ec.status}/${es.status}/${em.status})`)
    const pend = qa('SELECT id FROM Screenshot WHERE ocrStatus="pending" AND ocrQueuedAt IS NOT NULL ORDER BY ocrQueuedAt ASC, id ASC').map((r) => r.id)
    check('queue: ≥3 pending ordered by ocrQueuedAt', pend.length >= 3, `(n=${pend.length})`)

    await sleep(9000)

    check('worker: sales completed', row(salesId)?.ocrStatus === 'completed', `(got ${row(salesId)?.ocrStatus})`)
    check('worker: meeting completed', row(meetingId)?.ocrStatus === 'completed')
    check('worker: code completed', row(codeId)?.ocrStatus === 'completed')
    check('worker: sales text', row(salesId)?.ocrText === 'SALES QUARTER REPORT', `(got ${JSON.stringify(row(salesId)?.ocrText)})`)
    check('worker: meeting text', row(meetingId)?.ocrText === 'MEETING NOTES AGENDA', `(got ${JSON.stringify(row(meetingId)?.ocrText)})`)

    console.log('\n3) Search (GET /search)')
    const s0 = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/search')
    check('search: 200', s0.status === 200, `(got ${s0.status})`)
    check('search: shape', Array.isArray(s0.json?.screenshots) && 'nextCursor' in s0.json && typeof s0.json?.hasMore === 'boolean' && 'limit' in s0.json, `(keys ${Object.keys(s0.json ?? {})})`)
    const sq = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/search?q=HELLO&deviceId=${devA.deviceId}`)
    check('search: q=HELLO → exactly hello row', sq.status === 200 && sq.json?.screenshots?.length === 1 && sq.json.screenshots[0].id === helloId, `(n=${sq.json?.screenshots?.length})`)
    check('search: row has ocr{text,keywords,confidence}', sq.json?.screenshots?.[0]?.ocr?.text === 'HELLO WORLD 24680' && sq.json.screenshots[0]?.ocr?.keywords?.includes('hello') && sq.json.screenshots[0]?.ocr?.confidence > 0)
    const sqLower = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/search?q=hello&deviceId=${devA.deviceId}`)
    check('search: lowercase matches case-insensitively', sqLower.status === 200 && sqLower.json?.screenshots?.length === 1, `(n=${sqLower.json?.screenshots?.length})`)
    const sqNo = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/search?q=ZZZNONEXYZ&deviceId=${devA.deviceId}`)
    check('search: no-match → empty', sqNo.status === 200 && sqNo.json?.screenshots?.length === 0, `(n=${sqNo.json?.screenshots?.length})`)
    const sqRev = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/search?q=review&deviceId=${devA.deviceId}`)
    check('search: q=review finds code row', sqRev.status === 200 && sqRev.json?.screenshots?.some((x) => x.id === codeId), `(n=${sqRev.json?.screenshots?.length})`)
    const sqAg = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/search?q=AGENDA&deviceId=${devB.deviceId}`)
    check('search: q=AGENDA → meeting row', sqAg.status === 200 && sqAg.json?.screenshots?.length === 1 && sqAg.json.screenshots[0].id === meetingId, `(n=${sqAg.json?.screenshots?.length})`)
    const hiConf = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/search?minConfidence=90')
    check('search: minConfidence=90 → ≥1', hiConf.status === 200 && hiConf.json?.screenshots?.length >= 1, `(n=${hiConf.json?.screenshots?.length})`)
    const tooConf = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/search?minConfidence=200')
    check('search: minConfidence=200 → 400', tooConf.status === 400, `(got ${tooConf.status})`)
    const negConf = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/search?minConfidence=-1')
    check('search: minConfidence=-1 → 400', negConf.status === 400)
    const devOnly = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/search?deviceId=${devA.deviceId}`)
    check('search: deviceId filter → dev-A rows only', devOnly.status === 200 && devOnly.json?.screenshots?.length >= 1 && devOnly.json.screenshots.every((x) => x.device?.id === devA.deviceId), `(n=${devOnly.json?.screenshots?.length})`)
    const from = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/search?from=${encodeURIComponent(new Date(Date.now() - 3600000).toISOString())}`)
    check('search: from=1h ago → rows', from.status === 200 && from.json?.screenshots?.length >= 1)
    const badDate = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/search?from=notadate')
    check('search: bad from → 400', badDate.status === 400)
    const pg1 = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/search?limit=2')
    check('search: limit=2 → 2 + nextCursor', pg1.status === 200 && pg1.json?.screenshots?.length === 2 && typeof pg1.json?.nextCursor === 'string', `(n=${pg1.json?.screenshots?.length})`)
    const pg2 = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/search?limit=2&cursor=${encodeURIComponent(pg1.json.nextCursor)}`)
    check('search: page 2 distinct', pg2.status === 200 && pg2.json?.screenshots?.length >= 1 && !pg2.json.screenshots.some((x) => pg1.json.screenshots.some((y) => y.id === x.id)), `(n=${pg2.json?.screenshots?.length})`)
    let walkCur = pg2.json?.nextCursor
    let walkPage = pg2
    let walkCount = 2
    while (typeof walkCur === 'string' && walkCount < 20) {
      walkPage = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/search?limit=2&cursor=${encodeURIComponent(walkCur)}`)
      walkCur = walkPage.json?.nextCursor ?? null
      walkCount++
    }
    check('search: exhausted → hasMore=false + nextCursor=null', walkPage.json?.hasMore === false && walkPage.json?.nextCursor === null, `(hasMore=${walkPage.json?.hasMore} nextCursor=${walkPage.json?.nextCursor} pages=${walkCount})`)
    const badCur = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/search?cursor=!!xx!!')
    check('search: malformed cursor → 400', badCur.status === 400, `(got ${badCur.status})`)
    const badLim = await adminReq(ADMIN, 'GET', '/api/admin/screenshots/search?limit=abc')
    check('search: malformed limit → 400', badLim.status === 400)

    console.log('\n4) Failure handling')
    const corruptRel = `${dateSlug()}/c${alnum(12)}.webp`
    const corruptId = insertScreenshotRow({ deviceId: devA.deviceId, sha256: sha256(Buffer.concat([CORRUPT_WEBP, Buffer.from(`c:${alnum(6)}`)])), storagePath: corruptRel, size: CORRUPT_WEBP.length })
    mkdirSync(path.dirname(absOf(corruptRel)), { recursive: true })
    writeFileSync(absOf(corruptRel), CORRUPT_WEBP)
    check('failure: corrupt enqueue → 202', (await enq(corruptId)).status === 202)
    const cDone = await waitStatus(ADMIN, corruptId, ['failed'])
    check('failure: corrupt → OCR_CORRUPT_IMAGE', cDone?.status === 'failed' && cDone?.failure?.code === 'OCR_CORRUPT_IMAGE', `(got ${JSON.stringify(cDone?.failure)})`)
    check('failure: corrupt permanent (retryable=false)', row(corruptId)?.ocrRetryable === false, `(got ${row(corruptId)?.ocrRetryable})`)
    check('failure: corrupt attempts=1', row(corruptId)?.ocrAttempts === 1, `(got ${row(corruptId)?.ocrAttempts})`)
    const cRetry = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/ocr/retry', { body: { ids: [corruptId] } })
    check('retry: permanent corrupt → exceeded', Array.isArray(cRetry.json?.exceeded) && cRetry.json.exceeded.includes(corruptId), `(got ${JSON.stringify(cRetry.json ?? {})})`)
    check('retry: corrupt stays failed', row(corruptId)?.ocrStatus === 'failed')
    // Enqueue must NOT re-arm a permanently failed job (mission: never retry
    // permanent failures indefinitely — the retry endpoint refuses them, so a
    // direct enqueue must not bypass that with a fresh budget).
    const cEnq = await enq(corruptId)
    check('enqueue: permanent-failed → 409 OCR_PERMANENT_FAILED', cEnq.status === 409 && cEnq.json?.error?.code === 'OCR_PERMANENT_FAILED', `(got ${cEnq.status}) ${JSON.stringify(cEnq.json ?? {})}`)
    check('enqueue: permanent-failed not re-armed (stays failed, attempts=1)', row(corruptId)?.ocrStatus === 'failed' && row(corruptId)?.ocrAttempts === 1, `(got ${row(corruptId)?.ocrStatus}/${row(corruptId)?.ocrAttempts})`)

    const mDone = await waitStatus(ADMIN, missId, ['failed'])
    check('failure: missing-file → OCR_MISSING_FILE', mDone?.status === 'failed' && mDone?.failure?.code === 'OCR_MISSING_FILE', `(got ${JSON.stringify(mDone?.failure)})`)
    check('failure: missing-file retryable + attempts=1', row(missId)?.ocrRetryable === true && row(missId)?.ocrAttempts === 1, `(got ${row(missId)?.ocrRetryable}/${row(missId)?.ocrAttempts})`)

    const unsupRel = `${dateSlug()}/u${alnum(12)}.webp`
    const unsupId = insertScreenshotRow({ deviceId: devA.deviceId, sha256: sha256(Buffer.concat([NOT_IMAGE, Buffer.from(`u:${alnum(6)}`)])), storagePath: unsupRel, size: NOT_IMAGE.length })
    mkdirSync(path.dirname(absOf(unsupRel)), { recursive: true })
    writeFileSync(absOf(unsupRel), NOT_IMAGE)
    await enq(unsupId)
    const uDone = await waitStatus(ADMIN, unsupId, ['failed'])
    check('failure: unsupported → OCR_UNSUPPORTED_FORMAT', uDone?.status === 'failed' && uDone?.failure?.code === 'OCR_UNSUPPORTED_FORMAT', `(got ${JSON.stringify(uDone?.failure)})`)
    check('failure: unsupported permanent', row(unsupId)?.ocrRetryable === false, `(got ${row(unsupId)?.ocrRetryable})`)
    const uEnq = await enq(unsupId)
    check('enqueue: unsupported (permanent) → 409 OCR_PERMANENT_FAILED', uEnq.status === 409 && uEnq.json?.error?.code === 'OCR_PERMANENT_FAILED', `(got ${uEnq.status})`)

    const healthId = insertScreenshotRow({ deviceId: devA.deviceId, sha256: sha256(Buffer.concat([IMG_HELLO, Buffer.from(`h:${alnum(6)}`)])), storagePath: helloPath, size: IMG_HELLO.length })
    await enq(healthId)
    const hDone = await waitStatus(ADMIN, healthId, ['completed', 'failed'])
    check('worker: healthy after failures', hDone?.status === 'completed', `(got ${hDone?.status})`)

    console.log('\n5) Retry budget + endpoint')
    const r1 = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/ocr/retry', { body: { ids: [missId] } })
    check('retry: retryable → retried', Array.isArray(r1.json?.retried) && r1.json.retried.includes(missId), `(got ${JSON.stringify(r1.json ?? {})})`)
    check('retry: counts.retried=1', r1.json?.counts?.retried === 1)
    // Stale failure metadata must be cleared on re-enqueue so a pending job
    // never reports yesterday's failure through GET /:id/ocr.
    check('retry: failure metadata cleared while pending', row(missId)?.ocrFailure === null, `(got ${row(missId)?.ocrFailure})`)
    await waitStatus(ADMIN, missId, ['failed'])
    check('retry: second run attempts=2', row(missId)?.ocrAttempts === 2, `(got ${row(missId)?.ocrAttempts})`)
    const r2 = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/ocr/retry', { body: { ids: [missId] } })
    check('retry: 3rd enqueued', Array.isArray(r2.json?.retried) && r2.json.retried.includes(missId))
    await waitStatus(ADMIN, missId, ['failed'])
    check('retry: attempts=3 (budget reached)', row(missId)?.ocrAttempts >= MAX_ATTEMPTS, `(got ${row(missId)?.ocrAttempts})`)
    check('retry: exhausted → retryable=false', row(missId)?.ocrRetryable === false, `(got ${row(missId)?.ocrRetryable})`)
    const rExh = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/ocr/retry', { body: { ids: [missId] } })
    check('retry: exhausted → exceeded', Array.isArray(rExh.json?.exceeded) && rExh.json.exceeded.includes(missId), `(got ${JSON.stringify(rExh.json ?? {})})`)
    check('retry: exhausted stays failed', row(missId)?.ocrStatus === 'failed')
    const rInf = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/ocr/retry', { body: { ids: [helloId, 'definitely-missing'] } })
    check('retry: completed+unknown → ignored', Array.isArray(rInf.json?.ignored) && rInf.json.ignored.some((x) => x.id === 'definitely-missing'), `(got ${JSON.stringify(rInf.json ?? {})})`)
    const helloRe = await waitStatus(ADMIN, helloId, ['completed', 'failed'], 60000)
    check('retry: hello (completed) re-runs → completed again', helloRe?.status === 'completed', `(got ${helloRe?.status})`)
    const badBody = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/ocr/retry', { body: { ids: 'x' } })
    check('retry: malformed body → 400', badBody.status === 400, `(got ${badBody.status})`)
    const tooMany = await adminReq(ADMIN, 'POST', '/api/admin/screenshots/ocr/retry', { body: { ids: Array.from({ length: 201 }, (_, i) => `id${i}`) } })
    check('retry: 201 ids → 400 OCR_RETRY_TOO_MANY', tooMany.status === 400 && tooMany.json?.error?.code === 'OCR_RETRY_TOO_MANY', `(got ${tooMany.status})`)
    const noTok = await adminReq('', 'POST', '/api/admin/screenshots/ocr/retry', { body: { ids: ['x'] }, headers: { cookie: '' } })
    check('retry: no token → 401', noTok.status === 401, `(got ${noTok.status})`)

    console.log('\n6) Stall recovery (graceful restart)')
    const stallRel = missingPath
    const stallId = insertScreenshotRow({ deviceId: devA.deviceId, sha256: sha256(Buffer.concat([IMG_HELLO, Buffer.from(`st:${alnum(6)}`)])), storagePath: stallRel, size: 11 })
    check('stall: enqueued', (await enq(stallId)).status === 202)
    await waitStatus(ADMIN, stallId, ['failed'])
    const past = Date.now() - 2 * STALL_MS
    run('UPDATE Screenshot SET ocrStatus="processing", ocrLockedAt=?, ocrAttempts=1 WHERE id=?', past, stallId)
    await sleep(10000)
    const afterReclaim = row(stallId)
    check('stall: reclaimed off processing', afterReclaim?.ocrStatus !== 'processing', `(got ${afterReclaim?.ocrStatus})`)
    check('stall: terminal after reclaim', ['completed', 'failed'].includes(afterReclaim?.ocrStatus), `(got ${afterReclaim?.ocrStatus})`)
    const stall2Id = cuid('s2')
    insertScreenshotRow({ id: stall2Id, deviceId: devA.deviceId, sha256: sha256(Buffer.concat([IMG_HELLO, Buffer.from(`s2:${alnum(6)}`)])), storagePath: stallRel, size: 12 })
    await enq(stall2Id)
    await waitStatus(ADMIN, stall2Id, ['failed'])
    run('UPDATE Screenshot SET ocrStatus="processing", ocrLockedAt=?, ocrAttempts=? WHERE id=?', past, MAX_ATTEMPTS + 2, stall2Id)
    await sleep(2500)
    const stall2 = row(stall2Id)
    check('stall: exhausted claim → permanent OCR_STALLED_RECOVERED', stall2?.ocrStatus === 'failed' && stall2?.ocrFailure === 'OCR_STALLED_RECOVERED' && stall2?.ocrRetryable === false, `(got ${stall2?.ocrStatus}/${stall2?.ocrFailure})`)

    console.log('\n7) Deleted while queued')
    const delTwinId = cuid('twin')
    const delId = cuid('del')
    insertScreenshotRow({ id: delTwinId, deviceId: devA.deviceId, sha256: sha256(Buffer.concat([IMG_CODE, Buffer.from(`tw:${alnum(6)}`)])), storagePath: null })
    insertScreenshotRow({ id: delId, deviceId: devA.deviceId, sha256: null, storagePath: null, dedupRef: delTwinId })
    check('deleted: dedup-twin row enqueue → 202', (await enq(delId)).status === 202)
    const delRes = await adminReq(ADMIN, 'DELETE', `/api/admin/screenshots/${delId}`)
    check('deleted: DELETE under queue → 200', delRes.status === 200, `(got ${delRes.status})`)
    const delOcr = await adminReq(ADMIN, 'GET', `/api/admin/screenshots/${delId}/ocr`)
    check('deleted: OCR status after delete → 404', delOcr.status === 404, `(got ${delOcr.status})`)
    check('deleted: no orphan processing row', !q('SELECT 1 FROM Screenshot WHERE id=?', delId))
    await adminReq(ADMIN, 'DELETE', `/api/admin/screenshots/${delTwinId}`)

    console.log('\n8) Provider + engine attribution')
    const engRows = qa('SELECT DISTINCT ocrEngine FROM Screenshot WHERE ocrEngine IS NOT NULL')
    check('provider: every processed row engine=tesseract', engRows.length > 0 && engRows.every((r) => r.ocrEngine === 'tesseract'), `(got ${JSON.stringify(engRows)})`)
    const langRow = q("SELECT DISTINCT ocrLanguage FROM Screenshot WHERE ocrLanguage IS NOT NULL AND ocrStatus='completed'")
    check('provider: completed rows language=eng', langRow?.ocrLanguage === 'eng', `(got ${JSON.stringify(langRow)})`)
    const okFail = qa("SELECT count(*) c FROM Screenshot WHERE ocrStatus='completed' AND ocrFailure IS NOT NULL")
    check('provider: completed rows never carry failure code', okFail[0]?.c === 0, `(got ${okFail[0]?.c})`)
    check('provider: engineVersion recorded', qa('SELECT ocrEngineVersion FROM Screenshot WHERE ocrEngineVersion IS NOT NULL LIMIT 1').length > 0)

    console.log('\n9) Concurrency (burst FIFO)')
    const burst = []
    for (let i = 0; i < 4; i++) {
      const id = insertScreenshotRow({ id: cuid(`b${i}`), deviceId: devB.deviceId, sha256: sha256(Buffer.concat([IMG_SALES, Buffer.from(`x${i}:${alnum(6)}`)])), storagePath: helloPath })
      burst.push(id)
      await enq(id)
    }
    let done = 0
    for (const id of burst) {
      const s = await waitStatus(ADMIN, id, ['completed'], 45000)
      if (s?.status === 'completed') done++
    }
    check('burst: 4/4 processed', done === 4, `(got ${done}/4)`)
    const fifo = qa('SELECT id FROM Screenshot WHERE ocrStatus="completed" AND id IN (' + burst.map(() => '?').join(',') + ') ORDER BY ocrQueuedAt ASC, id ASC', ...burst).map((r) => r.id)
    check('burst: FIFO completion order preserved', JSON.stringify(fifo) === JSON.stringify(burst), `(got ${JSON.stringify(fifo)} vs ${JSON.stringify(burst)})`)

    console.log(`\n=========================================================`)
    console.log(`OCR pipeline verification: ${passed} passed, ${failed} failed (${((passed / (passed + failed || 1)) * 100).toFixed(1)}%)`)
    if (failures.length) console.log('\nFailures:\n  ' + failures.join('\n  '))
    process.exit(failed === 0 ? 0 : 1)
  } catch (err) {
    console.error('FATAL:', err)
    console.log(`OCR pipeline verification CRASHED — ${passed} passed, ${failed} failed`)
    process.exitCode = 2
  }
}

await main()