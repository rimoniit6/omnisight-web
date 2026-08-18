/**
 * Phase B.5 — REAL packaged-EXE E2E against a live server + throwaway DB.
 *
 * Proves the acceptance journey WITHOUT any employee input:
 *   packaged OmniSightAgent.exe
 *     -> automatic device discovery (no Employee ID / password)
 *     -> device appears in Admin as PENDING with real metadata
 *     -> admin approves (binds employee; department from employee)
 *     -> agent's 20s approval poll detects it
 *     -> automatic PATH A authentication -> AgentToken issued
 *     -> config sync carries employee name / department / projects
 *
 * Run:  node scripts/zt-b5-e2e.mjs   (from the project root; server + EXE are
 *       launched as child processes and cleaned up at the end)
 * Env:  EXE_PATH (default omnisight-agent/out/win-unpacked/OmniSightAgent.exe)
 */
import { spawn, spawnSync } from 'node:child_process';
import { rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = process.cwd();
// Unique throwaway DB per run — never collides with a file locked by a
// zombie process from an earlier interrupted run.
const DB_NAME = `e2e-b5-${Date.now()}.db`;
const DB_PATH = resolve(ROOT, 'db', DB_NAME);
// ABSOLUTE file URL — prisma CLI and the runtime Prisma Client resolve
// relative sqlite paths from DIFFERENT directories; absolute removes doubt.
const DB_URL = `file:${DB_PATH.replace(/\\/g, '/')}`;
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const EXE = process.env.EXE_PATH || resolve(ROOT, 'omnisight-agent/out/win-unpacked/OmniSightAgent.exe');
const ADMIN_EMAIL = 'admin@b5e2e.local';
const ADMIN_PASS = 'AdminPass123!';
const JWT_SECRET = 'b5-e2e-jwt-secret-0123456789abcdef0123456789';
// P2-3: anonymous zero-touch discover requires an EXPLICIT enrollment code.
// Seeded on the org below; provisioned to the EXE via WL_ENROLLMENT_CODE.
const ENROLL_CODE = 'e2e-b5-enroll-0123456789abcdef';
// Packaged EXE userData — wiped before launch so the test starts from a
// genuinely FRESH install (no stored token/claim from an earlier run).
const AGENT_USERDATA = join(process.env.APPDATA || '', 'worklensai-agent');
const USERDATA_BACKUP = `${AGENT_USERDATA}.zt-e2e-bak`;

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = (m) => console.log(`\n${m}`);

/** Network-safe JSON GET/POST — never throws (returns null on transport error). */
async function safeFetch(path, { method = 'GET', token = null, body = null, ip = '203.0.113.240' } = {}) {
  try {
    const headers = { 'x-forwarded-for': ip };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== null) headers['content-type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== null ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch {
    return null; // transport error (server down / killed) — handled by callers
  }
}

/** Wait (polling) for a condition; returns null on timeout instead of throwing. */
async function waitFor(pred, timeoutMs, label) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try { last = await pred(); } catch { last = null; }
    if (last) return last;
    await sleep(2000);
  }
  return null;
}

