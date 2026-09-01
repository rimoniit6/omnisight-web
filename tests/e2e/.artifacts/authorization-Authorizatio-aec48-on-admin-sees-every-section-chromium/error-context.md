# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: authorization.spec.ts >> Authorization — role-specific navigation >> admin sees every section
- Location: tests\e2e\authorization.spec.ts:43:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('complementary', { name: 'Sidebar navigation' })
Expected: visible
Timeout: 45000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 45000ms
  - waiting for getByRole('complementary', { name: 'Sidebar navigation' })

```

```yaml
- main "Login":
  - img "OmniSight logo"
  - heading "OmniSight" [level=1]
  - paragraph: REMOTE INSIGHTS
  - paragraph: Sign in to your workforce intelligence platform
  - text: Email Address
  - textbox "Email Address":
    - /placeholder: you@company.com
  - text: Password
  - textbox "Password":
    - /placeholder: Enter your password
  - button "Show password"
  - button "Sign In"
  - paragraph: © 2026 OmniSight · Workforce Intelligence Platform
- region "Notifications alt+T"
- alert
```

# Test source

```ts
  1   | /**
  2   |  * AUTHZ-E2E — real-browser authorization coverage.
  3   |  *
  4   |  *  Role-specific navigation (sidebar filtering) for all six seeded identities,
  5   |  *  direct API access with/without the right role, unauthenticated access, and
  6   |  *  cross-tenant data isolation through the Org B owner's session.
  7   |  */
  8   | import { test, expect, navigate, apiAs } from './fixtures';
  9   | 
  10  | // ─── Expected sidebar visibility per role (mirrors src/lib/navigation.ts) ──
  11  | const MONITORING = [
  12  |   'Dashboard', 'Employees', 'Departments', 'Devices', 'Activities', 'Screenshots',
  13  |   'Break Monitor', 'Live Monitor', 'Analytics', 'AI Insights', 'Sentiment',
  14  |   'Notifications', 'Alerts', 'Policies', 'Anomaly Detection', 'Projects',
  15  | ];
  16  | const MANAGER_ONLY = ['Audit Logs', 'Consent', 'Reports', 'Daily Report', 'Employee Portal'];
  17  | const ADMIN_ONLY = ['AI Provider', 'Agent Approvals', 'Guests', 'Organization', 'Agent Security', 'Settings'];
  18  | const ALL = [...MONITORING, ...MANAGER_ONLY, ...ADMIN_ONLY];
  19  | 
  20  | async function expectNav(page: import('@playwright/test').Page, allowed: string[], forbidden: string[]) {
  21  |   const sidebar = page.getByRole('complementary', { name: 'Sidebar navigation' });
> 22  |   await expect(sidebar).toBeVisible({ timeout: 45_000 });
      |                         ^ Error: expect(locator).toBeVisible() failed
  23  |   for (const label of allowed) {
  24  |     const btn = sidebar.locator(`button[aria-label="${label}"]`).first();
  25  |     await expect(btn).toBeAttached();
  26  |   }
  27  |   for (const label of forbidden) {
  28  |     await expect(sidebar.locator(`button[aria-label="${label}"]`)).toHaveCount(0);
  29  |   }
  30  | }
  31  | 
  32  | test.describe('Authorization — role-specific navigation', () => {
  33  |   test('super admin sees every section', async ({ superAdmin }) => {
  34  |     await superAdmin.goto('/');
  35  |     await expectNav(superAdmin, ALL, []);
  36  |   });
  37  | 
  38  |   test('owner sees every section', async ({ owner }) => {
  39  |     await owner.goto('/');
  40  |     await expectNav(owner, ALL, []);
  41  |   });
  42  | 
  43  |   test('admin sees every section', async ({ admin }) => {
  44  |     await admin.goto('/');
  45  |     await expectNav(admin, ALL, []);
  46  |   });
  47  | 
  48  |   test('manager is denied admin-only sections', async ({ manager }) => {
  49  |     await manager.goto('/');
  50  |     await expectNav(manager, [...MONITORING, ...MANAGER_ONLY], ADMIN_ONLY);
  51  |   });
  52  | 
  53  |   test('viewer is denied manager- and admin-only sections', async ({ viewer }) => {
  54  |     await viewer.goto('/');
  55  |     await expectNav(viewer, MONITORING, [...MANAGER_ONLY, ...ADMIN_ONLY]);
  56  |   });
  57  | });
  58  | 
  59  | test.describe('Authorization — forbidden page access via store tampering', () => {
  60  |   // A viewer who force-navigates to an admin page must not receive any
  61  |   // privileged data — every backing API rejects the role.
  62  |   test('viewer cannot pull organization settings even by forcing the page state', async ({ viewer }) => {
  63  |     await viewer.goto('/');
  64  |     const res = await viewer.request.get('/api/settings');
  65  |     expect(res.status()).toBe(403);
  66  |     const res2 = await viewer.request.get('/api/auth/users');
  67  |     expect(res2.status()).toBe(403);
  68  |   });
  69  | });
  70  | 
  71  | test.describe('Authorization — direct API access matrix', () => {
  72  |   test('unauthenticated requests are rejected with 401', async ({ request }) => {
  73  |     for (const path of ['/api/employees', '/api/devices', '/api/dashboard']) {
  74  |       const res = await request.get(path);
  75  |       expect(res.status(), `GET ${path} unauthenticated`).toBe(401);
  76  |     }
  77  |   });
  78  | 
  79  |   test('viewer can read monitoring data but cannot write employees', async ({ playwright }) => {
  80  |     const api = await apiAs(playwright, 'viewer');
  81  |     const read = await api.get('/api/employees');
  82  |     expect(read.status()).toBe(200);
  83  |     const write = await api.post('/api/employees', {
  84  |       data: { employeeId: 'HACK-001', firstName: 'No', lastName: 'Way', email: 'no@way.test' },
  85  |     });
  86  |     expect(write.status()).toBe(403);
  87  |     await api.dispose();
  88  |   });
  89  | 
  90  |   test('manager reads audit logs; viewer and cross-role writes are denied', async ({ playwright }) => {
  91  |     const mgr = await apiAs(playwright, 'manager');
  92  |     expect((await mgr.get('/api/audit-logs')).status()).toBeLessThan(400);
  93  |     expect((await mgr.get('/api/settings')).status()).toBe(403);
  94  |     expect((await mgr.get('/api/auth/users')).status()).toBe(403);
  95  |     await mgr.dispose();
  96  | 
  97  |     const viewer = await apiAs(playwright, 'viewer');
  98  |     expect((await viewer.get('/api/audit-logs')).status()).toBe(403);
  99  |     await viewer.dispose();
  100 |   });
  101 | 
  102 |   test('admin-only endpoints reject manager sessions', async ({ playwright }) => {
  103 |     const mgr = await apiAs(playwright, 'manager');
  104 |     for (const path of ['/api/organization', '/api/guests']) {
  105 |       const res = await mgr.get(path);
  106 |       expect(res.status(), `GET ${path} as manager`).toBe(403);
  107 |     }
  108 |     await mgr.dispose();
  109 |   });
  110 | 
  111 |   test('admin passes the same gates its role allows', async ({ playwright }) => {
  112 |     const api = await apiAs(playwright, 'admin');
  113 |     for (const path of ['/api/settings', '/api/organization', '/api/auth/users']) {
  114 |       const res = await api.get(path);
  115 |       expect(res.status(), `GET ${path} as admin`).toBeLessThan(400);
  116 |     }
  117 |     await api.dispose();
  118 |   });
  119 | });
  120 | 
  121 | test.describe('Authorization — cross-tenant isolation in the browser session', () => {
  122 |   test('Org B owner never receives Org A records from list APIs', async ({ playwright }) => {
```