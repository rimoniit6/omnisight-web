import 'dotenv/config';
import { readFileSync } from 'fs';
import { io as Socket } from 'socket.io-client';
import { signJWT } from '@/lib/auth';
import { PrismaClient } from '@prisma/client';

interface State {
  tokens: Record<string, string>;
  orgs: Record<string, { id: string; emp: string; dev: string; empCode: string }>;
  custDb: { host: string; port: number; name: string; user: string; password: string };
}

const state: State = JSON.parse(readFileSync('scripts/e2e/state.json', 'utf8'));
const capture = process.env.E2E_CAPTURE ?? 'C:\\Users\\mdrim\\AppData\\Local\\Temp\\opencode\\e2e-capture.png';
const base = 'http://localhost:3000';
let failures = 0;

function fail(msg: string, err?: unknown) {
  failures++;
  console.error(`FAIL: ${msg}`, err ?? '');
}
function ok(label: string, detail?: string) {
  console.log(`PASS: ${label}${detail ? ' — ' + detail : ''}`);
}
function assert(label: string, cond: boolean, detail?: string) {
  if (cond) ok(label, detail);
  else fail(label);
}

async function mintJwt(userId: string, orgId: string, sessionId: string) {
  return signJWT({ userId, email: 'e2e.manager@omnisight.test', role: 'manager', organizationId: orgId, activeOrganizationId: orgId, sessionId });
}

async function getConfig(token: string) {
  const res = await fetch(`${base}/api/agent/config`, { headers: { authorization: `Bearer ${token}` } });
  const json = (await res.json()) as any;
  return { status: res.status, body: json };
}

