# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth.spec.ts >> Authentication >> logout via the user menu revokes the session and returns to login
- Location: tests\e2e\auth.spec.ts:66:7

# Error details

```
TimeoutError: locator.click: Timeout 10000ms exceeded.
Call log:
  - waiting for getByRole('menuitem', { name: /log ?out/i })
    - locator resolved to <div tabindex="-1" role="menuitem" data-variant="default" data-orientation="vertical" data-radix-collection-item="" data-slot="dropdown-menu-item" class="focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foregroun…>…</div>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div class="fixed inset-0 z-[100]">…</div> from <div aria-hidden="true" data-aria-hidden="true" class="h-screen overflow-hidden flex flex-col">…</div> subtree intercepts pointer events
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div class="fixed inset-0 z-[100]">…</div> from <div aria-hidden="true" data-aria-hidden="true" class="h-screen overflow-hidden flex flex-col">…</div> subtree intercepts pointer events
    - retrying click action
      - waiting 100ms
    18 × waiting for element to be visible, enabled and stable
       - element is visible, enabled and stable
       - scrolling into view if needed
       - done scrolling
       - <div class="fixed inset-0 z-[100]">…</div> from <div aria-hidden="true" data-aria-hidden="true" class="h-screen overflow-hidden flex flex-col">…</div> subtree intercepts pointer events
     - retrying click action
       - waiting 500ms

```

# Page snapshot

