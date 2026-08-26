/**
 * RESPONSIVE-E2E — desktop / tablet / mobile viewport behavior of the shell:
 * collapsed rail on small screens, mobile drawer navigation, usable content.
 */
import { test, expect, ensureRoleState } from './fixtures';
import fs from 'node:fs';
import path from 'node:path';

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  mobile: { width: 390, height: 844 },
};

for (const [name, viewport] of Object.entries(VIEWPORTS)) {
  test(`admin panel is usable at ${name} (${viewport.width}x${viewport.height})`, async ({ browser }) => {
    const statePath = await ensureRoleState('admin');
    const context = await browser.newContext({
      storageState: fs.existsSync(statePath) ? statePath : undefined,
      viewport,
    });
    const page = await context.newPage();
    await page.goto('/');

    if (name === 'desktop') {
      await expect(page.getByRole('complementary', { name: 'Sidebar navigation' })).toBeVisible({ timeout: 45_000 });
    } else {
      // Small screens hide the fixed rail; a hamburger opens the mobile drawer.
      const rail = page.getByRole('complementary', { name: 'Sidebar navigation' });
      if (!(await rail.isVisible().catch(() => false))) {
        const hamburger = page.getByRole('button', { name: /menu|open sidebar/i }).first();
        if ((await hamburger.count()) > 0) {
          await hamburger.click();
        }
      }
      await expect(
        page
          .getByRole('complementary', { name: 'Sidebar navigation' })
          .or(page.locator('[data-slot="sheet-content"]'))
          .first()
      ).toBeVisible({ timeout: 30_000 });
    }

    // Content area renders and no horizontal overflow breaks the layout.
    await expect(page.locator('main').first()).toBeVisible({ timeout: 30_000 });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewport.width + 2);

    await context.close();
  });
}
