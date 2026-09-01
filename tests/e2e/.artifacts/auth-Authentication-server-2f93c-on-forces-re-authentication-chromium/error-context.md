# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth.spec.ts >> Authentication >> server-side session expiration forces re-authentication
- Location: tests\e2e\auth.spec.ts:96:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('main', { name: 'Login' })
Expected: visible
Timeout: 30000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 30000ms
  - waiting for getByRole('main', { name: 'Login' })

```

```yaml
- link "Skip to main content":
  - /url: "#main-content"
- complementary "Sidebar navigation":
  - img "OmniSight"
  - text: OmniSight
  - navigation "Main navigation":
    - paragraph: Overview
    - list:
      - button "Dashboard"
      - button "Employees"
      - button "Departments"
      - button "Devices"
      - button "Activities"
      - button "Screenshots"
      - button "Break Monitor"
      - button "Live Monitor"
      - button "Analytics"
    - paragraph: Intelligence
    - list:
      - button "AI Insights"
      - button "Sentiment"
    - paragraph: Security
    - list:
      - button "Notifications"
      - button "Alerts"
      - button "Audit Logs"
      - button "Policies"
      - button "Anomaly Detection"
      - button "Consent"
    - paragraph: Work Management
    - list:
      - button "Projects"
    - paragraph: Employee
    - list:
      - button "Employee Portal"
    - paragraph: Admin
    - list:
      - button "Reports"
      - button "Daily Report"
  - paragraph: All systems operational
  - text: MU
  - paragraph: Manager User
  - paragraph: Manager
  - button "Collapse sidebar" [expanded]: Collapse
- banner:
  - heading "Dashboard" [level=1]
  - navigation "Breadcrumb":
    - button "Home"
  - button "Search... Ctrl K"
  - button "Toggle theme"
  - button "Connection status"
  - button "Notifications"
  - button "MU Manager"
- main "Main content":
  - region "Dashboard":
    - button "Add Employee"
    - button "Generate Report"
    - button "View Alerts"
    - button "Settings"
    - button "Export PDF"
    - button "Live"
    - button "Customize"
    - text: Welcome back
    - heading "Good Afternoon, Manager" [level=2]
    - paragraph: Tuesday, September 1, 2026
    - paragraph: Halfway through the day — keep it up!
    - text: 1 active employees 0 online devices
    - button "Add Employee"
    - button "View Reports"
    - button "Generate Report"
    - button "View Alerts"
    - paragraph: Total Employees
    - paragraph: "1"
    - paragraph: current
    - paragraph: Online Devices
    - paragraph: 0/2
    - paragraph: current
    - paragraph: Avg Productive Hrs
    - paragraph: 1.0 hrs
    - paragraph: current
    - paragraph: Active Alerts
    - paragraph: "0"
    - paragraph: active now
    - img
    - text: 92%
    - paragraph: Productivity Score
    - paragraph: 92%
    - paragraph: overall score
    - text: Weekly Productivity (minutes)
    - img: Thu, Aug 27 Fri, Aug 28 Sat, Aug 29 Sun, Aug 30 Tue, Sep 1 0 15 30 45 60
    - list:
      - listitem:
        - img
        - text: Productive
      - listitem:
        - img
        - text: Neutral
      - listitem:
        - img
        - text: Unproductive
    - text: Department Distribution
    - paragraph: Click a slice to filter employees by department
    - img:
      - img
    - paragraph: "2"
    - paragraph: Employees
    - text: Engineering 100.0% Device Status
    - img:
      - img
    - paragraph: "2"
    - paragraph: Devices
    - text: Offline 100.0% Top Performers AL
    - paragraph: Ada Lovelace
    - paragraph: Engineering
    - text: 0.9h Recent Activity AL Ada Lovelace Web
    - paragraph: Example News
    - paragraph: about 1 hour ago · 5min
    - text: AL Ada Lovelace App
    - paragraph: Code.exe
    - paragraph: about 1 hour ago · 40min
    - text: AL Ada Lovelace Web
    - paragraph: GitHub — Pull Requests
    - paragraph: about 1 hour ago · 15min
- contentinfo:
  - text: © 2026 OmniSight v1.0.0
  - button "Dashboard"
  - text: ·
  - button "Employees"
  - text: ·
  - button "Settings"
