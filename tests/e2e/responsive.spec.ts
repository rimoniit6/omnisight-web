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
      // Small screens may hide the sidebar rail. The hamburger ("Open navigation
      // menu") opens a mobile drawer. Wait for the page to be interactive first,
      // then try to open the drawer.
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2000);

      // The hamburger is visible on mobile.
      const hamburger = page.getByRole('button', { name: /open navigation menu/i }).first();
      if ((await hamburger.count()) > 0) {
        await hamburger.click();
        await page.waitForTimeout(1000);
      }

      // After clicking, the sidebar navigation should be visible.
      // It may be inside a sheet or directly rendered; accept either.
      const sidebar = page.getByRole('complementary', { name: 'Sidebar navigation' });
      const sheet = page.locator('[data-slot="sheet-content"], [role="dialog"], [data-state="open"]').first();
      await expect(sidebar.or(sheet).first()).toBeVisible({ timeout: 30_000 });

      // Close the drawer if it opened.
      await page.keyboard.press('Escape').catch(() => {});
    }

    // Content area renders and no horizontal overflow breaks the layout.
    await expect(page.locator('main').first()).toBeVisible({ timeout: 30_000 });
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(viewport.width + 2);

    await context.close();
  });
}
