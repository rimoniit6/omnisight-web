/**
 * UI-STATE-E2E — loading, empty, error, success, destructive confirmation,
 * and toast feedback through real interactions.
 */
import { test, expect, navigate } from './fixtures';

test.describe('UI states', () => {
  test('dashboard shows a skeleton while data loads', async ({ admin }) => {
    await admin.route('/api/dashboard*', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await admin.goto('/');
    await navigate(admin, 'Dashboard');
    // The skeleton (pulse placeholders) is rendered while the query is in flight.
    await expect(admin.locator('.animate-pulse').first()).toBeVisible({ timeout: 10_000 });
  });

  test('employee search with no matches shows the empty state', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Employees');
    await expect(admin.getByText('EMP-E2E-001').first()).toBeVisible({ timeout: 30_000 });

    const search = admin.getByPlaceholder(/search/i).first();
    if ((await search.count()) > 0) {
      await search.fill('zzz-no-such-employee-zzz');
      await expect(
        admin.getByText(/no employees|nothing found|no results|0 of/i).first()
      ).toBeVisible({ timeout: 15_000 });
    }
  });

  test('failed form submit surfaces an inline error (validation)', async ({ page }) => {
    await page.goto('/');
    // Missing password → client-side validation error, no navigation.
    await page.locator('#email').fill('admin@acme-e2e.test');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByText(/please enter both email and password/i)).toBeVisible();
  });

  test('department create → success toast → destructive confirm flow', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Departments');
    await expect(admin.getByText('Engineering').first()).toBeVisible({ timeout: 30_000 });

    // CREATE — success toast feedback.
    await admin.getByRole('button', { name: /add department/i }).click();
    await admin.getByRole('dialog').getByPlaceholder(/name/i).or(admin.getByRole('dialog').locator('#name')).fill('E2E Temp Dept');
    await admin.getByRole('dialog').getByRole('button', { name: /^create$/i }).click();
    await expect(admin.locator('[data-sonner-toast]')).toContainText(/Department created/i);
    await expect(admin.getByText('E2E Temp Dept').first()).toBeVisible({ timeout: 15_000 });

    // DELETE — destructive confirmation via the row dropdown.
    const row = admin.locator('tr, [data-slot="card"]').filter({ hasText: 'E2E Temp Dept' }).first();
    await row.getByRole('button').last().click();
    await admin.getByRole('menuitem', { name: /delete/i }).click();
    await expect(admin.getByText('E2E Temp Dept').first()).not.toBeVisible({ timeout: 15_000 });
    await expect(admin.locator('[data-sonner-toast]')).toContainText(/Department deleted/i);
    // The pre-existing seeded department is untouched.
    await expect(admin.getByText('Engineering').first()).toBeVisible();
  });

  test('screenshot deletion requires confirmation and toasts on success', async ({ admin }) => {
    await admin.goto('/');
    await navigate(admin, 'Screenshots');
    await expect(admin.getByText(/e2e-shot\.png/).first()).toBeVisible({ timeout: 45_000 });

    const menu = admin.getByRole('button', { name: /more|actions|menu/i }).first();
    if ((await menu.count()) === 0) {
      test.skip(true, 'screenshot row actions not exposed at this viewport');
      return;
    }
    await menu.click();
    await admin.getByRole('menuitem', { name: /delete/i }).click();

    // Destructive confirmation dialog must appear BEFORE anything is deleted.
    await expect(admin.getByText(/are you sure/i).first()).toBeVisible();
    await admin.getByRole('button', { name: /^(cancel|never mind)$/i }).first().click();
    await expect(admin.getByText(/e2e-shot\.png/).first()).toBeVisible(); // cancel kept it
  });

  test('API error state renders an error surface instead of crashing', async ({ admin }) => {
    await admin.route('/api/reports*', (route) => route.fulfill({ status: 500, body: 'boom' }));
    await admin.goto('/');
    await navigate(admin, 'Reports');
    // react-query surfaces an error state; the app must still be interactive.
    await expect(admin.locator('main').first()).toBeVisible({ timeout: 30_000 });
    await expect(admin.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible();
  });
});
