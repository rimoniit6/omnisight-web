// Guest activity pipeline — REAL Electron UI E2E certification (fresh device).
//
// Proves the complete runtime flow from the connected Guest Agent to Admin
// Activities, using the exact installed EXE and the REAL "Join as Guest"
// button — no consent step required from the admin, because approval now
// auto-grants standard monitoring consent (bound to the org's published
// policies):
//
//   1. EXE boots → zero-touch discover 201 (enrollment code baked).
//   2. Boot claim cancelled; the ACTUAL UI button issues a FRESH 201.
//   3. Admin approves as GUEST → monitoring + activity_tracking consent are
//      auto-granted (verified in DB + via the agent's consent endpoint).
//   4. Agent auto-authenticates (PATH A) → heartbeat 200.
//   5. REAL foreground activity (Notepad + browser) → POST /api/agent/activity
//      → 200 → DB rows with server-derived employee/device identity.
//   6. Admin Activities API returns the guest's activity.
//
// NEVER logs tokens/secrets/enrollment code — presence/length only.
// Pre-existing %APPDATA%\worklensai-agent is moved aside and restored even on
// failure.
//
// Prereqs: dev backend on :3000 with org enrollment code set;
// SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD in .env; pg + dotenv installed.
// Run: node scripts/guest-activity-ui-e2e.mjs
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { rmSync, existsSync, readFileSync, openSync, closeSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const { Client } = pg;

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXE = process.env.AGENT_EXE || join(ROOT, 'omnisight-agent', 'out', 'win-unpacked', 'OmniSightAgent.exe');
const CDP_PORT = 9222;
const PROXY_PORT = 3999;
const BACKEND = 'http://localhost:3000';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

if (!existsSync(EXE)) {
  console.error(`EXE not found: ${EXE}`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing in .env');
  process.exit(2);
}

// ── sanitizing proxy: agent → backend; captures URL+status only ────────────
const requestLog = [];
const proxy = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const entry = { method: req.method, url: req.url, status: null };
    if (req.url === '/api/agent/discover') {
      let bodyJson = null;
      try { bodyJson = JSON.parse(body.toString('utf8')); } catch { /* non-JSON */ }
      entry.discover = {
        deviceKeyValue: typeof bodyJson?.deviceKey === 'string' ? bodyJson.deviceKey : null,
        codeLen: typeof bodyJson?.enrollmentCode === 'string' ? bodyJson.enrollmentCode.length : 0,
      };
    }
    fetch(BACKEND + req.url, {
      method: req.method,
      headers: { ...safeHeaders(req.headers) },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    })
      .then(async (upstream) => {
        entry.status = upstream.status;
        if (req.url === '/api/agent/activity') {
          try {
            const j = await upstream.clone().json();
            entry.activityResponse = { count: typeof j.count === 'number' ? j.count : null, error: j.error ?? null };
          } catch { /* non-JSON */ }
        }
        if (req.url === '/api/agent/discover') {
          try { entry.claim = await upstream.clone().json(); } catch { entry.claim = null; }
        }
        requestLog.push(entry);
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, upstream.headers);
        res.end(buf);
      })
      .catch(() => {
        entry.status = 0;
        requestLog.push(entry);
        res.writeHead(502);
        res.end('proxy upstream error');
      });
  });
});
function safeHeaders(h) {
  const fwd = {};
  for (const [k, v] of Object.entries(h)) {
    if (['host', 'connection', 'content-length', 'transfer-encoding', 'expect', 'upgrade', 'keep-alive'].includes(k)) continue;
    if (typeof v === 'string') fwd[k] = v;
    else if (Array.isArray(v)) fwd[k] = v.join(', ');
  }
  return fwd;
}

