/**
 * OmniSight RBAC Runtime Verification
 * Tests the actual running server for all RBAC requirements.
 *
 * Usage: node tests/rbac-runtime-verification.mjs
 * Requires: running dev server on localhost:3000
 */

const BASE = 'http://localhost:3000';

// Credentials are read from the environment — never hardcode real-looking
// passwords in committed files. The fallbacks below are clearly fake and only
// work against a throwaway local DB; point the ORG_*_ variables at your demo
// seed and set SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD for the platform admin.
const ACCOUNTS = {
  superAdmin: {
    email: process.env.SUPER_ADMIN_EMAIL || 'superadmin@local.test',
    password: process.env.SUPER_ADMIN_PASSWORD || 'superadmin-test-only',
  },
  orgAdmin: {
    email: process.env.ORG_ADMIN_EMAIL || 'orgadmin@local.test',
    password: process.env.ORG_ADMIN_PASSWORD || 'orgadmin-test-only',
  },
  manager: {
    email: process.env.ORG_MANAGER_EMAIL || 'manager@local.test',
    password: process.env.ORG_MANAGER_PASSWORD || 'manager-test-only',
  },
  viewer: {
    email: process.env.ORG_VIEWER_EMAIL || 'viewer@local.test',
    password: process.env.ORG_VIEWER_PASSWORD || 'viewer-test-only',
  },
};

const EXPECTED = {
  superAdmin:  { role: 'super_admin',  roleLabel: 'Super Admin' },
  orgAdmin:    { role: 'org_admin',    roleLabel: 'Organization Admin' },
  manager:     { role: 'manager',      roleLabel: 'Manager' },
  viewer:      { role: 'viewer',       roleLabel: 'Viewer' },
};

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
  }
}

