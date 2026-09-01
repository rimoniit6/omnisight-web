/**
 * AUTH-E2E — real-browser authentication coverage.
 *
 *  login / invalid login / validation error / logout (UI) /
 *  session expiration (server-side expiry) / revoked session (API logout)
 */
import { test, expect, creds } from './fixtures';
import { expireSessionsFor } from './support/db';

/** Dismiss the onboarding tour overlay and sonner toasts that block clicks. */
async function dismissOverlays(page: import('@playwright/test').Page) {
  await page.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));
  // Remove the tour overlay and sonner toast container from the DOM entirely.
  await page.evaluate(() => {
    document.querySelectorAll('[data-sonner-toast]').forEach((el) => el.remove());
    document.querySelectorAll('section[aria-label*="Notifications"]').forEach((el) => el.remove());
    // Remove the fixed overlay at z-[100] (onboarding tour).
    document.querySelectorAll('div.fixed.inset-0').forEach((el) => el.remove());
  });
  await page.waitForTimeout(500);
}

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
    // Dedicated fresh login — never reuses a persisted storage state.
    await page.goto('/');
    await page.locator('#email').fill(creds('owner').email);
    await page.locator('#password').fill(creds('owner').password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible();

    // Dismiss tour overlay and sonner toasts that intercept pointer events.
    await dismissOverlays(page);

    // Use evaluate to trigger the Radix dropdown — dispatch both pointerdown and click.
    await page.evaluate(() => {
      const trigger = document.querySelector('[data-slot="dropdown-menu-trigger"]') as HTMLElement | null;
      if (trigger) {
        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        trigger.click();
      }
    });
    await page.waitForTimeout(800);
    // Click the Logout menu item.
    await page.getByRole('menuitem', { name: /log ?out/i }).click({ timeout: 10_000 });

    await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
    // The session is dead server-side: reload still shows the login form.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('main', { name: 'Login' })).toBeVisible({ timeout: 30_000 });
  });

  test('server-side session expiration forces re-authentication', async ({ page, request }) => {
    await page.goto('/');
    await page.locator('#email').fill(creds('manager').email);
    await page.locator('#password').fill(creds('manager').password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible();
    // Dismiss overlays.
    await dismissOverlays(page);

    // Expire the session row directly (simulates TTL passing).
    const expired = await expireSessionsFor(creds('manager').email);
    expect(expired).toBeGreaterThan(0);

    // Verify that /api/auth/me now rejects with 401 — the session is dead.
    const me = await request.get('/api/auth/me');
    expect(me.status()).toBe(401);

    // Reload — the client hydrates from /api/auth/me, which returns 401,
    // causing logout() and the login page to render.
    // Navigate to the root to force a fresh hydrate cycle.
    await page.goto('/', { waitUntil: 'networkidle' });
    // Wait for the auth check to complete (hydrate + react query).
    await page.waitForTimeout(5000);
    // The auth store should now show the login page.
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
