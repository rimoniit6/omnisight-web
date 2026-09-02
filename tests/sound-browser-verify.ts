/**
 * LM-SOUND — Standalone browser verification script.
 *
 * Run: npx tsx tests/sound-browser-verify.ts
 *
 * Tests:
 * 1. Sound files are accessible via HTTP
 * 2. Live Monitor page loads (with auth)
 * 3. Sound toggle button exists
 * 4. Sound preference persists in localStorage
 * 5. No console audio errors
 */

import { chromium } from 'playwright';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function main() {
  console.log('=== LM-SOUND Browser Verification ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // ─── Test 1: Sound files accessible ───
  console.log('Test 1: Sound files accessible via HTTP');
  const soundFiles = [
    '/sounds/notification.wav',
    '/sounds/critical.wav',
    '/sounds/warning.wav',
    '/sounds/info.wav',
  ];

  for (const file of soundFiles) {
    try {
      const response = await page.request.get(`${BASE_URL}${file}`);
      const status = response.status();
      const size = (await response.body()).length;
      console.log(`  ${file}: ${status} (${size} bytes) ${status === 200 ? '✅' : '❌'}`);
    } catch (err) {
      console.log(`  ${file}: FAILED ❌`);
    }
  }

  // ─── Test 2: Navigate to app ───
  console.log('\nTest 2: Navigate to app');
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  const url = page.url();
  console.log(`  Current URL: ${url}`);

  // Check if redirected to login
  const isLoginPage = url.includes('login') || url.includes('auth');
  console.log(`  Login page: ${isLoginPage}`);

  await page.screenshot({ path: 'screenshots/sound-verify-1.png' });

  // ─── Test 3: Check for login form ───
  if (isLoginPage) {
    console.log('\nTest 3: Login form detected');
    const emailInput = await page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
    const hasEmailInput = await emailInput.isVisible().catch(() => false);
    console.log(`  Email input visible: ${hasEmailInput}`);

    if (hasEmailInput) {
      // Try to find any credentials in env or config
      console.log('  NOTE: Login required. Attempting with default credentials...');

      // Look for password input
      const passwordInput = await page.locator('input[type="password"]').first();
      const hasPasswordInput = await passwordInput.isVisible().catch(() => false);
      console.log(`  Password input visible: ${hasPasswordInput}`);

      if (hasPasswordInput) {
        // Try common test credentials
        const testEmail = process.env.TEST_EMAIL || 'admin@omnisight.local';
        const testPassword = process.env.TEST_PASSWORD || 'admin123';

        await emailInput.fill(testEmail);
        await passwordInput.fill(testPassword);

        // Find and click submit button
        const submitBtn = await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login")').first();
        if (await submitBtn.isVisible().catch(() => false)) {
          await submitBtn.click();
          await page.waitForTimeout(3000);
          console.log(`  After login URL: ${page.url()}`);
          await page.screenshot({ path: 'screenshots/sound-verify-2.png' });
        }
      }
    }
  }

  // ─── Test 4: Navigate to Live Monitor ───
  console.log('\nTest 4: Navigate to Live Monitor');
  await page.goto(`${BASE_URL}/dashboard/live-monitor`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  await page.screenshot({ path: 'screenshots/sound-verify-3.png' });
  console.log(`  URL: ${page.url()}`);

  // Check for Live Monitor heading
  const heading = await page.locator('text=Live Monitor').first();
  const hasHeading = await heading.isVisible().catch(() => false);
  console.log(`  Live Monitor heading: ${hasHeading ? '✅' : '❌'}`);

  // ─── Test 5: Sound toggle button ───
  console.log('\nTest 5: Sound toggle button');
  const soundButton = await page.locator('button:has-text("Enable Sound"), button:has-text("Sound")').first();
  const hasSoundButton = await soundButton.isVisible().catch(() => false);
  console.log(`  Sound button visible: ${hasSoundButton ? '✅' : '❌'}`);

  if (hasSoundButton) {
    const buttonText = await soundButton.textContent();
    console.log(`  Button text: "${buttonText}"`);

    // Click to enable sound
    console.log('  Clicking Enable Sound...');
    await soundButton.click();
    await page.waitForTimeout(500);

    await page.screenshot({ path: 'screenshots/sound-verify-4.png' });

    // Check button text changed
    const newText = await soundButton.textContent().catch(() => 'not found');
    console.log(`  After click text: "${newText}"`);

    // Check localStorage
    const soundPref = await page.evaluate(() => {
      return localStorage.getItem('omnisight-live-monitor-sound');
    });
    console.log(`  localStorage sound: ${soundPref}`);

    // Toggle off
    console.log('  Toggling off...');
    await soundButton.click();
    await page.waitForTimeout(300);

    const offText = await soundButton.textContent().catch(() => 'not found');
    console.log(`  After toggle off: "${offText}"`);

    const soundPrefOff = await page.evaluate(() => {
      return localStorage.getItem('omnisight-live-monitor-sound');
    });
    console.log(`  localStorage sound: ${soundPrefOff}`);
  }

  // ─── Test 6: Console errors ───
  console.log('\nTest 6: Console errors');
  const audioErrors = consoleErrors.filter(
    (e) =>
      e.includes('NotAllowedError') ||
      e.includes('play() failed') ||
      e.includes('AudioContext') ||
      e.includes('Unhandled Promise') ||
      e.includes('audio')
  );

  console.log(`  Total console errors: ${consoleErrors.length}`);
  console.log(`  Audio-related errors: ${audioErrors.length}`);
  if (audioErrors.length > 0) {
    audioErrors.forEach((e) => console.log(`    - ${e}`));
  }

  // ─── Test 7: Check for LIVE badge ───
  console.log('\nTest 7: LIVE badge');
  const liveBadge = await page.locator('text=LIVE').first();
  const hasLiveBadge = await liveBadge.isVisible().catch(() => false);
  console.log(`  LIVE badge visible: ${hasLiveBadge ? '✅' : '❌'}`);

  // ─── Test 8: Check for event stream container ───
  console.log('\nTest 8: Event stream container');
  const eventStream = await page.locator('text=Live Event Stream').first();
  const hasEventStream = await eventStream.isVisible().catch(() => false);
  console.log(`  Event Stream header: ${hasEventStream ? '✅' : '❌'}`);

  // ─── Summary ───
  console.log('\n=== Summary ===');
  console.log(`Sound files: ${soundFiles.length} checked`);
  console.log(`Console errors: ${consoleErrors.length}`);
  console.log(`Audio errors: ${audioErrors.length}`);
  console.log(`Sound button found: ${hasSoundButton ? 'YES' : 'NO'}`);

  await browser.close();
  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
