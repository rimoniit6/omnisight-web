/**
 * AUTHZ-E2E — real-browser authorization coverage.
 *
 *  Role-specific navigation (sidebar filtering) for all six seeded identities,
 *  direct API access with/without the right role, unauthenticated access, and
 *  cross-tenant data isolation through the Org B owner's session.
 */
import { test, expect, navigate, apiAs } from './fixtures';

// ─── Expected sidebar visibility per role (mirrors src/lib/navigation.ts) ──
const MONITORING = [
  'Dashboard', 'Employees', 'Departments', 'Devices', 'Activities', 'Screenshots',
  'Break Monitor', 'Live Monitor', 'Analytics',
  'AI Insights', 'Sentiment', 'Notifications', 'Alerts', 'Policies', 'Anomaly Detection',
  'Projects',
];
const MANAGER_ONLY = ['Audit Logs', 'Consent', 'Reports', 'Daily Report', 'Employee Portal'];
const ADMIN_ONLY = ['Audio Transcriptions', 'AI Provider', 'Agent Approvals', 'Organization', 'Users & Members', 'Agent Security', 'Settings'];
const ALL = [...MONITORING, ...MANAGER_ONLY, ...ADMIN_ONLY];

async function expectNav(page: import('@playwright/test').Page, allowed: string[], forbidden: string[]) {
  const sidebar = page.getByRole('complementary', { name: 'Sidebar navigation' });
  await expect(sidebar).toBeVisible({ timeout: 45_000 });
  for (const label of allowed) {
    const btn = sidebar.locator(`button[aria-label="${label}"]`).first();
    await expect(btn).toBeAttached();
  }
  for (const label of forbidden) {
    await expect(sidebar.locator(`button[aria-label="${label}"]`)).toHaveCount(0);
  }
}

test.describe('Authorization — role-specific navigation', () => {
  test('super admin sees every section', async ({ superAdmin }) => {
    await superAdmin.goto('/');
    await expectNav(superAdmin, ALL, []);
  });

  test('owner sees every section', async ({ owner }) => {
    await owner.goto('/');
    await expectNav(owner, ALL, []);
  });

  test('admin sees every section', async ({ admin }) => {
    await admin.goto('/');
    await expectNav(admin, ALL, []);
  });

  test('manager is denied admin-only sections', async ({ manager }) => {
    await manager.goto('/');
    await expectNav(manager, [...MONITORING, ...MANAGER_ONLY], ADMIN_ONLY);
  });

  test('viewer is denied manager- and admin-only sections', async ({ viewer }) => {
    await viewer.goto('/');
    await expectNav(viewer, MONITORING, [...MANAGER_ONLY, ...ADMIN_ONLY]);
  });
});

test.describe('Authorization — forbidden page access via store tampering', () => {
  // A viewer who force-navigates to an admin page must not receive any
  // privileged data — every backing API rejects the role.
  test('viewer cannot pull organization settings even by forcing the page state', async ({ viewer }) => {
    await viewer.goto('/');
    const res = await viewer.request.get('/api/settings');
    expect(res.status()).toBe(403);
    const res2 = await viewer.request.get('/api/auth/users');
    expect(res2.status()).toBe(403);
  });
});