async function login(account) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(account),
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function api(method, path, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  let data;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  OmniSight RBAC Runtime Verification            ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // ── Section 1: Health Check ──
  console.log('━━━ SECTION 1: Health Check ━━━');
  const health = await api('GET', '/api/health', null);
  assert(health.status === 200, 'Server health endpoint returns 200');
  console.log('');

  // ── Section 2: Login Verification ──
  console.log('━━━ SECTION 2: Login Verification ━━━');
  const tokens = {};

  for (const [name, account] of Object.entries(ACCOUNTS)) {
    const exp = EXPECTED[name];
    const { status, data } = await login(account);

    assert(status === 200, `${name} login returns 200`);
    assert(data.user.role === exp.role, `${name} login role = ${exp.role} (got ${data.user.role})`);
    assert(data.user.roleLabel === exp.roleLabel, `${name} login roleLabel = "${exp.roleLabel}" (got "${data.user.roleLabel}")`);
    assert(data.token, `${name} receives a JWT token`);

    tokens[name] = data.token;
  }
  console.log('');

  // ── Section 3: /api/auth/me Verification ──
  console.log('━━━ SECTION 3: /api/auth/me Verification ━━━');

  for (const [name, token] of Object.entries(tokens)) {
    const exp = EXPECTED[name];
    const { status, data } = await api('GET', '/api/auth/me', token);

    assert(status === 200, `${name} /api/auth/me returns 200`);
    assert(data.user.role === exp.role, `${name} /api/auth/me role = ${exp.role} (got ${data.user.role})`);
    assert(data.user.roleLabel === exp.roleLabel, `${name} /api/auth/me roleLabel = "${exp.roleLabel}" (got "${data.user.roleLabel}")`);

    if (name !== 'superAdmin') {
      assert(data.organization !== null, `${name} /api/auth/me has organization`);
      assert(data.organization.name === 'Acme Technologies', `${name} organization is "Acme Technologies"`);
    } else {
      assert(data.organization === null, `${name} /api/auth/me has no organization (global super_admin)`);
    }
  }
  console.log('');

  // ── Section 4: Unauthenticated Access ──
  console.log('━━━ SECTION 4: Unauthenticated Access ━━━');
  const unauth1 = await api('GET', '/api/auth/me', '');
  assert(unauth1.status === 401, '/api/auth/me without token returns 401');

  const unauth2 = await api('GET', '/api/auth/me', 'invalid-token-123');
  assert(unauth2.status === 401, '/api/auth/me with invalid token returns 401');
  console.log('');

  // ── Section 5: Super Admin API Isolation ──
  console.log('━━━ SECTION 5: Super Admin API Isolation ━━━');

  // Super Admin can access
  const saSa = await api('GET', '/api/super-admin/organizations', tokens.superAdmin);
  assert(saSa.status === 200, 'Super Admin can access /api/super-admin/organizations');

  // Org Admin CANNOT
  const oaSa = await api('GET', '/api/super-admin/organizations', tokens.orgAdmin);
  assert(oaSa.status === 403, 'Org Admin CANNOT access /api/super-admin/organizations (403)');

  // Manager CANNOT
  const mgSa = await api('GET', '/api/super-admin/organizations', tokens.manager);
  assert(mgSa.status === 403, 'Manager CANNOT access /api/super-admin/organizations (403)');

  // Viewer CANNOT
  const vwSa = await api('GET', '/api/super-admin/organizations', tokens.viewer);
  assert(vwSa.status === 403, 'Viewer CANNOT access /api/super-admin/organizations (403)');
  console.log('');

  // ── Section 6: Platform Settings Isolation ──
  console.log('━━━ SECTION 6: Platform Settings Isolation ━━━');

  // GET /api/settings — admin+
  const saGetSettings = await api('GET', '/api/settings', tokens.superAdmin);
  assert(saGetSettings.status === 200, 'Super Admin can GET /api/settings');

  const oaGetSettings = await api('GET', '/api/settings', tokens.orgAdmin);
  assert(oaGetSettings.status === 200, 'Org Admin can GET /api/settings (admin+)');

  const mgGetSettings = await api('GET', '/api/settings', tokens.manager);
  assert(mgGetSettings.status === 403, 'Manager CANNOT GET /api/settings (403)');

  const vwGetSettings = await api('GET', '/api/settings', tokens.viewer);
  assert(vwGetSettings.status === 403, 'Viewer CANNOT GET /api/settings (403)');

  // PUT /api/settings — super_admin only
  const saPutSettings = await api('PUT', '/api/settings', tokens.superAdmin, { key: 'test_key', value: 'test' });
  assert(saPutSettings.status === 400 || saPutSettings.status === 200, 'Super Admin can PUT /api/settings');

  const oaPutSettings = await api('PUT', '/api/settings', tokens.orgAdmin, { key: 'test_key', value: 'test' });
  assert(oaPutSettings.status === 403, 'Org Admin CANNOT PUT /api/settings (403)');
  console.log('');

  // ── Section 7: Employee Access ──
  console.log('━━━ SECTION 7: Employee Access ━━━');
  const saEmp = await api('GET', '/api/employees', tokens.superAdmin);
  assert(saEmp.status === 200, 'Super Admin can GET /api/employees');

  const oaEmp = await api('GET', '/api/employees', tokens.orgAdmin);
  assert(oaEmp.status === 200, 'Org Admin can GET /api/employees');

  const mgEmp = await api('GET', '/api/employees', tokens.manager);
  assert(mgEmp.status === 200, 'Manager can GET /api/employees');

  const vwEmp = await api('GET', '/api/employees', tokens.viewer);
  assert(vwEmp.status === 200, 'Viewer can GET /api/employees');
  console.log('');

  // ── Section 8: Device Access ──
  console.log('━━━ SECTION 8: Device Access ━━━');
  const saDev = await api('GET', '/api/devices', tokens.superAdmin);
  assert(saDev.status === 200, 'Super Admin can GET /api/devices');

  const oaDev = await api('GET', '/api/devices', tokens.orgAdmin);
  assert(oaDev.status === 200, 'Org Admin can GET /api/devices');

  const mgDev = await api('GET', '/api/devices', tokens.manager);
  assert(mgDev.status === 200, 'Manager can GET /api/devices');

  const vwDev = await api('GET', '/api/devices', tokens.viewer);
  assert(vwDev.status === 200, 'Viewer can GET /api/devices');
  console.log('');

  // ── Section 9: Dashboard Access ──
  console.log('━━━ SECTION 9: Dashboard Access ━━━');
  for (const [name, token] of Object.entries(tokens)) {
    const dash = await api('GET', '/api/dashboard', token);
    assert(dash.status === 200, `${name} can GET /api/dashboard`);
  }
  console.log('');

  // ── Section 10: Reports Access ──
  console.log('━━━ SECTION 10: Reports Access ━━━');
  const saRpt = await api('GET', '/api/reports', tokens.superAdmin);
  assert(saRpt.status === 200, 'Super Admin can GET /api/reports');

  const oaRpt = await api('GET', '/api/reports', tokens.orgAdmin);
  assert(oaRpt.status === 200, 'Org Admin can GET /api/reports');

  const mgRpt = await api('GET', '/api/reports', tokens.manager);
  assert(mgRpt.status === 200, 'Manager can GET /api/reports');

  const vwRpt = await api('GET', '/api/reports', tokens.viewer);
  // Viewer may or may not have access depending on implementation
  console.log(`  ℹ️  Viewer GET /api/reports: ${vwRpt.status}`);
  console.log('');

  // ── Section 11: Audio Transcription Access ──
  console.log('━━━ SECTION 11: Audio Transcription Access ━━━');
  const saAudio = await api('GET', '/api/audio', tokens.superAdmin);
  assert(saAudio.status === 200, 'Super Admin can GET /api/audio');

  const oaAudio = await api('GET', '/api/audio', tokens.orgAdmin);
  assert(oaAudio.status === 200, 'Org Admin can GET /api/audio');

  const mgAudio = await api('GET', '/api/audio', tokens.manager);
  console.log(`  ℹ️  Manager GET /api/audio: ${mgAudio.status}`);

  const vwAudio = await api('GET', '/api/audio', tokens.viewer);
  console.log(`  ℹ️  Viewer GET /api/audio: ${vwAudio.status}`);
  console.log('');

  // ── Section 12: Audit Logs Access ──
  console.log('━━━ SECTION 12: Audit Logs Access ━━━');
  const saAudit = await api('GET', '/api/audit-logs', tokens.superAdmin);
  assert(saAudit.status === 200, 'Super Admin can GET /api/audit-logs');

  const oaAudit = await api('GET', '/api/audit-logs', tokens.orgAdmin);
  assert(oaAudit.status === 200, 'Org Admin can GET /api/audit-logs');

  const mgAudit = await api('GET', '/api/audit-logs', tokens.manager);
  assert(mgAudit.status === 200, 'Manager can GET /api/audit-logs');

  const vwAudit = await api('GET', '/api/audit-logs', tokens.viewer);
  console.log(`  ℹ️  Viewer GET /api/audit-logs: ${vwAudit.status}`);
  console.log('');

  // ── Section 13: User Management ──
  console.log('━━━ SECTION 13: User Management ━━━');
  const saUsers = await api('GET', '/api/auth/users', tokens.superAdmin);
  assert(saUsers.status === 200, 'Super Admin can GET /api/auth/users');

  const oaUsers = await api('GET', '/api/auth/users', tokens.orgAdmin);
  assert(oaUsers.status === 200, 'Org Admin can GET /api/auth/users');

  const mgUsers = await api('GET', '/api/auth/users', tokens.manager);
  assert(mgUsers.status === 403, 'Manager CANNOT GET /api/auth/users (403)');

  const vwUsers = await api('GET', '/api/auth/users', tokens.viewer);
  assert(vwUsers.status === 403, 'Viewer CANNOT GET /api/auth/users (403)');
  console.log('');

  // ── Section 14: Privilege Escalation ──
  console.log('━━━ SECTION 14: Privilege Escalation Prevention ━━━');

  // Viewer tries to create a user
  const vwCreate = await api('POST', '/api/auth/users', tokens.viewer, {
    email: `test-escalation-${Date.now()}@test.com`,
    name: 'Test Escalation',
    password: 'test1234',
    role: 'admin',
  });
  assert(vwCreate.status === 403, 'Viewer cannot create users (403)');

  // Manager tries to create a super_admin user
  const mgCreate = await api('POST', '/api/auth/users', tokens.manager, {
    email: `test-mg-escalation-${Date.now()}@test.com`,
    name: 'Test MG Escalation',
    password: 'test1234',
    role: 'super_admin',
  });
  assert(mgCreate.status === 403, 'Manager cannot create super_admin users (403)');

  // Viewer tries to access super-admin endpoint
  const vwSuperAdmin = await api('GET', '/api/super-admin/organizations', tokens.viewer);
  assert(vwSuperAdmin.status === 403, 'Viewer cannot access super-admin APIs (403)');

  // Manager tries to access super-admin endpoint
  const mgSuperAdmin = await api('GET', '/api/super-admin/organizations', tokens.manager);
  assert(mgSuperAdmin.status === 403, 'Manager cannot access super-admin APIs (403)');

  // Org Admin tries to access super-admin endpoint
  const oaSuperAdmin = await api('GET', '/api/super-admin/organizations', tokens.orgAdmin);
  assert(oaSuperAdmin.status === 403, 'Org Admin cannot access super-admin APIs (403)');
  console.log('');

  // ── Section 15: Organization Settings ──
  console.log('━━━ SECTION 15: Organization Settings ━━━');
  const saOrg = await api('GET', '/api/organization', tokens.superAdmin);
  assert(saOrg.status === 200, 'Super Admin can GET /api/organization');

  const oaOrg = await api('GET', '/api/organization', tokens.orgAdmin);
  assert(oaOrg.status === 200, 'Org Admin can GET /api/organization');

  const mgOrg = await api('GET', '/api/organization', tokens.manager);
  assert(mgOrg.status === 200, 'Manager can GET /api/organization');

  const vwOrg = await api('GET', '/api/organization', tokens.viewer);
  assert(vwOrg.status === 200, 'Viewer can GET /api/organization');
  console.log('');

  // ── Section 16: Permission Error Format ──
  console.log('━━━ SECTION 16: Permission Error Format ━━━');
  const oaPut = await api('PUT', '/api/settings', tokens.orgAdmin, { key: 'ai_provider', value: 'openai' });
  assert(oaPut.status === 403, 'Org Admin PUT /api/settings returns 403');
  assert(oaPut.data && oaPut.data.error, 'Error response has error field');
  console.log('');

  // ── Summary ──
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  RESULTS: ${passed} passed, ${failed} failed               ║`);
  console.log('╚══════════════════════════════════════════════════╝');

  if (failures.length > 0) {
    console.log('\n❌ FAILURES:');
    failures.forEach(f => console.log(`   - ${f}`));
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
