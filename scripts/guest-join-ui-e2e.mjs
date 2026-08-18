// Guest zero-touch enrollment — REAL Electron UI E2E (fresh device).
//
// Launches the freshly built packaged EXE (omnisight-agent/out/win-unpacked/
// OmniSightAgent.exe — the build with the enrollment code BAKED) with:
//   - a genuinely FRESH userData: the existing %APPDATA%\worklensai-agent is
//     moved aside for the duration of the run and restored afterwards (Electron
//     on Windows resolves appData via the known-folder API, NOT the APPDATA env
//     var — so an env override cannot isolate the state). Fresh identity = the
//     true anonymous-join path.
//   - a local sanitizing proxy as the agent's server URL (logs ONLY safe
//     request metadata — field presence/lengths, never the code value)
//   - Electron remote debugging so the ACTUAL renderer button is clicked
//     (the same #btn-cancel-registration handler a mouse click runs)
//
// Flow:
//   1. EXE boots → zero-touch discovery auto-runs → expect 201 (code baked),
//      pending-approval view.
//   2. Drive the ACTUAL UI: click "Cancel registration" → the agent cancels
//      the boot claim server-side and immediately re-discovers → expect a
//      FRESH POST /api/agent/discover with the enrollment code → 201.
//   3. Admin approves the pending claim as GUEST → agent poll (20s cadence)
//      auto-detects → PATH A device-credential auth → heartbeat 200.
//
// NEVER logs the enrollment code — presence and length only. The pre-existing
// agent state is restored even on failure (try/finally).
//
// Prereqs: dev backend on :3000 with the org enrollment code set;
// SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD in .env.
// Run: node scripts/guest-join-ui-e2e.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
// Default: the freshly built EXE. Override with AGENT_EXE=<path> to certify the
// exact installed copy the user launches (e.g. C:/Program Files/OmniSightAgent/OmniSightAgent.exe).
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
  console.error(`EXE not found: ${EXE} — run the agent build first.`);
  process.exit(2);
}