async function adminLogin() {
  const res = await safeFetch('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASS } });
  if (!res) return { status: 0, token: null };
  if (res.status !== 200) console.log('  login response:', JSON.stringify(res.body).slice(0, 200));
  return { status: res.status, token: res.body.token };
}

/** Write a throwaway helper script and run it with node (no -e quoting traps).
 * The file must live under the project so require('@prisma/client') resolves
 * against the repo's node_modules. */
function runNodeScript(code, env) {
  const file = join(ROOT, 'scripts', '.zt-b5-helper.cjs');
  writeFileSync(file, code);
  const out = spawnSync('node', [file], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
  try { rmSync(file, { force: true }); } catch {}
  return { stdout: out.stdout || '', stderr: out.stderr || '', status: out.status };
}

/** Count consent rows in the throwaway DB via Prisma (same pattern as seeding). */
function countConsents(employeeId) {
  const out = runNodeScript(
    `const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url: process.env.WL_DB_URL } } });
db.consent.count({ where: { employeeId: process.env.WL_EMP } })
  .then((c) => { console.log('COUNT ' + c); return db.$disconnect(); })
  .catch((e) => { console.error(e); process.exit(1); });`,
    { WL_DB_URL: DB_URL, WL_EMP: employeeId }
  );
  const m = /COUNT (\d+)/.exec(out.stdout || '');
  return m ? Number(m[1]) : -1;
}

// ── 0. Free the E2E port from any leftover process ─────────────────────────
function killPortListeners() {
  try {
    const out = spawnSync('netstat -ano', [], { shell: true, encoding: 'utf8' }).stdout || '';
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(`:${PORT}`) && line.includes('LISTENING')) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
    }
    for (const pid of pids) spawnSync(`taskkill //F //PID ${pid}`, [], { shell: true, stdio: 'ignore' });
  } catch { /* best effort */ }
}
killPortListeners();
await sleep(1500);

// ── 1. Throwaway DB ─────────────────────────────────────────────────────────
LOG('=== 1. Fresh throwaway DB ===');
console.log('  db url:', DB_URL);
rmSync(DB_PATH, { force: true });
const push = spawnSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', [], {
  cwd: ROOT,
  env: { ...process.env, DATABASE_URL: DB_URL },
  shell: true,
  stdio: 'pipe',
});
if (push.status !== 0) {
  console.error(String(push.stderr ?? push.stdout ?? 'prisma push failed').slice(0, 2000));
  process.exit(1);
}
console.log('  schema pushed');

// ── 2. Seed: first org (discover targets it), admin, employee, dept, project ─
LOG('=== 2. Seed ===');
// Values travel via env (never string-interpolated into the -e script).
const seedCode = `
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const db = new PrismaClient({ datasources: { db: { url: process.env.WL_DB_URL } } });
(async () => {
  const org = await db.organization.create({ data: { name: 'B5 E2E Org', slug: 'b5-e2e-org' } });
  const { createHash } = require('crypto');
  const hashCode = (code) => createHash('sha256').update('wl-enroll:' + code).digest('hex');
  await db.organizationSetting.create({
    data: { organizationId: org.id, key: 'agent_enrollment_code', value: hashCode(process.env.WL_ENROLL_CODE), category: 'agent' },
  });
  const dept = await db.department.create({ data: { name: 'E2E Engineering', organizationId: org.id } });
  const emp = await db.employee.create({
    data: { employeeId: 'EMP-B5', firstName: 'E2E', lastName: 'Employee', email: 'emp-b5@test.local',
      organizationId: org.id, status: 'active', departmentId: dept.id, agentApproved: false },
  });
  await db.project.create({ data: { name: 'E2E Project Alpha', organizationId: org.id, status: 'active' } });
  await db.appUser.create({
    data: { email: process.env.WL_ADMIN_EMAIL, name: 'B5 Admin', role: 'admin', organizationId: org.id,
      password: bcrypt.hashSync(process.env.WL_ADMIN_PASS, 10), isActive: true },
  });
  console.log('SEEDED_EMP ' + emp.id);
  await db.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
`;
const seedRun = runNodeScript(seedCode, { WL_DB_URL: DB_URL, WL_ADMIN_EMAIL: ADMIN_EMAIL, WL_ADMIN_PASS: ADMIN_PASS, WL_ENROLL_CODE: ENROLL_CODE });
const seeded = /SEEDED_EMP (\S+)/.exec(seedRun.stdout || '');
if (!seeded) {
  console.error('seed failed:', (seedRun.stderr || seedRun.stdout || '').slice(0, 1500));
  process.exit(1);
}
const EMP_ID = seeded[1];
console.log('  seeded (org + admin + employee + dept + project)');

