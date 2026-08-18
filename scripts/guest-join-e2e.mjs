// Guest "Join as Guest" live E2E — real agent code path against a running server.
//
// Uses the agent's ACTUAL compiled AuthService + DeviceApi (omnisight-agent/dist/)
// to reproduce exactly what the "Join as Guest" button runs in the main
// process: anonymous zero-touch discovery with the org enrollment code
// (WL_ENROLLMENT_CODE — the same runtime provisioning documented for MDM/dev),
// then completes the server side: admin approves the claim in GUEST mode →
// agent poll auto-detects approval → PATH A device-credential auth → heartbeat.
//
// Prereqs:
//   - A backend running on WL_E2E_BASE (default http://localhost:3000)
//   - WL_ENROLLMENT_CODE set to the org's current enrollment code
//   - Admin credentials (super admin) for the approve step:
//       WL_E2E_ADMIN / WL_E2E_ADMIN_PASS
// Run (bash):
//   WL_ENROLLMENT_CODE=... WL_E2E_ADMIN=... WL_E2E_ADMIN_PASS=... node scripts/guest-join-e2e.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const BASE = process.env.WL_E2E_BASE || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.WL_E2E_ADMIN || '';
const ADMIN_PASS = process.env.WL_E2E_ADMIN_PASS || '';
const ENROLL_CODE = process.env.WL_ENROLLMENT_CODE || '';

if (!ENROLL_CODE) {
  console.error('WL_ENROLLMENT_CODE must be set to the org enrollment code (this is exactly what the agent build would have baked).');
  process.exit(2);
}
if (!ADMIN_EMAIL || !ADMIN_PASS) {
  console.error('WL_E2E_ADMIN / WL_E2E_ADMIN_PASS must be set (admin session for the guest approval step).');
  process.exit(2);
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const { ApiClient } = require('../omnisight-agent/dist/api/client.js');
const { DeviceApi } = require('../omnisight-agent/dist/api/device.js');
const { HeartbeatApi } = require('../omnisight-agent/dist/api/heartbeat.js');
const { AuthService } = require('../omnisight-agent/dist/auth/auth-service.js');
const { InMemorySecureStore } = require('../omnisight-agent/dist/auth/secure-store.js');

async function adminSession() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
  });
  if (login.status !== 200) throw new Error(`admin login failed: ${login.status}`);
  return (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function main() {
  const client = new ApiClient({ baseUrl: BASE, timeoutMs: 15_000, retries: 1 });
  const deviceApi = new DeviceApi(client);
  const auth = new AuthService(deviceApi, new InMemorySecureStore());
  const cookie = await adminSession();

  // Exactly the body "Join as Guest" produces (getDiscoveryInfo + discoverDevice):
  // stable machine key + hostname/OS facts + reRegister + the enrollment code.
  const deviceKey = `guest-e2e-${Date.now().toString(36)}-abcdef012345`;
  const info = {
    hostname: 'GUEST-JOIN-E2E-PC',
    os: 'Windows 11',
    osVersion: '10.0.26100',
    processor: 'x64',
    memory: '16 GB',
    agentVersion: '1.1.0',
    deviceKey,
    enrollmentCode: ENROLL_CODE,
  };

  // ── 1. "Join as Guest" = anonymous zero-touch discovery ─────────────────
  check('1. fresh service starts unregistered', auth.getState().phase === 'unregistered');
  const discovered = await auth.discoverDevice(info);
  check('2. discover succeeds (NO 422) → pending_approval', discovered.phase === 'pending_approval',
    `phase=${discovered.phase} lastError=${discovered.lastError ?? 'none'}`);
  check('2b. pending carries NO token', discovered.token === null);

  // ── 2. Admin approves the pending claim in GUEST mode ───────────────────
  const list = await fetch(`${BASE}/api/device-claims?status=pending&pageSize=100`, { headers: { Cookie: cookie } });
  const claimsJson = await list.json();
  const claim = (claimsJson?.data ?? []).find((c) => c.device.hostname === 'GUEST-JOIN-E2E-PC');
  check('3. admin sees the pending guest device claim', !!claim && claim.status === 'pending',
    claim ? `claim=${claim.id.slice(0, 8)}` : 'NOT FOUND');

  const approve = await fetch(`${BASE}/api/device-claims/${claim.id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ mode: 'guest' }),
  });
  const approveJson = await approve.json().catch(() => ({}));
  check('4. admin approves as GUEST', approve.status === 200, `status=${approve.status} ${approveJson.error ?? ''}`);
  check('4b. guest identity synthesized (GUEST-*)', /^GUEST-[0-9A-F]{12}$/.test(approveJson?.data?.employee?.employeeId ?? ''),
    `employeeId=${approveJson?.data?.employee?.employeeId ?? ''}`);

  // ── 3. Agent auto-detects approval → PATH A device-credential auth ──────
  const polled = await auth.pollApproval(info);
  check('5. poll auto-detects approval → authenticated', polled.phase === 'authenticated',
    `phase=${polled.phase} lastError=${polled.lastError ?? 'none'}`);
  check('5b. device-credential auth issued a token', typeof polled.token === 'string' && polled.token.length > 20);
  check('5c. identity comes from the server (guest employee)', String(polled.employeeId).startsWith('GUEST-'));

  // ── 4. Connected runtime: heartbeat works with the guest token ──────────
  client.setTokenProvider(() => auth.getToken());
  const heartbeatApi = new HeartbeatApi(client);
  try {
    const hb = await heartbeatApi.send();
    check('6. heartbeat succeeds with guest device token', !!hb?.success, String(hb?.message ?? ''));
  } catch (err) {
    check('6. heartbeat succeeds with guest device token', false, String((err && err.message) || err));
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nRESULT: ${results.length - failed}/${results.length} PASS`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(2);
});