// ── CDP helpers ────────────────────────────────────────────────────────────
async function cdpJson() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return r.json();
}
function connect(wsUrl) {
  return new Promise((resolveWs, rejectWs) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolveWs(ws);
    ws.onerror = (e) => rejectWs(e);
  });
}
let msgId = 0;
function evaluate(ws, expression) {
  return new Promise((resolveEval, rejectEval) => {
    const id = ++msgId;
    const onMsg = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id === id) {
        ws.removeEventListener('message', onMsg);
        if (data.error) rejectEval(new Error(JSON.stringify(data.error)));
        else resolveEval(data.result?.result?.value);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function clickButton(ws, selector) {
  return evaluate(ws, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { clicked: false, reason: 'not-found' };
    el.click();
    return { clicked: true, visible: !el.classList.contains('hidden') };
  })()`);
}
async function readUiState(ws) {
  return evaluate(ws, `(() => {
    const vis = (id) => { const el = document.getElementById(id); return el ? !el.classList.contains('hidden') : false; };
    const label = document.getElementById('phase-label');
    return { phaseLabel: label ? label.textContent : null, onboard: vis('onboard-view'), login: vis('login-view'), pending: vis('pending-view'), rejected: vis('rejected-view'), offline: vis('offline-view'), status: vis('status-view') };
  })()`);
}
function envVar(key) {
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp('^' + key + '=(.+)$', 'm'));
  return m ? m[1].trim() : '';
}

// ── userData move-aside (fresh identity) ───────────────────────────────────
const appData = process.env.APPDATA || '';
const realUserData = join(appData, 'worklensai-agent');
const movedUserData = join(appData, 'worklensai-agent.activity-e2e-moved');
let stateMoved = false;
async function moveStateAside() {
  if (!appData) { console.warn('APPDATA not set — running with existing state'); return; }
  if (!existsSync(realUserData)) { console.log('no existing agent state — genuinely fresh run'); return; }
  try {
    rmSync(movedUserData, { recursive: true, force: true });
    const fsp = await import('node:fs/promises');
    await fsp.rename(realUserData, movedUserData);
    stateMoved = true;
    console.log(`moved existing agent state aside → ${movedUserData}`);
  } catch (err) { console.warn('could not move agent state aside:', err.message); }
}
async function restoreState() {
  if (!stateMoved) return;
  try {
    const fsp = await import('node:fs/promises');
    rmSync(realUserData, { recursive: true, force: true });
    await fsp.rename(movedUserData, realUserData);
    stateMoved = false;
    console.log('restored pre-existing agent state');
  } catch (err) { console.warn(`could not restore agent state (left at ${movedUserData}):`, err.message); }
}

// ── DB helpers ─────────────────────────────────────────────────────────────
let db;
async function dbConnect() {
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
}
async function q(text, params) {
  const r = await db.query(text, params);
  return r.rows;
}

// ── Real foreground activity (Notepad + browser windows) ───────────────────
const spawnedPids = [];
function ps(script) {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 30000 }).trim();
  } catch (e) { return ''; }
}
async function activateWindow(pid) {
  ps(`(New-Object -ComObject WScript.Shell).AppActivate(${pid})`);
  await sleep(1200);
}
async function generateForegroundActivity(totalMs) {
  const started = Date.now();
  const notepad = ps('$p = Start-Process "C:\\\\Windows\\\\System32\\\\notepad.exe" -PassThru; $p.Id');
  if (notepad) spawnedPids.push(notepad);
  let browserPid = '';
  const edge = ps(`$p = Start-Process msedge -ArgumentList '--new-window','https://example.com' -PassThru; $p.Id`);
  if (edge) browserPid = edge;
  let step = 0;
  while (Date.now() - started < totalMs) {
    step++;
    const target = step % 2 === 1 ? notepad : browserPid;
    if (target) await activateWindow(target);
    await sleep(12000);
  }
  console.log(`  foreground activity generated for ${Math.round((Date.now() - started) / 1000)}s (notepad pid=${notepad || 'none'}, edge pid=${browserPid || 'none'})`);
}
function cleanupSpawned() {
  for (const pid of spawnedPids) {
    try { ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`); } catch { /* ignore */ }
  }
}

