# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: auth.spec.ts >> Authentication >> server-side session expiration forces re-authentication
- Location: tests\e2e\auth.spec.ts:73:7

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('complementary', { name: 'Sidebar navigation' })
Expected: visible
Timeout: 15000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 15000ms
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
    - text: manager@acme-e2e.test
  - text: Password
  - textbox "Password" [invalid]:
    - /placeholder: Enter your password
    - text: Manager!E2e-1234
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
  2   |  * AUTH-E2E — real-browser authentication coverage.
  3   |  *
  4   |  *  login / invalid login / validation error / logout (UI) /
  5   |  *  session expiration (server-side expiry) / revoked session (API logout)
  6   |  */
  7   | import { test, expect, creds } from './fixtures';
  8   | import { expireSessionsFor } from './support/db';
  9   | 
  10  | test.describe('Authentication', () => {
  11  |   test('login with valid credentials lands on the dashboard', async ({ page }) => {
  12  |     await page.goto('/');
  13  |     await expect(page.getByRole('main', { name: 'Login' })).toBeVisible();
  14  |     await page.locator('#email').fill(creds('admin').email);
  15  |     await page.locator('#password').fill(creds('admin').password);
  16  |     await page.getByRole('button', { name: /sign in/i }).click();
  17  | 
  18  |     // Success: app shell + toast feedback.
  19  |     await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible({
  20  |       timeout: 45_000,
  21  |     });
  22  |     await expect(page.locator('[data-sonner-toast]')).toContainText(/Welcome back/i);
  23  |   });
  24  | 
  25  |   test('invalid password shows the uniform error and stays on login', async ({ page }) => {
  26  |     await page.goto('/');
  27  |     await page.locator('#email').fill(creds('viewer').email);
  28  |     await page.locator('#password').fill('definitely-wrong-password');
  29  |     await page.getByRole('button', { name: /sign in/i }).click();
  30  | 
  31  |     const alert = page.locator('#login-error');
  32  |     await expect(alert).toBeVisible();
  33  |     await expect(alert).toContainText(/invalid email or password/i);
  34  |     await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toHaveCount(0);
  35  |   });
  36  | 
  37  |   test('unknown email shows the same uniform error (no user enumeration)', async ({ page }) => {
  38  |     await page.goto('/');
  39  |     await page.locator('#email').fill('ghost@nowhere.test');
  40  |     await page.locator('#password').fill('whatever-password-1');
  41  |     await page.getByRole('button', { name: /sign in/i }).click();
  42  |     await expect(page.locator('#login-error')).toContainText(/invalid email or password/i);
  43  |   });
  44  | 
  45  |   test('empty submit shows client-side validation error', async ({ page }) => {
  46  |     await page.goto('/');
  47  |     await page.getByRole('button', { name: /sign in/i }).click();
  48  |     await expect(page.getByText(/please enter both email and password/i)).toBeVisible();
  49  |     // No API call should have been made.
  50  |     await expect(page.locator('#email')).toBeVisible();
  51  |   });
  52  | 
  53  |   test('logout via the user menu revokes the session and returns to login', async ({ page }) => {
  54  |     // Dedicated fresh login — never reuses a persisted storage state, so this
  55  |     // logout cannot poison other tests' sessions.
  56  |     await page.goto('/');
  57  |     await page.locator('#email').fill(creds('owner').email);
  58  |     await page.locator('#password').fill(creds('owner').password);
  59  |     await page.getByRole('button', { name: /sign in/i }).click();
  60  |     await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible();
  61  | 
  62  |     // The user menu lives in the header (role="banner"); its trigger is the
  63  |     // avatar button with aria-label "Upload avatar for <name>".
  64  |     await page.locator('header[role="banner"] button[aria-label*="Owner"]').click();
  65  |     await page.getByRole('menuitem', { name: /log ?out/i }).click();
  66  | 
  67  |     await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
  68  |     // The session is dead server-side: reload still shows the login form.
  69  |     await page.reload({ waitUntil: 'domcontentloaded' });
  70  |     await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
  71  |   });
  72  | 
  73  |   test('server-side session expiration forces re-authentication', async ({ page }) => {
  74  |     await page.goto('/');
  75  |     await page.locator('#email').fill(creds('manager').email);
  76  |     await page.locator('#password').fill(creds('manager').password);
  77  |     await page.getByRole('button', { name: /sign in/i }).click();
> 78  |     await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible();
      |                                                                                   ^ Error: expect(locator).toBeVisible() failed
  79  | 
  80  |     // Expire the session row directly (simulates TTL passing).
  81  |     const expired = await expireSessionsFor(creds('manager').email);
  82  |     expect(expired).toBeGreaterThan(0);
  83  | 
  84  |     await page.reload({ waitUntil: 'domcontentloaded' });
  85  |     await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
  86  |   });
  87  | 
  88  |   test('revoked session rejects subsequent API access (401)', async ({ request }) => {
  89  |     // Login via API.
  90  |     const login = await request.post('/api/auth/login', {
  91  |       data: { email: creds('viewer').email, password: creds('viewer').password },
  92  |     });
  93  |     expect(login.status()).toBe(200);
  94  |     const body = await login.json();
  95  |     expect(body.token).toBeTruthy();
  96  | 
  97  |     const authed = await request.get('/api/auth/me', {
  98  |       headers: { Authorization: `Bearer ${body.token}` },
  99  |     });
  100 |     expect(authed.status()).toBe(200);
  101 | 
  102 |     // Logout revokes the server-side session row.
  103 |     const out = await request.post('/api/auth/logout', {
  104 |       headers: { Authorization: `Bearer ${body.token}` },
  105 |     });
  106 |     expect(out.ok()).toBeTruthy();
  107 | 
  108 |     const after = await request.get('/api/auth/me', {
  109 |       headers: { Authorization: `Bearer ${body.token}` },
  110 |     });
  111 |     expect(after.status()).toBe(401);
  112 |   });
  113 | });
  114 | 
```