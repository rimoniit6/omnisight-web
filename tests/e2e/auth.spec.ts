/**
 * AUTH-E2E — real-browser authentication coverage.
 *
 *  login / invalid login / validation error / logout (UI) /
 *  session expiration (server-side expiry) / revoked session (API logout)
 */
import { test, expect, creds } from './fixtures';
import { expireSessionsFor } from './support/db';

test.describe('Authentication', () => {
  test('login with valid credentials lands on the dashboard', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('main', { name: 'Login' })).toBeVisible();
    await page.locator('#email').fill(creds('admin').email);
    await page.locator('#password').fill(creds('admin').password);
    await page.getByRole('button', { name: /sign in/i }).click();

    // Success: app shell + toast feedback.
    await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.locator('[data-sonner-toast]')).toContainText(/Welcome back/i);
  });

  test('invalid password shows the uniform error and stays on login', async ({ page }) => {
    await page.goto('/');
    await page.locator('#email').fill(creds('viewer').email);
    await page.locator('#password').fill('definitely-wrong-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    const alert = page.locator('#login-error');
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/invalid email or password/i);
    await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toHaveCount(0);
  });

  test('unknown email shows the same uniform error (no user enumeration)', async ({ page }) => {
    await page.goto('/');
    await page.locator('#email').fill('ghost@nowhere.test');
    await page.locator('#password').fill('whatever-password-1');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.locator('#login-error')).toContainText(/invalid email or password/i);
  });

  test('empty submit shows client-side validation error', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByText(/please enter both email and password/i)).toBeVisible();
    // No API call should have been made.
    await expect(page.locator('#email')).toBeVisible();
  });

  test('logout via the user menu revokes the session and returns to login', async ({ page }) => {
    // Dedicated fresh login — never reuses a persisted storage state, so this
    // logout cannot poison other tests' sessions.
    await page.goto('/');
    await page.locator('#email').fill(creds('owner').email);
    await page.locator('#password').fill(creds('owner').password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible();

    // The user menu lives in the header (role="banner"); its trigger is the
    // avatar button with aria-label "Upload avatar for <name>".
    await page.locator('header[role="banner"] button[aria-label*="Owner"]').click();
    await page.getByRole('menuitem', { name: /log ?out/i }).click();

    await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
    // The session is dead server-side: reload still shows the login form.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
  });

  test('server-side session expiration forces re-authentication', async ({ page }) => {
    await page.goto('/');
    await page.locator('#email').fill(creds('manager').email);
    await page.locator('#password').fill(creds('manager').password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible();

    // Expire the session row directly (simulates TTL passing).
    const expired = await expireSessionsFor(creds('manager').email);
    expect(expired).toBeGreaterThan(0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
  });

  test('revoked session rejects subsequent API access (401)', async ({ request }) => {
    // Login via API.
    const login = await request.post('/api/auth/login', {
      data: { email: creds('viewer').email, password: creds('viewer').password },
    });
    expect(login.status()).toBe(200);
    const body = await login.json();
    expect(body.token).toBeTruthy();

    const authed = await request.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(authed.status()).toBe(200);

    // Logout revokes the server-side session row.
    const out = await request.post('/api/auth/logout', {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(out.ok()).toBeTruthy();

    const after = await request.get('/api/auth/me', {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(after.status()).toBe(401);
  });
});
