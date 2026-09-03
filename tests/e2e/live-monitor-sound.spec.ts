/**
 * LM-SOUND — Live Monitor sound toggle (real-browser E2E).
 *
 * Converted from the obsolete tests/sound-live-monitor-browser.test.ts, which
 * mixed Jest globals (beforeAll/describe/it/expect) with a raw `playwright`
 * import — it could not run under `tsx --test` or any configured runner. This
 * version uses the standard @playwright/test runner + the shared e2e fixtures
 * (tests/e2e/fixtures.ts) and the live-monitor page's real selectors.
 *
 * Run: npx playwright test tests/e2e/live-monitor-sound.spec.ts
 */
import { test, expect, navigate } from './fixtures';

test.describe('Live Monitor sound toggle', () => {
  test('sound assets are served', async ({ request }) => {
    for (const file of [
      '/sounds/notification.wav',
      '/sounds/critical.wav',
      '/sounds/warning.wav',
      '/sounds/info.wav',
    ]) {
      const res = await request.get(file);
      expect(res.status(), `${file} must be served`).toBe(200);
    }
  });

  test('Live Monitor page loads and exposes the sound toggle', async ({ admin }) => {
    await navigate(admin, 'Live Monitor');
    const toggle = admin.locator('button:has-text("Enable Sound")').first();
    await toggle.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(toggle).toBeVisible();
  });

  test('sound toggle transitions state, persists the preference, and produces no critical errors', async ({
    admin,
  }) => {
    const consoleErrors: string[] = [];
    admin.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    admin.on('pageerror', (err) => consoleErrors.push(`PAGE ERROR: ${err.message}`));

    await navigate(admin, 'Live Monitor');
    const toggle = admin.locator('button:has-text("Enable Sound")').first();
    await toggle.waitFor({ state: 'visible', timeout: 30_000 });

    // Enable → label switches to "Sound…"/"Sound" (audio may require an
    // autoplay-gate interaction first).
    await toggle.click();
    await admin.waitForTimeout(500);
    const labelOn = await admin
      .locator('button:has-text("Enable Sound"), button:has-text("Sound")')
      .first()
      .textContent();
    expect(labelOn).toMatch(/^Sound/);

    // Persisted preference reflects the user intent.
    const pref = await admin.evaluate(() => localStorage.getItem('omnisight-live-monitor-sound'));
    expect(pref).not.toBeNull();

    // Disable again → back to "Enable Sound".
    await admin
      .locator('button:has-text("Enable Sound"), button:has-text("Sound")')
      .first()
      .click();
    await admin.waitForTimeout(400);
    await expect(admin.locator('button:has-text("Enable Sound")').first()).toBeVisible();

    // No unhandled promises or page crashes (audio autoplay is expected to be
    // gated, but must never surface as a fatal error).
    const critical = consoleErrors.filter(
      (e) => e.includes('Unhandled Promise') || e.includes('PAGE ERROR')
    );
    expect(critical).toEqual([]);
  });
});