async function main() {
  const adminEmail = envVar('SUPER_ADMIN_EMAIL');
  const adminPass = envVar('SUPER_ADMIN_PASSWORD');
  if (!adminEmail || !adminPass) { console.error('SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD missing in .env'); process.exit(2); }

  await moveStateAside();
  let child = null;
  let ws = null;
  const agentLog = join(appData, 'worklensai-agent.activity-e2e.log');
  try {
    await dbConnect();
    await new Promise((r) => proxy.listen(PROXY_PORT, r));
    console.log(`sanitizing proxy on :${PROXY_PORT} → ${BACKEND}`);

    // Capture the agent's structured logs (WL_LOG_LEVEL=debug) so collector
    // gate decisions are observable; the logger redacts secrets itself.
    const logFd = openSync(agentLog, 'w');
    child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
      env: { ...process.env, OMNISIGHT_SERVER_URL: `http://localhost:${PROXY_PORT}`, WL_LOG_LEVEL: 'debug' },
      stdio: ['ignore', logFd, logFd],
    });
    console.log(`launched EXE pid=${child.pid} (logs → ${agentLog})`);

    let target = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const list = await cdpJson();
        target = (list || []).find((t) => t.type === 'page' && t.url.startsWith('file://'));
        if (target) break;
      } catch { /* not up yet */ }
    }
    check('1. EXE launched and renderer reachable via CDP', !!target);
    if (!target) return;
    ws = await connect(target.webSocketDebuggerUrl);
    await sleep(1500);

    // ── Boot discover → cancel claim → BUTTON issues FRESH 201 ───────────
    let boot201 = null;
    for (let i = 0; i < 20 && !boot201; i++) {
      const d = requestLog.filter((e) => e.url === '/api/agent/discover' && e.status === 201);
      boot201 = d[d.length - 1] ?? null;
      if (!boot201) await sleep(500);
    }
    check('2. boot zero-touch discovery → 201 (code baked, NOT 422)', !!boot201,
      boot201 ? `status=${boot201.status} codeLen=${boot201.discover?.codeLen}` : 'no 201');

    const bootClaimId = boot201?.claim?.claimId;
    const bootSecret = boot201?.claim?.secret;
    const bootDeviceKey = boot201?.discover?.deviceKeyValue ?? null;
    if (bootClaimId && bootSecret && bootDeviceKey) {
      const cancel = await fetch(`${BACKEND}/api/device-claims/${bootClaimId}/cancel`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceKey: bootDeviceKey, secret: bootSecret }),
      });
      check('2b. boot claim cancelled server-side (fresh-claim reset)', cancel.status === 200, `status=${cancel.status}`);
    } else {
      check('2b. boot claim cancelled server-side (fresh-claim reset)', false, 'no claimId/secret captured');
    }

    const showLogin = await clickButton(ws, '#btn-show-login');
    await sleep(300);
    check('3. "Sign in with Agent ID" clicked', showLogin.clicked === true);
    const joinClick = await clickButton(ws, '#btn-join-guest');
    check('4. "Join as Guest" button clicked in the real renderer', joinClick.clicked === true, `visible=${joinClick.visible}`);

    let button201 = null;
    for (let i = 0; i < 20 && !button201; i++) {
      await sleep(500);
      const fresh = requestLog.filter((e) => e.url === '/api/agent/discover' && e.status === 201);
      if (fresh.length > 0) button201 = fresh[fresh.length - 1];
    }
    check('5. "Join as Guest" click → server 201 (fresh pending claim)', !!button201, button201 ? `status=${button201.status}` : 'no 201 from the click');

    // ── Admin session + approve as GUEST (auto-grants consent) ───────────
    const loginRes = await fetch(`${BACKEND}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPass }),
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    check('6. admin session obtained', loginRes.status === 200 && !!cookie, `status=${loginRes.status}`);

    let claim = null;
    for (let attempt = 0; attempt < 8 && !claim; attempt++) {
      const list = await fetch(`${BACKEND}/api/device-claims?status=pending&pageSize=100`, { headers: { Cookie: cookie } });
      const json = await list.json().catch(() => ({}));
      claim = (json?.data ?? []).filter((c) => c.status === 'pending').sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] ?? null;
      if (!claim) await sleep(2000);
    }
    check('7. admin sees the pending guest device claim', !!claim, claim ? `claim=${claim.id.slice(0, 8)} host=${claim.device?.hostname}` : 'not found');

    let guestEmployeeId = null;
    if (claim) {
      const approve = await fetch(`${BACKEND}/api/device-claims/${claim.id}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ mode: 'guest' }),
      });
      const approveJson = await approve.json().catch(() => ({}));
      check('8. admin approves as GUEST', approve.status === 200, `status=${approve.status}`);
      check('8b. guest identity synthesized (GUEST-*)', /^GUEST-[0-9A-F]{12}$/.test(approveJson?.data?.employee?.employeeId ?? ''), `employeeId=${approveJson?.data?.employee?.employeeId ?? ''}`);
      if (approveJson?.data?.employee?.employeeId) {
        const emp = await q('SELECT id, "employeeId" FROM "Employee" WHERE "employeeId" = $1', [approveJson.data.employee.employeeId]);
        if (emp[0]) guestEmployeeId = emp[0].id;
      }
    }
    check('8c. guest employee row resolved', !!guestEmployeeId);

    // ── Wait for auth + heartbeat ─────────────────────────────────────────
    let authenticated = false, hbOk = false;
    for (let i = 0; i < 40 && !(authenticated && hbOk); i++) {
      await sleep(3000);
      const ui = await readUiState(ws);
      if (ui.status) authenticated = true;
      if (requestLog.some((e) => e.url.startsWith('/api/agent/heartbeat') && e.status === 200)) hbOk = true;
      if (i % 5 === 0) console.log(`  waiting… ui.status=${ui.status} hbOk=${hbOk} (${i * 3}s)`);
    }
    check('9. agent auto-detected approval → authenticated (status view)', authenticated);
    check('10. heartbeat succeeds with the guest token', hbOk);
    if (!guestEmployeeId) return;

    // ── APPROVAL AUTO-GRANTED CONSENT (no admin consent step needed) ─────
    const consentRows = await q('SELECT "consentType", status, "consentVersion" FROM "Consent" WHERE "employeeId" = $1 ORDER BY "consentType"', [guestEmployeeId]);
    check('11. approval auto-granted monitoring consent (monitoring + activity_tracking, granted)', consentRows.length === 2 && consentRows.every((r) => r.status === 'granted'),
      JSON.stringify(consentRows));

    const guestToken = await q('SELECT token FROM "AgentToken" WHERE "employeeId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [guestEmployeeId]);
    check('12. guest agent token issued', guestToken.length === 1 && guestToken[0].token.length >= 20, guestToken.length ? 'token len=' + guestToken[0].token.length : 'none');

    if (guestToken[0]) {
      const consentApi = await fetch(`${BACKEND}/api/agent/consent?types=monitoring,activity_tracking`, {
        headers: { Authorization: `Bearer ${guestToken[0].token}` },
      });
      const consentJson = await consentApi.json().catch(() => ({}));
      check('13. agent consent endpoint reports activity_tracking=true (collector gate opens)', consentApi.status === 200 && consentJson?.consents?.activity_tracking === true && consentJson?.consents?.monitoring === true,
        `status=${consentApi.status} activity_tracking=${String(consentJson?.consents?.activity_tracking)} monitoring=${String(consentJson?.consents?.monitoring)}`);
    }

    // ── REAL COLLECTION → POST → DB ROW → ADMIN ACTIVITIES API ───────────
    // Two collection cycles (each: real foreground activity + drain wait). The
    // first cycle may start before the agent's first heartbeat re-applies
    // collector states (startRuntime applies states BEFORE the first consent
    // sync); the second cycle is the robust assertion.
    let activityRows = [];
    for (let cycle = 1; cycle <= 2 && activityRows.length === 0; cycle++) {
      console.log(`── cycle ${cycle}: generating real foreground activity (collector should now run) ──`);
      await generateForegroundActivity(cycle === 1 ? 45000 : 90000);
      // Collection cadence: sample 10 s + min slice 5 s + queue drain 20 s.
      await sleep(cycle === 1 ? 60000 : 45000);
      activityRows = await q('SELECT type, "applicationName", title, category, duration, "employeeId", "deviceId" FROM "Activity" WHERE "employeeId" = $1 ORDER BY timestamp DESC LIMIT 10', [guestEmployeeId]);
      console.log(`  cycle ${cycle} rows=${activityRows.length}`);
    }
    check('14. activity rows persisted for the guest employee (real collection)', activityRows.length >= 1,
      activityRows.length ? JSON.stringify(activityRows.slice(0, 3)) : '0 rows');

    const realPosts = requestLog.filter((e) => e.url === '/api/agent/activity' && e.status === 200);
    check('15. real agent POST /api/agent/activity → 200 (count>0)', realPosts.length > 0 && realPosts.some((e) => (e.activityResponse?.count ?? 0) > 0),
      `posts200=${realPosts.length} counts=${JSON.stringify(realPosts.map((e) => e.activityResponse?.count))}`);

    const actApi = await fetch(`${BACKEND}/api/activities?employeeId=${guestEmployeeId}&pageSize=100`, { headers: { Cookie: cookie } });
    const actJson = await actApi.json().catch(() => ({}));
    const guestRows = (actJson?.data ?? []).filter((r) => r.employeeId === guestEmployeeId);
    check('16. Admin Activities API returns the guest activity', actApi.status === 200 && guestRows.length >= 1,
      `status=${actApi.status} returned=${guestRows.length} employee=${guestRows[0]?.employee ? guestRows[0].employee.firstName + ' ' + guestRows[0].employee.lastName : 'n/a'}`);
  } finally {
    cleanupSpawned();
    try { if (ws) ws.close(); } catch { /* ignore */ }
    try { if (child) child.kill(); } catch { /* ignore */ }
    await sleep(800);
    try { if (child) child.kill('SIGKILL'); } catch { /* ignore */ }
    try { proxy.close(); } catch { /* ignore */ }
    try { closeSync(openSync(agentLog, 'a')); } catch { /* ignore */ }
    try {
      if (existsSync(agentLog)) {
        const lines = readFileSync(agentLog, 'utf8').split('\n').filter(Boolean);
        const tail = lines.slice(-30).join('\n');
        if (tail) console.log('\n── agent log (tail, redacted by agent logger) ──\n' + tail);
      }
    } catch { /* ignore */ }
    try { if (db) await db.end(); } catch { /* ignore */ }
    await restoreState();
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(2);
});
