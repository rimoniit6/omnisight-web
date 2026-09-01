# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: authorization.spec.ts >> Authorization — role-specific navigation >> owner sees every section
- Location: tests\e2e\authorization.spec.ts:38:7

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
  - textbox "Email Address" [invalid]:
    - /placeholder: you@company.com
    - text: owner@acme-e2e.test
  - text: Password
  - textbox "Password" [invalid]:
    - /placeholder: Enter your password
    - text: Owner!E2e-1234
  - button "Show password"
  - alert: Invalid email or password
  - button "Sign In"
  - paragraph: © 2026 OmniSight · Workforce Intelligence Platform
- region "Notifications alt+T"
- alert
```

# Test source

```ts
  1   | /**
  2   |  * E2E fixtures — per-role authenticated contexts.
  3   |  *
  4   |  * Each role logs in exactly ONCE (via the real login form), the authenticated
  5   |  * storage state is persisted, and every subsequent test for that role reuses
  6   |  * the httpOnly session cookie. This keeps the login rate-limit bucket
  7   |  * (10 / 5 min / IP+email) far below its ceiling while still exercising the
  8   |  * real UI login path.
  9   |  */
  10  | import { test as base, expect, type Browser, type Page } from '@playwright/test';
  11  | import fs from 'node:fs';
  12  | import path from 'node:path';
  13  | 
  14  | export type Role = 'superAdmin' | 'owner' | 'admin' | 'manager' | 'viewer' | 'betaOwner';
  15  | 
  16  | const AUTH_DIR = path.join(__dirname, '.auth');
  17  | const MANIFEST = JSON.parse(
  18  |   fs.readFileSync(path.join(AUTH_DIR, 'credentials.json'), 'utf8')
  19  | ) as {
  20  |   credentials: Record<Role, { email: string; password: string }>;
  21  | };
  22  | 
  23  | export const creds = (role: Role) => MANIFEST.credentials[role];
  24  | 
  25  | function stateFile(role: Role): string {
  26  |   return path.join(AUTH_DIR, `${role}.state.json`);
  27  | }
  28  | 
  29  | /** Perform a REAL UI login and persist the resulting cookie jar. */
  30  | async function loginAndSaveState(role: Role): Promise<string> {
  31  |   const file = stateFile(role);
  32  |   if (fs.existsSync(file)) return file;
  33  | 
  34  |   const { chromium } = await import('@playwright/test');
  35  |   const browser = await chromium.launch();
  36  |   const page = await browser.newPage();
  37  |   await page.goto('/', { waitUntil: 'domcontentloaded' });
  38  |   // The unauthenticated app renders the LoginPage.
  39  |   const email = page.locator('#email');
  40  |   await email.waitFor({ state: 'visible', timeout: 30_000 });
  41  |   await email.fill(creds(role).email);
  42  |   await page.locator('#password').fill(creds(role).password);
  43  |   await page.getByRole('button', { name: /sign in/i }).click();
  44  |   // Successful login lands on the dashboard shell.
> 45  |   await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible({
      |                                                                                 ^ Error: expect(locator).toBeVisible() failed
  46  |     timeout: 45_000,
  47  |   });
  48  |   await page.waitForLoadState('networkidle').catch(() => {});
  49  |   // Dismiss the onboarding tour overlay so it does not block sidebar clicks
  50  |   // in subsequent test sessions. The tour is gated on localStorage.
  51  |   await page.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));
  52  |   await page.getByRole('button', { name: /skip tour/i }).first()
  53  |     .click({ timeout: 3_000 }).catch(() => {});
  54  |   await page.waitForTimeout(500);
  55  |   fs.mkdirSync(AUTH_DIR, { recursive: true });
  56  |   await page.context().storageState({ path: file });
  57  |   await browser.close();
  58  |   return file;
  59  | }
  60  | 
  61  | type RoleFixtures = Partial<Record<Role, Page>> & { rolePage?: Page };
  62  | 
  63  | export const test = base.extend<RoleFixtures>({
  64  |   superAdmin: async ({ browser }, use) => use(await roleContext(browser, 'superAdmin')),
  65  |   owner: async ({ browser }, use) => use(await roleContext(browser, 'owner')),
  66  |   admin: async ({ browser }, use) => use(await roleContext(browser, 'admin')),
  67  |   manager: async ({ browser }, use) => use(await roleContext(browser, 'manager')),
  68  |   viewer: async ({ browser }, use) => use(await roleContext(browser, 'viewer')),
  69  |   betaOwner: async ({ browser }, use) => use(await roleContext(browser, 'betaOwner')),
  70  | });
  71  | 
  72  | async function roleContext(browser: Browser, role: Role): Promise<Page> {
  73  |   const statePath = await loginAndSaveState(role);
  74  |   const context = await browser.newContext({ storageState: statePath });
  75  |   const page = await context.newPage();
  76  |   return page;
  77  | }
  78  | 
  79  | /** Cookie-authenticated APIRequestContext for a role (storage-state reuse). */
  80  | export async function apiAs(
  81  |   playwright: typeof import('@playwright/test'),
  82  |   role: Role
  83  | ): Promise<import('@playwright/test').APIRequestContext> {
  84  |   const statePath = await loginAndSaveState(role);
  85  |   return playwright.request.newContext({ storageState: statePath });
  86  | }
  87  | 
  88  | /** Ensure a role's persisted session exists; returns the storage-state path. */
  89  | export async function ensureRoleState(role: Role): Promise<string> {
  90  |   return loginAndSaveState(role);
  91  | }
  92  | 
  93  | export { expect };
  94  | 
  95  | // ─── Shared helpers ─────────────────────────────────────────────────────────
  96  | 
  97  | /**
  98  |  * Dismiss any blocking overlay (onboarding tour, command-palette backdrop,
  99  |  * etc.) that sits at z-[100] or higher and intercepts pointer events.
  100 |  */
  101 | async function dismissBlockingOverlays(page: Page): Promise<void> {
  102 |   // Ensure the tour is marked completed in localStorage so it does not reappear.
  103 |   await page
  104 |     .evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'))
  105 |     .catch(() => {});
  106 |   // Click the "Skip tour" button if the overlay is currently visible.
  107 |   await page
  108 |     .getByRole('button', { name: /skip tour/i })
  109 |     .first()
  110 |     .click({ timeout: 1_500 })
  111 |     .catch(() => {});
  112 |   // Press Escape to close any command-palette / modal overlay.
  113 |   await page.keyboard.press('Escape').catch(() => {});
  114 | }
  115 | 
  116 | /** Navigate via the sidebar button identified by its aria-label. */
  117 | export async function navigate(page: Page, label: string): Promise<void> {
  118 |   // Find the sidebar region first, then locate the button by aria-label.
  119 |   // Using getByRole on the sidebar region + CSS aria-label selector avoids
  120 |   // issues with Radix Tooltip wrappers and CSS transition animations that
  121 |   // can make bare getByRole('button', { name }) flake in headless Chromium.
  122 |   const sidebar = page.getByRole('complementary', { name: 'Sidebar navigation' });
  123 |   await sidebar.waitFor({ state: 'visible', timeout: 15_000 });
  124 |   // Dismiss any blocking overlay (onboarding tour, command palette backdrop,
  125 |   // etc.) that may be sitting on top of the sidebar.
  126 |   await dismissBlockingOverlays(page);
  127 |   // Try CSS aria-label selector first (works even through Radix wrappers).
  128 |   let btn = sidebar.locator(`button[aria-label="${label}"]`).first();
  129 |   if ((await btn.count()) === 0) {
  130 |     // Fallback: getByRole (may fail with Radix Tooltip in headless).
  131 |     btn = sidebar.getByRole('button', { name: label, exact: true }).first();
  132 |   }
  133 |   if ((await btn.count()) === 0) {
  134 |     throw new Error(`Navigation item "${label}" not found — access denied for this role?`);
  135 |   }
  136 |   await btn.click({ timeout: 10_000 });
  137 | }
  138 | 
  139 | /** The main content region heading for a freshly opened admin section. */
  140 | export function mainHeading(page: Page): ReturnType<Page['getByRole']> {
  141 |   return page.getByRole('heading').first();
  142 | }
  143 | 
```