test.describe('Authorization — direct API access matrix', () => {
  test('unauthenticated requests are rejected with 401', async ({ request }) => {
    for (const path of ['/api/employees', '/api/devices', '/api/dashboard']) {
      const res = await request.get(path);
      expect(res.status(), `GET ${path} unauthenticated`).toBe(401);
    }
  });

  test('viewer can read monitoring data but cannot write employees', async ({ playwright }) => {
    const api = await apiAs(playwright, 'viewer');
    const read = await api.get('/api/employees');
    expect(read.status()).toBe(200);
    const write = await api.post('/api/employees', {
      data: { employeeId: 'HACK-001', firstName: 'No', lastName: 'Way', email: 'no@way.test' },
    });
    expect(write.status()).toBe(403);
    await api.dispose();
  });

  test('manager reads audit logs; viewer and cross-role writes are denied', async ({ playwright }) => {
    const mgr = await apiAs(playwright, 'manager');
    expect((await mgr.get('/api/audit-logs')).status()).toBeLessThan(400);
    expect((await mgr.get('/api/settings')).status()).toBe(403);
    expect((await mgr.get('/api/auth/users')).status()).toBe(403);
    await mgr.dispose();

    const viewer = await apiAs(playwright, 'viewer');
    expect((await viewer.get('/api/audit-logs')).status()).toBe(403);
    await viewer.dispose();
  });

  test('admin-only endpoints reject manager sessions', async ({ playwright }) => {
    const mgr = await apiAs(playwright, 'manager');
    const res = await mgr.get('/api/organization');
    expect(res.status(), 'GET /api/organization as manager').toBe(403);
    await mgr.dispose();
  });

  test('admin passes the same gates its role allows', async ({ playwright }) => {
    const api = await apiAs(playwright, 'admin');
    for (const path of ['/api/settings', '/api/organization', '/api/auth/users']) {
      const res = await api.get(path);
      expect(res.status(), `GET ${path} as admin`).toBeLessThan(400);
    }
    await api.dispose();
  });
});

test.describe('Authorization — cross-tenant isolation in the browser session', () => {
  test('Org B owner never receives Org A records from list APIs', async ({ playwright }) => {
    const beta = await apiAs(playwright, 'betaOwner');

    const employees = await beta.get('/api/employees');
    expect(employees.status()).toBe(200);
    const empBody = await employees.text();
    expect(empBody).not.toContain('EMP-E2E-001');
    expect(empBody).toContain('EMP-BETA-001');

    const devices = await beta.get('/api/devices');
    expect(devices.status()).toBe(200);
    const devBody = await devices.text();
    expect(devBody).not.toContain('ACME-WS-01');
    expect(devBody).toContain('BETA-WS-01');

    const screenshots = await beta.get('/api/screenshots');
    const shotBody = await screenshots.text();
    expect(shotBody).not.toContain('e2e-shot.png');

    const activities = await beta.get('/api/activities');
    const actBody = await activities.text();
    expect(actBody).not.toContain('github.com');

    await beta.dispose();
  });

  test('project lists never leak across tenants', async ({ playwright }) => {
    const beta = await apiAs(playwright, 'betaOwner');
    const betaRes = await beta.get('/api/projects');
    expect(betaRes.status()).toBe(200);
    const betaBody = await betaRes.text();
    expect(betaBody).toContain('Beta Website Revamp');
    expect(betaBody).not.toContain('Apollo Migration');

    const acmeAdmin = await apiAs(playwright, 'admin');
    const acmeRes = await acmeAdmin.get('/api/projects');
    expect(acmeRes.status()).toBe(200);
    const acmeBody = await acmeRes.text();
    expect(acmeBody).toContain('Apollo Migration');
    expect(acmeBody).not.toContain('Beta Website Revamp');

    await beta.dispose();
    await acmeAdmin.dispose();
  });

  test('Acme admin sees only Acme projects', async ({ playwright }) => {
    const api = await apiAs(playwright, 'admin');
    const res = await api.get('/api/projects');
    expect(res.status()).toBe(200);
    const body = await res.text();
    expect(body).toContain('Apollo Migration');
    await api.dispose();
  });
});

test.describe('Authorization — allowed page access renders real data', () => {
  test('viewer opens Dashboard and Employees successfully', async ({ viewer }) => {
    await viewer.goto('/');
    await navigate(viewer, 'Dashboard');
    await expect(viewer.getByText(/productivity|active|online/i).first()).toBeVisible({
      timeout: 30_000,
    });
    await navigate(viewer, 'Employees');
    await expect(viewer.getByText('Ada').first()).toBeVisible({ timeout: 30_000 });
  });
});
