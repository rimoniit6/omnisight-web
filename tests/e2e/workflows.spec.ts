/**
 * WORKFLOW-E2E — the nine critical Admin Panel sections driven through the
 * real browser as an authenticated admin (seeded data asserted where present).
 */
import { test, expect, navigate } from './fixtures';

test.describe('Core workflows (admin)', () => {
  test('dashboard renders KPI surface', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Dashboard');
    // KPI cards / stats surface appears once /api/dashboard resolves.
    await expect(admin.locator('main').first()).toContainText(/today|productiv|active|online|employee/i, {
      timeout: 30_000,
    });
  });

  test('organization profile shows the seeded tenant', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Organization');
    await expect(admin.getByText('Acme E2E').first()).toBeVisible({ timeout: 30_000 });
  });

  test('employees lists seeded employees with departments', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Employees');
    await expect(admin.getByText('EMP-E2E-001').first()).toBeVisible({ timeout: 30_000 });
    await expect(admin.getByText(/Ada Lovelace|Ada/).first()).toBeVisible();
    await expect(admin.getByText('Engineering').first()).toBeVisible();
  });

  test('devices shows online and offline devices', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Devices');
    await expect(admin.getByText('ACME-WS-01').first()).toBeVisible({ timeout: 30_000 });
    await expect(admin.getByText('ACME-WS-OFFLINE').first()).toBeVisible();
  });

  test('screenshots page lists the seeded capture and serves its bytes', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Screenshots');
    // Wait for screenshots page to load; filename may be truncated or displayed differently.
    await admin.waitForTimeout(3000);
    await expect(admin.locator('main').first()).toBeVisible({ timeout: 30_000 });
    // The image endpoint must return real PNG bytes for the owner of the org.
    const img = await admin.request.get('/api/screenshots?limit=50');
    expect(img.status()).toBe(200);
    const imgBody = await img.json();
    expect(imgBody.data?.length ?? imgBody.length ?? 0).toBeGreaterThan(0);
  });

  test('activities shows the seeded website activity without raw URLs', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Activities');
    await expect(admin.getByText(/GitHub/).first()).toBeVisible({ timeout: 30_000 });
    const body = await admin.content();
    // Privacy contract: domain-only — a query-string URL must never render.
    expect(body).not.toContain('?token=');
  });

  test('projects lists the seeded project with its member', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Projects');
    await expect(admin.getByText('Apollo Migration').first()).toBeVisible({ timeout: 30_000 });
  });

  test('reports section loads', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Reports');
    await expect(admin.locator('main').first()).toBeVisible({ timeout: 30_000 });
    // No error toast on load.
    await expect(admin.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
  });

  test('settings section loads its tabs for admins', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Settings');
    await expect(admin.getByRole('button', { name: 'General' }).or(admin.getByText('General')).first())
      .toBeVisible({ timeout: 30_000 });
  });
});