// ── 3. Start the built Next.js server on :3100 with the throwaway DB ───────
LOG('=== 3. Start server :3100 ===');
const server = spawn(`npx next start -p ${PORT}`, [], {
  cwd: ROOT,
  env: {
    ...process.env,
    DATABASE_URL: DB_URL,
    NODE_ENV: 'production',
    JWT_SECRET,
    SUPER_ADMIN_EMAIL: ADMIN_EMAIL,
    SUPER_ADMIN_PASSWORD: ADMIN_PASS,
    NODE_OPTIONS: '--max-old-space-size=768',
  },
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

try {
  const ready = await waitFor(async () => {
    // Deliberately invalid payload: a reachable route returns 400 with no
    // side effects (no device/claim created for the health check).
    const r = await safeFetch('/api/agent/discover', { method: 'POST', body: { deviceKey: 'hc', hostname: 'hc' } });
    return r?.status === 400 ? true : null;
  }, 60_000, 'server ready');
  if (!ready) {
    console.error('  server never became ready. server log tail:');
    console.error(serverLog.split('\n').slice(-20).join('\n') || '  (no log output)');
    throw new Error('server not ready');
  }
  console.log('  server up');

  // ── 4. Launch the PACKAGED EXE (zero employee input) ─────────────────────
  LOG('=== 4. Launch packaged EXE (fresh install state) ===');
  spawnSync('taskkill //F //IM OmniSightAgent.exe', [], { shell: true, stdio: 'ignore' });
  spawnSync('taskkill //F //IM WorkLensAIAgent.exe', [], { shell: true, stdio: 'ignore' });
  try { rmSync(USERDATA_BACKUP, { recursive: true, force: true }); } catch {}
  if (existsSync(AGENT_USERDATA)) {
    spawnSync('cmd /c ren', [`"${AGENT_USERDATA}" "${process.env.APPDATA}/worklensai-agent.zt-e2e-bak"`], { shell: true, stdio: 'ignore' });
    if (existsSync(AGENT_USERDATA)) rmSync(AGENT_USERDATA, { recursive: true, force: true });
    console.log('  agent userData backed up (fresh install state)');
  }
  const exe = spawn(EXE, [], {
    cwd: join(ROOT, 'omnisight-agent', 'out', 'win-unpacked'),
    env: { ...process.env, WORKLENSAI_SERVER_URL: BASE, WL_ENROLLMENT_CODE: ENROLL_CODE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exeLog = '';
  exe.stdout.on('data', (d) => { exeLog += d.toString(); });
  exe.stderr.on('data', (d) => { exeLog += d.toString(); });
  const logHas = (pat) => exeLog.includes(pat);

  // 5. The device appears as PENDING with real metadata.
  LOG('=== 5. Discovery -> PENDING in Admin ===');
  const login = await adminLogin();
  check('admin login works', login.status === 200 && !!login.token, `(${login.status})`);
  const TOKEN = login.token;

  const claims = await waitFor(async () => {
    const r = await safeFetch('/api/device-claims?status=pending&pageSize=50', { token: TOKEN });
    if (r?.status === 200 && Array.isArray(r.body.data) && r.body.data.length >= 1) return r.body.data;
    return null;
  }, 60_000, 'pending device claim from the packaged EXE');
  check('device appears in Admin as PENDING', Array.isArray(claims) && claims.length >= 1, `(count=${claims?.length ?? 0})`);

  const claim = claims?.[0];
  const metaOk = !!claim &&
    typeof claim.device.hostname === 'string' && claim.device.hostname.length > 0 &&
    typeof claim.deviceId === 'string' && claim.deviceId.length > 0 &&
    claim.status === 'pending' && claim.employee === null;
  check('real device metadata (hostname, deviceId, unassigned)', metaOk, JSON.stringify(claim?.device));
  check('agent reported an OS', !!claim?.device?.operatingSystem, `(${claim?.device?.operatingSystem})`);
  check('agent reported its version', !!claim?.device?.agentVersion, `(${claim?.device?.agentVersion})`);

  if (claim) {
    // 6. Admin approves with an employee (department auto-derived).
    LOG('=== 6. Admin approve -> bind employee ===');
    const empRes = await safeFetch('/api/employees?status=active&pageSize=50', { token: TOKEN });
    const emp = (empRes?.body.data || []).find((e) => e.employeeId === 'EMP-B5');
    check('seeded employee visible to admin', !!emp, '(EMP-B5)');

    const approve = await safeFetch(`/api/device-claims/${claim.id}/approve`, {
      method: 'POST', token: TOKEN, body: { employeeId: emp.id, projectIds: [] }, ip: '198.51.100.99',
    });
    check('approve returns success', approve?.status === 200, `(${approve?.status} ${JSON.stringify(approve?.body)})`);

    const afterApprove = await safeFetch('/api/device-claims?status=approved&pageSize=50', { token: TOKEN });
    const approvedClaim = (afterApprove?.body.data || []).find((c) => c.id === claim.id);
    check('claim status -> approved', approvedClaim?.status === 'approved');
    check('claim bound to employee', approvedClaim?.employee?.employeeId === 'EMP-B5');
    check('department derived from employee', approvedClaim?.employee?.department?.name === 'E2E Engineering', JSON.stringify(approvedClaim?.employee?.department));

    // 7. Agent detects approval automatically and authenticates.
    LOG('=== 7. Automatic approval detection + authentication ===');
    const onlineDev = await waitFor(async () => {
      const r = await safeFetch('/api/devices?pageSize=50', { token: TOKEN });
      const devs = Array.isArray(r?.body.data) ? r.body.data : [];
      const d = devs.find((x) => x.id === claim.deviceId && (x.status === 'online' || x.status === 'offline'));
      return d || null;
    }, 90_000, 'device online after agent re-auth');

    const authed = await waitFor(async () => logHas('runtime-started') || logHas('approval-check'), 90_000, 'agent auth log');
    check('agent automatically authenticated (approval poll -> runtime)', !!authed);
    check('device online after auth', onlineDev?.status === 'online', `(${onlineDev?.status})`);
    check('heartbeat recorded', !!onlineDev?.lastHeartbeat, '(lastHeartbeat)');

    // 8. Approval granted NO consent — counted DIRECTLY in the throwaway DB.
    LOG('=== 8. Consent remained untouched by approval ===');
    const consentCount = countConsents(approvedClaim.employee.id);
    check('approval granted NO consent (zero consent rows in DB)', consentCount === 0, `(count=${consentCount})`);
  }

  // 9. Agent log evidence.
  LOG('=== 9. Agent log evidence ===');
  const relevant = exeLog.split('\n').filter((l) =>
    /boot|zero-touch|renderer state|runtime-started|approval-check|authenticated|initialize/.test(l)
  ).slice(-14);
  for (const l of relevant) console.log('   ', l.trim());
} finally {
  // ── Cleanup ─────────────────────────────────────────────────────────────
  LOG('=== 10. Cleanup ===');
  spawnSync('taskkill //F //IM OmniSightAgent.exe', [], { shell: true, stdio: 'ignore' });
  spawnSync('taskkill //F //IM WorkLensAIAgent.exe', [], { shell: true, stdio: 'ignore' });
  if (server?.pid) spawnSync(`taskkill //F //T //PID ${server.pid}`, [], { shell: true, stdio: 'ignore' });
  killPortListeners();
  await sleep(2000);
  try { rmSync(DB_PATH, { force: true }); } catch { /* locked briefly — retry once */ }
  try { rmSync(DB_PATH, { force: true }); } catch {}
  // Restore the pre-existing agent userData (remove the fresh E2E state).
  try { rmSync(AGENT_USERDATA, { recursive: true, force: true }); } catch {}
  if (existsSync(USERDATA_BACKUP)) {
    spawnSync('cmd /c ren', [`"${USERDATA_BACKUP}" "${process.env.APPDATA}/worklensai-agent"`], { shell: true, stdio: 'ignore' });
    console.log('  agent userData restored');
  }
  console.log('  throwaway db + processes cleaned');
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