// ── sanitizing proxy: agent → backend; captures ONLY safe metadata ─────────
const discoverLog = [];
const proxy = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const entry = { method: req.method, url: req.url, status: null, body: null };
    let bodyJson = null;
    try { bodyJson = JSON.parse(body.toString('utf8')); } catch { /* non-JSON */ }
    if (req.url === '/api/agent/discover') {
      entry.discover = {
        // deviceKey is the stable machine identity (never a secret) — kept
        // in-memory for the cancel step, never printed.
        deviceKeyValue: typeof bodyJson?.deviceKey === 'string' ? bodyJson.deviceKey : null,
        deviceKey: typeof bodyJson?.deviceKey === 'string' && bodyJson.deviceKey.length >= 16,
        hostname: typeof bodyJson?.hostname === 'string' && bodyJson.hostname.length > 0,
        reRegister: bodyJson?.reRegister === true,
        enrollmentCodePresent: typeof bodyJson?.enrollmentCode === 'string' && bodyJson.enrollmentCode.length > 0,
        enrollmentCodeLength: typeof bodyJson?.enrollmentCode === 'string' ? bodyJson.enrollmentCode.length : 0,
      };
    }
    // Forward only safe hop-by-hop headers (undici forbids connection/content-length).
    const fwd = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'connection', 'content-length', 'transfer-encoding', 'expect', 'upgrade', 'keep-alive'].includes(k)) continue;
      if (typeof v === 'string') fwd[k] = v;
      else if (Array.isArray(v)) fwd[k] = v.join(', ');
    }
    fetch(BACKEND + req.url, {
      method: req.method,
      headers: fwd,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    })
      .then(async (upstream) => {
        entry.status = upstream.status;
        if (req.url === '/api/agent/discover') {
          // capture claimId + secret ONLY for the fresh-claim flow control
          try { entry.body = await upstream.clone().json(); } catch { entry.body = null; }
        }
        discoverLog.push(entry);
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, upstream.headers);
        res.end(buf);
      })
      .catch(() => {
        entry.status = 0;
        discoverLog.push(entry);
        res.writeHead(502);
        res.end('proxy upstream error');
      });
  });
});

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
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
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
    return {
      phaseLabel: label ? label.textContent : null,
      onboard: vis('onboard-view'),
      pending: vis('pending-view'),
      rejected: vis('rejected-view'),
      offline: vis('offline-view'),
      status: vis('status-view'),
    };
  })()`);
}

function envVar(key) {
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp('^' + key + '=(.+)$', 'm'));
  return m ? m[1].trim() : '';
}

// ── userData move-aside (fresh identity) ───────────────────────────────────
const appData = process.env.APPDATA || '';
const realUserData = join(appData, 'worklensai-agent');
const movedUserData = join(appData, 'worklensai-agent.ui-e2e-moved');
let stateMoved = false;

async function moveStateAside() {
  if (!appData) { console.warn('APPDATA not set — running with existing state'); return; }
  if (!existsSync(realUserData)) { console.log('no existing agent state — genuinely fresh run'); return; }
  try {
    rmSync(movedUserData, { recursive: true, force: true }); // stale leftovers
    const fsp = await import('node:fs/promises');
    await fsp.rename(realUserData, movedUserData);
    stateMoved = true;
    console.log(`moved existing agent state aside → ${movedUserData}`);
  } catch (err) {
    console.warn('could not move agent state aside (running with existing state):', err.message);
  }
}

async function restoreState() {
  if (!stateMoved) return;
  try {
    const fsp = await import('node:fs/promises');
    rmSync(realUserData, { recursive: true, force: true }); // the run's fresh state
    await fsp.rename(movedUserData, realUserData);
    stateMoved = false;
    console.log('restored pre-existing agent state');
  } catch (err) {
    console.warn(`could not restore agent state (left at ${movedUserData}):`, err.message);
  }
}

async function main() {
  const adminEmail = envVar('SUPER_ADMIN_EMAIL');
  const adminPass = envVar('SUPER_ADMIN_PASSWORD');
  if (!adminEmail || !adminPass) {
    console.error('SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD missing in .env');
    process.exit(2);
  }

  await moveStateAside();
  let child = null;
  let ws = null;
  try {
    await new Promise((r) => proxy.listen(PROXY_PORT, r));
    console.log(`sanitizing proxy on :${PROXY_PORT} → ${BACKEND}`);

    // ── 1. Launch the ACTUAL freshly built EXE ────────────────────────────
    child = spawn(EXE, [`--remote-debugging-port=${CDP_PORT}`], {
      env: { ...process.env, OMNISIGHT_SERVER_URL: `http://localhost:${PROXY_PORT}` },
      stdio: 'ignore',
    });
    console.log(`launched EXE pid=${child.pid}`);

    let target = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        const list = await cdpJson();
        target = (list || []).find((t) => t.type === 'page' && t.url.startsWith('file://'));
        if (target) break;
      } catch { /* not up yet */ }
    }
    check('1. EXE launched and renderer reachable via CDP', !!target,
      target ? `target=${target.url}` : 'no page target');
    if (!target) return;

    ws = await connect(target.webSocketDebuggerUrl);
    await sleep(1500);
    const bootUi = await readUiState(ws);
    console.log('boot UI state:', JSON.stringify(bootUi));

    // ── 2. Boot auto zero-touch discovery (baked code → expect 201) ───────
    let boot201 = null;
    for (let i = 0; i < 20 && !boot201; i++) {
      const d = discoverLog.filter((e) => e.url === '/api/agent/discover' && e.discover);
      boot201 = d.find((e) => e.status === 201) ?? null;
      if (!boot201) await sleep(500);
    }
    check('2. boot zero-touch discovery → 201 (code baked, NOT 422)',
      !!boot201,
      boot201 ? `status=${boot201.status} codeLen=${boot201.discover.enrollmentCodeLength}` : 'no 201 in proxy log');
    check('2b. boot discover carried the enrollment code',
      !!(boot201 && boot201.discover.enrollmentCodePresent && boot201.discover.enrollmentCodeLength > 0),
      boot201 ? `codeLen=${boot201.discover.enrollmentCodeLength}` : 'no request');

    // ── 3. Drive the ACTUAL UI: "Cancel registration" → FRESH claim ───────
    // The zero-login UI's ONLY employee control. Clicking it makes the agent
    // cancel the boot claim server-side and immediately re-discover, which
    // must issue a FRESH 201 with the baked enrollment code.
    const cancelClick = await clickButton(ws, '#btn-cancel-registration');
    check('3. "Cancel registration" button clicked in the real renderer', cancelClick.clicked === true,
      `clicked=${cancelClick.clicked} visible=${cancelClick.visible}`);
    // The pending view hides the actions row behind a confirm step; confirm it.
    const confirmClick = await clickButton(ws, '#btn-cancel-yes');
    check('3b. cancellation confirmed in the real renderer', confirmClick.clicked === true,
      `clicked=${confirmClick.clicked}`);
    console.log('cancelClick:', JSON.stringify(cancelClick));

    // ── 4. Observe the request the BUTTON produced ────────────────────────
    const before = discoverLog.length;
    let button201 = null;
    for (let i = 0; i < 20 && !button201; i++) {
      await sleep(500);
      const fresh = discoverLog.slice(before).filter((e) => e.url === '/api/agent/discover' && e.discover);
      button201 = fresh.find((e) => e.status === 201) ?? null;
    }
    const buttonReq = discoverLog.slice(before).find((e) => e.url === '/api/agent/discover' && e.discover);
    check('4. UI click produced POST /api/agent/discover', !!buttonReq,
      buttonReq ? `status=${buttonReq.status}` : 'no discover from the click');
    check('4b. click request carries deviceKey + hostname',
      !!(buttonReq && buttonReq.discover.deviceKey && buttonReq.discover.hostname));
    check('4c. click request carries the enrollment code (present, length only)',
      !!(buttonReq && buttonReq.discover.enrollmentCodePresent),
      buttonReq ? `codeLen=${buttonReq.discover.enrollmentCodeLength}` : 'no request');
    check('5. cancel-registration click → server 201 (fresh pending claim, NOT 422)',
      !!button201,
      buttonReq ? `status=${buttonReq.status}` : 'no request');

    const uiAfter = await readUiState(ws);
    console.log('UI after cancel registration:', JSON.stringify(uiAfter));

    // ── 5. Admin approves as GUEST → agent poll → PATH A auth → heartbeat ─
    const loginRes = await fetch(`${BACKEND}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPass }),
    });
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    check('6. admin session obtained', loginRes.status === 200 && !!cookie, `status=${loginRes.status}`);

    const host = osHostname();
    let claim = null;
    for (let attempt = 0; attempt < 6 && !claim; attempt++) {
      const list = await fetch(`${BACKEND}/api/device-claims?status=pending&pageSize=100`, {
        headers: { Cookie: cookie },
      });
      const json = await list.json().catch(() => ({}));
      claim = (json?.data ?? []).find((c) => c.status === 'pending' && c.device?.hostname === host);
      if (!claim) await sleep(2000);
    }
    check('7. admin sees the pending guest device claim', !!claim,
      claim ? `claim=${claim.id.slice(0, 8)}` : 'not found');

    if (claim) {
      const approve = await fetch(`${BACKEND}/api/device-claims/${claim.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ mode: 'guest' }),
      });
      const approveJson = await approve.json().catch(() => ({}));
      check('8. admin approves as GUEST', approve.status === 200, `status=${approve.status}`);
      check('8b. guest identity synthesized (GUEST-*)',
        /^GUEST-[0-9A-F]{12}$/.test(approveJson?.data?.employee?.employeeId ?? ''),
        `employeeId=${approveJson?.data?.employee?.employeeId ?? ''}`);
    }

    let authenticated = false;
    let hbOk = false;
    for (let i = 0; i < 40 && !(authenticated && hbOk); i++) {
      await sleep(3000);
      const ui = await readUiState(ws);
      if (ui.status) authenticated = true;
      const hb = discoverLog.filter((e) => e.url && e.url.startsWith('/api/agent/heartbeat'));
      if (hb.some((e) => e.status === 200)) hbOk = true;
      if (i % 5 === 0) console.log(`  waiting… ui.status=${ui.status} hbOk=${hbOk} (${i * 3}s)`);
    }
    check('9. agent auto-detected approval → authenticated (status view)', authenticated);
    check('10. heartbeat succeeds with the guest token', hbOk);
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    try { if (child) child.kill(); } catch { /* ignore */ }
    await sleep(800);
    try { if (child) child.kill('SIGKILL'); } catch { /* ignore */ }
    try { proxy.close(); } catch { /* ignore */ }
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