```yaml
- generic:
  - generic:
    - link:
      - /url: "#main-content"
      - text: Skip to main content
    - generic:
      - complementary:
        - generic: OmniSight
        - navigation:
          - generic:
            - paragraph: Overview
            - list:
              - button:
                - generic: Dashboard
              - button:
                - generic: Employees
              - button:
                - generic: Departments
              - button:
                - generic: Devices
              - button:
                - generic: Activities
              - button:
                - generic: Screenshots
              - button:
                - generic: Audio Transcriptions
              - button:
                - generic: Break Monitor
              - button:
                - generic: Live Monitor
              - button:
                - generic: Analytics
          - generic:
            - paragraph: Intelligence
            - list:
              - button:
                - generic: AI Insights
              - button:
                - generic: Sentiment
              - button:
                - generic: AI Provider
          - generic:
            - paragraph: Security
            - list:
              - button:
                - generic: Agent Approvals
              - button:
                - generic: Notifications
              - button:
                - generic: Alerts
              - button:
                - generic: Audit Logs
              - button:
                - generic: Agent Security
              - button:
                - generic: Policies
              - button:
                - generic: Anomaly Detection
              - button:
                - generic: Consent
          - generic:
            - paragraph: Work Management
            - list:
              - button:
                - generic: Projects
          - generic:
            - paragraph: Employee
            - list:
              - button:
                - generic: Employee Portal
          - generic:
            - paragraph: Admin
            - list:
              - button:
                - generic: Organization
              - button:
                - generic: Users & Members
              - button:
                - generic: Reports
              - button:
                - generic: Daily Report
              - button:
                - generic: Settings
        - generic:
          - generic:
            - paragraph: All systems operational
        - generic:
          - generic:
            - generic: OU
            - generic:
              - paragraph: Owner User
              - paragraph: Organization Admin
        - generic:
          - button [expanded]:
            - generic: Collapse
      - generic:
        - banner:
          - generic:
            - generic:
              - heading [level=1]: Dashboard
              - navigation:
                - button:
                  - generic: Home
          - generic:
            - generic:
              - button:
                - generic: Search...
                - generic: Ctrl K
            - generic:
              - button
            - button
            - generic:
              - button
            - button [expanded]:
              - generic: OU
              - generic: Owner
        - main:
          - generic:
            - region:
              - generic:
                - generic:
                  - generic:
                    - button:
                      - generic: Add Employee
                    - button:
                      - generic: Generate Report
                    - button:
                      - generic: View Alerts
                    - button:
                      - generic: Settings
                - generic:
                  - button:
                    - generic: Export PDF
                  - button:
                    - generic: Live
                  - button:
                    - generic: Customize
              - generic:
                - generic:
                  - generic:
                    - generic:
                      - generic:
                        - generic:
                          - generic: Welcome back
                          - heading [level=2]: Good Afternoon, Owner
                          - paragraph: Tuesday, September 1, 2026
                          - paragraph: Halfway through the day — keep it up!
                        - generic:
                          - generic: 1 active employees
                          - generic: 0 online devices
                      - generic:
                        - button: Add Employee
                        - button: View Reports
                        - button: Generate Report
                        - button: View Alerts
              - generic:
                - generic:
                  - generic:
                    - generic:
                      - generic:
                        - generic:
                          - paragraph: Total Employees
                          - generic:
                            - paragraph: "1"
                          - paragraph: current
                  - generic:
                    - generic:
                      - generic:
                        - generic:
                          - paragraph: Online Devices
                          - generic:
                            - paragraph: 0/2
                          - paragraph: current
                  - generic:
                    - generic:
                      - generic:
                        - generic:
                          - paragraph: Avg Productive Hrs
                          - generic:
                            - paragraph: 1.0 hrs
                          - paragraph: current
                  - generic:
                    - generic:
                      - generic:
                        - generic:
                          - paragraph: Active Alerts
                          - generic:
                            - paragraph: "0"
                          - paragraph: active now
                  - generic:
                    - generic:
                      - generic:
                        - generic: 92%
                        - generic:
                          - paragraph: Productivity Score
                          - paragraph: 92%
                          - paragraph: overall score
              - generic:
                - generic:
                  - generic:
                    - generic: Weekly Productivity (minutes)
                    - generic:
                      - generic:
                        - generic:
                          - generic:
                            - img:
                              - generic:
                                - generic:
                                  - generic: Thu, Aug 27
                                  - generic: Fri, Aug 28
                                  - generic: Sat, Aug 29
                                  - generic: Sun, Aug 30
                                  - generic: Tue, Sep 1
                              - generic:
                                - generic:
                                  - generic: "0"
                                  - generic: "15"
                                  - generic: "30"
                                  - generic: "45"
                                  - generic: "60"
                            - generic:
                              - list:
                                - listitem: Productive
                                - listitem: Neutral
                                - listitem: Unproductive
                - generic:
                  - generic:
                    - generic:
                      - generic: Department Distribution
                      - paragraph: Click a slice to filter employees by department
                    - generic:
                      - generic:
                        - generic:
                          - generic:
                            - generic:
                              - paragraph: "2"
                              - paragraph: Employees
                        - generic:
                          - generic:
                            - generic: Engineering
                            - generic: 100.0%
              - generic:
                - generic:
                  - generic:
                    - generic: Device Status
                    - generic:
                      - generic:
                        - generic:
                          - generic:
                            - generic:
                              - paragraph: "2"
                              - paragraph: Devices
                        - generic:
                          - generic:
                            - generic: Offline
                            - generic: 100.0%
                - generic:
                  - generic:
                    - generic: Top Performers
                    - generic:
                      - generic:
                        - generic:
                          - generic: AL
                          - generic:
                            - generic:
                              - paragraph: Ada Lovelace
                            - paragraph: Engineering
                          - generic: 0.9h
              - generic:
                - generic:
                  - generic: Recent Activity
                  - generic:
                    - generic:
                      - generic:
                        - generic:
                          - generic:
                            - generic:
                              - generic:
                                - generic: AL
                                - generic:
                                  - generic:
                                    - generic: Ada Lovelace
                                    - generic: Web
                                  - paragraph: Example News
                                  - paragraph: about 1 hour ago · 5min
                            - generic:
                              - generic:
                                - generic: AL
                                - generic:
                                  - generic:
                                    - generic: Ada Lovelace
                                    - generic: App
                                  - paragraph: Code.exe
                                  - paragraph: about 1 hour ago · 40min
                            - generic:
                              - generic:
                                - generic: AL
                                - generic:
                                  - generic:
                                    - generic: Ada Lovelace
                                    - generic: Web
                                  - paragraph: GitHub — Pull Requests
                                  - paragraph: about 1 hour ago · 15min
        - contentinfo:
          - generic:
            - generic: © 2026 OmniSight v1.0.0
            - generic:
              - button: Dashboard
              - generic: ·
              - button: Employees
              - generic: ·
              - button: Settings
    - generic:
      - heading [level=2]: Command Palette
      - paragraph: Search for a command to run...
    - generic [ref=e5]:
      - generic [ref=e6]:
        - generic [ref=e7]: 1/6
        - button [ref=e16]
      - heading [level=3] [ref=e20]: Welcome to OmniSight! 👋
      - paragraph [ref=e21]: This is your navigation sidebar. Use it to switch between all pages — from Dashboard and Employees to AI Insights and Reports. Click the arrow at the bottom to collapse it for more space.
      - generic [ref=e22]:
        - button [ref=e24]: Skip tour
        - button [ref=e25]: Next
  - button "Open Next.js Dev Tools" [ref=e31] [cursor=pointer]
  - alert
  - generic: "60"
  - menu "OU Upload avatar for Owner User Owner" [active] [ref=e35]:
    - menuitem "Settings" [ref=e36]
    - separator [ref=e37]
    - menuitem "Change Password" [ref=e38]
    - separator [ref=e39]
    - menuitem "Logout" [ref=e40]
```

# Test source

```ts
  1   | /**
  2   |  * AUTH-E2E — real-browser authentication coverage.
  3   |  *
  4   |  *  login / invalid login / validation error / logout (UI) /
  5   |  *  session expiration (server-side expiry) / revoked session (API logout)
  6   |  */
  7   | import { test, expect, creds } from './fixtures';
  8   | import { expireSessionsFor } from './support/db';
  9   | 
  10  | /** Dismiss the onboarding tour overlay and sonner toasts that block clicks. */
  11  | async function dismissOverlays(page: import('@playwright/test').Page) {
  12  |   await page.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));
  13  |   // Remove the tour overlay and sonner toast container from the DOM entirely.
  14  |   await page.evaluate(() => {
  15  |     document.querySelectorAll('[data-sonner-toast]').forEach((el) => el.remove());
  16  |     document.querySelectorAll('section[aria-label*="Notifications"]').forEach((el) => el.remove());
  17  |     // Remove the fixed overlay at z-[100] (onboarding tour).
  18  |     document.querySelectorAll('div.fixed.inset-0').forEach((el) => el.remove());
  19  |   });
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
> 88  |     await page.getByRole('menuitem', { name: /log ?out/i }).click({ timeout: 10_000 });
      |                                                             ^ TimeoutError: locator.click: Timeout 10000ms exceeded.
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
  120 |     await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
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