async function uploadScreenshot(token: string, file: string) {
  const blob = new Blob([readFileSync(file)], { type: 'image/png' });
  const fd = new FormData();
  fd.set('screenshot', blob, 'e2e-capture.png');
  fd.set('timestamp', new Date().toISOString());
  fd.set('appWindow', 'E2E Test Window');
  const res = await fetch(`${base}/api/agent/screenshot`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  let json: any;
  try {
    json = await res.json();
  } catch {
    json = { rawBody: (await res.text()).slice(0, 120) };
  }
  return { status: res.status, body: json };
}

async function withSocket(orgId: string, sessionId: string, fn: (sock: ReturnType<typeof Socket>) => Promise<void>) {
  const jwt = await mintJwt('user-e2e-mgr', orgId, sessionId);
  const sock = Socket('http://localhost:3010', { auth: { token: jwt }, transports: ['websocket'], reconnection: false, timeout: 5000 });
  await new Promise<void>((resolve, reject) => {
    sock.on('connect', () => resolve());
    sock.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
  try {
    await fn(sock);
  } finally {
    sock.disconnect();
  }
}

async function main() {
  const db = new PrismaClient();
  const custDb = new PrismaClient({
    datasources: { db: { url: `postgresql://${encodeURIComponent(state.custDb.user)}:${encodeURIComponent(state.custDb.password)}@${state.custDb.host}:${state.custDb.port}/${state.custDb.name}` } },
  });

  // ---- 1. MANAGED config + upload + socket event (Issue A) ----
  console.log('\n=== MANAGED ===');
  const mgmt = await getConfig(state.tokens.mgmt);
  assert('MANAGED config 200', mgmt.status === 200);
  assert('MANAGED config screenshotFrequency=5', mgmt.body.config.monitoring.screenshotFrequency === 5, JSON.stringify(mgmt.body.config.monitoring.screenshotFrequency));
  assert('MANAGED config screenshotEnabled=true', mgmt.body.config.monitoring.screenshotEnabled === true);

  await withSocket(state.orgs.mgmt.id, 'ws-sess-mgmt', async (sock) => {
    const events: any[] = [];
    sock.on('new-screenshot', (e) => events.push(e));
    const up = await uploadScreenshot(state.tokens.mgmt, capture);
    assert('MANAGED upload 200', up.status === 200 && up.body.success, JSON.stringify(up.body));
    const row = await db.screenshot.findFirst({ where: { organizationId: state.orgs.mgmt.id, employeeId: state.orgs.mgmt.emp } });
    assert('MANAGED Screenshot row exists', !!row && !!row.filePath && row.width === 1536 && row.height === 864, JSON.stringify(row ? { w: row.width, h: row.height } : null));
    assert('MANAGED realtime signal absent', (await db.realtimeScreenshotEvent.count({ where: { organizationId: state.orgs.mgmt.id } })) === 0, 'MANAGED skipped signal write as expected');
    await sleep(7000);
    assert('MANAGED socket event received', events.length > 0, JSON.stringify(events));
  });

  // ---- 2. CUSTOMER_DB config + upload + socket event + signal (Issue B) ----
  console.log('\n=== CUSTOMER_DB ===');
  const cust = await getConfig(state.tokens.cust);
  assert('CUSTOMER config 200', cust.status === 200);
  assert('CUSTOMER config screenshotFrequency=5', cust.body.config.monitoring.screenshotFrequency === 5, JSON.stringify(cust.body.config.monitoring.screenshotFrequency));
  assert('CUSTOMER config deployment mode=CUSTOMER_DB', cust.body.deployment.mode === 'CUSTOMER_DB');

  await withSocket(state.orgs.cust.id, 'ws-sess-cust', async (sock) => {
    const events: any[] = [];
    sock.on('new-screenshot', (e) => events.push(e));
    const up = await uploadScreenshot(state.tokens.cust, capture);
    assert('CUSTOMER upload 200', up.status === 200 && up.body.success, JSON.stringify(up.body));
    const custRow = await custDb.screenshot.findFirst({ where: { organizationId: state.orgs.cust.id, employeeId: state.orgs.cust.emp } });
    assert('CUSTOMER Screenshot row in customer DB', !!custRow && !!custRow.filePath && custRow.width === 1536, JSON.stringify(custRow ? { w: custRow.width, h: custRow.height } : null));
    const signal = await db.realtimeScreenshotEvent.findFirst({ where: { organizationId: state.orgs.cust.id, employeeId: state.orgs.cust.emp } });
    assert('CUSTOMER RealtimeScreenshotEvent signal row', !!signal && !!signal.capturedAt, JSON.stringify(signal ? { id: signal.id } : null));
    await sleep(7000);
    assert('CUSTOMER socket event received (the fix!)', events.length > 0, JSON.stringify(events));
  });

  // ---- 3. DISABLED org: config=0, upload 403 ----
  console.log('\n=== DISABLED ===');
  const dis = await getConfig(state.tokens.disabled);
  assert('DISABLED config 200', dis.status === 200);
  assert('DISABLED config screenshotFrequency=0', dis.body.config.monitoring.screenshotFrequency === 0, JSON.stringify(dis.body.config.monitoring.screenshotFrequency));
  const disUp = await uploadScreenshot(state.tokens.disabled, capture);
  assert('DISABLED upload 403 (interval=0)', disUp.status === 403 && (disUp.body.error === 'SCREENSHOT_INTERVAL_DISABLED'), JSON.stringify(disUp.body));

  // ---- 4. Org isolation ----
  console.log('\n=== ISOLATION ===');
  await withSocket(state.orgs.mgmt.id, 'ws-sess-mgmt', async (mgrSock) => {
    await withSocket(state.orgs.cust.id, 'ws-sess-cust', async (custSock) => {
      const mgrEvents: any[] = [];
      const custEvents: any[] = [];
      mgrSock.on('new-screenshot', (e) => mgrEvents.push(e));
      custSock.on('new-screenshot', (e) => custEvents.push(e));
      await uploadScreenshot(state.tokens.cust, capture);
      await sleep(6000);
      assert('MANAGED socket NOT receiving CUSTOMER events', mgrEvents.length === 0, JSON.stringify(mgrEvents));
      assert('CUSTOMER socket received its own event', custEvents.length > 0, JSON.stringify(custEvents));
    });
  });

  // ---- 5. Unauthorized (401) ----
  console.log('\n=== AUTH ===');
  const bad = await getConfig('invalid-token-value-that-is-long-enough-to-pass-the-20-char-gate');
  assert('Auth 401 on invalid token', bad.status === 401, JSON.stringify(bad.body));

  console.log('\n--- DONE ---');
  if (failures) {
    process.exitCode = 1;
  }
  await Promise.all([db.$disconnect(), custDb.$disconnect()]);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});