- heading "Command Palette" [level=2]
- paragraph: Search for a command to run...
- region "Notifications alt+T"
- alert
```

# Test source

```ts
  20  |   await page.waitForTimeout(500);
  21  | }
  22  | 
  23  | test.describe('Authentication', () => {
  24  |   test('login with valid credentials lands on the dashboard', async ({ page }) => {
  25  |     await page.goto('/');
  26  |     await expect(page.getByRole('main', { name: 'Login' })).toBeVisible();
  27  |     await page.locator('#email').fill(creds('admin').email);
  28  |     await page.locator('#password').fill(creds('admin').password);
  29  |     await page.getByRole('button', { name: /sign in/i }).click();
  30  | 
  31  |     // Success: app shell + toast feedback.
  32  |     await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible({
  33  |       timeout: 45_000,
  34  |     });
  35  |     await expect(page.locator('[data-sonner-toast]')).toContainText(/Welcome back/i);
  36  |   });
  37  | 
  38  |   test('invalid password shows the uniform error and stays on login', async ({ page }) => {
  39  |     await page.goto('/');
  40  |     await page.locator('#email').fill(creds('viewer').email);
  41  |     await page.locator('#password').fill('definitely-wrong-password');
  42  |     await page.getByRole('button', { name: /sign in/i }).click();
  43  | 
  44  |     const alert = page.locator('#login-error');
  45  |     await expect(alert).toBeVisible();
  46  |     await expect(alert).toContainText(/invalid email or password/i);
  47  |     await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toHaveCount(0);
  48  |   });
  49  | 
  50  |   test('unknown email shows the same uniform error (no user enumeration)', async ({ page }) => {
  51  |     await page.goto('/');
  52  |     await page.locator('#email').fill('ghost@nowhere.test');
  53  |     await page.locator('#password').fill('whatever-password-1');
  54  |     await page.getByRole('button', { name: /sign in/i }).click();
  55  |     await expect(page.locator('#login-error')).toContainText(/invalid email or password/i);
  56  |   });
  57  | 
  58  |   test('empty submit shows client-side validation error', async ({ page }) => {
  59  |     await page.goto('/');
  60  |     await page.getByRole('button', { name: /sign in/i }).click();
  61  |     await expect(page.getByText(/please enter both email and password/i)).toBeVisible();
  62  |     // No API call should have been made.
  63  |     await expect(page.locator('#email')).toBeVisible();
  64  |   });
  65  | 
  66  |   test('logout via the user menu revokes the session and returns to login', async ({ page }) => {
  67  |     // Dedicated fresh login — never reuses a persisted storage state.
  68  |     await page.goto('/');
  69  |     await page.locator('#email').fill(creds('owner').email);
  70  |     await page.locator('#password').fill(creds('owner').password);
  71  |     await page.getByRole('button', { name: /sign in/i }).click();
  72  |     await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible();
  73  | 
  74  |     // Dismiss tour overlay and sonner toasts that intercept pointer events.
  75  |     await dismissOverlays(page);
  76  | 
  77  |     // Use evaluate to trigger the Radix dropdown — dispatch both pointerdown and click.
  78  |     await page.evaluate(() => {
  79  |       const trigger = document.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement | null;
  80  |       if (trigger) {
  81  |         trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  82  |         trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  83  |         trigger.click();
  84  |       }
  85  |     });
  86  |     await page.waitForTimeout(800);
  87  |     // Click the Logout menu item.
  88  |     await page.getByRole('menuitem', { name: /log ?out/i }).click({ timeout: 10_000 });
  89  | 
  90  |     await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
  91  |     // The session is dead server-side: reload still shows the login form.
  92  |     await page.reload({ waitUntil: 'domcontentloaded' });
  93  |     await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
  94  |   });
  95  | 
  96  |   test('server-side session expiration forces re-authentication', async ({ page, request }) => {
  97  |     await page.goto('/');
  98  |     await page.locator('#email').fill(creds('manager').email);
  99  |     await page.locator('#password').fill(creds('manager').password);
  100 |     await page.getByRole('button', { name: /sign in/i }).click();
  101 |     await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible();
  102 |     // Dismiss overlays.
  103 |     await dismissOverlays(page);
  104 | 
  105 |     // Expire the session row directly (simulates TTL passing).
  106 |     const expired = await expireSessionsFor(creds('manager').email);
  107 |     expect(expired).toBeGreaterThan(0);
  108 | 
  109 |     // Verify that /api/auth/me now rejects with 401 — the session is dead.
  110 |     const me = await request.get('/api/auth/me');
  111 |     expect(me.status()).toBe(401);
  112 | 
  113 |     // Reload — the client hydrates from /api/auth/me, which returns 401,
  114 |     // causing logout() and the login page to render.
  115 |     // Navigate to the root to force a fresh hydrate cycle.
  116 |     await page.goto('/', { waitUntil: 'networkidle' });
  117 |     // Wait for the auth check to complete (hydrate + react query).
  118 |     await page.waitForTimeout(5000);
  119 |     // The auth store should now show the login page.
> 120 |     await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
      |                                                             ^ Error: expect(locator).toBeVisible() failed
  121 |   });
  122 | 
  123 |   test('revoked session rejects subsequent API access (401)', async ({ request }) => {
  124 |     // Login via API.
  125 |     const login = await request.post('/api/auth/login', {
  126 |       data: { email: creds('viewer').email, password: creds('viewer').password },
  127 |     });
  128 |     expect(login.status()).toBe(200);
  129 |     const body = await login.json();
  130 |     expect(body.token).toBeTruthy();
  131 | 
  132 |     const authed = await request.get('/api/auth/me', {
  133 |       headers: { Authorization: `Bearer ${body.token}` },
  134 |     });
  135 |     expect(authed.status()).toBe(200);
  136 | 
  137 |     // Logout revokes the server-side session row.
  138 |     const out = await request.post('/api/auth/logout', {
  139 |       headers: { Authorization: `Bearer ${body.token}` },
  140 |     });
  141 |     expect(out.ok()).toBeTruthy();
  142 | 
  143 |     const after = await request.get('/api/auth/me', {
  144 |       headers: { Authorization: `Bearer ${body.token}` },
  145 |     });
  146 |     expect(after.status()).toBe(401);
  147 |   });
  148 | });
  149 | 
```