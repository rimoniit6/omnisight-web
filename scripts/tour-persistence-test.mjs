// Tour persistence test: dismiss the tour, reload, and check it never re-shows.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.AUDIT_BASE || 'http://localhost:3000';
const EMAIL = process.env.AUDIT_EMAIL || 'admin@worklens.ai';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envSrc = fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '';
const PASSWORD = process.env.AUDIT_PASSWORD || envSrc.match(/SUPER_ADMIN_PASSWORD=([^\r\n]+)/)?.[1]?.trim() || '';

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const tourShown = () => page.evaluate(() => {
  const t = [...document.querySelectorAll('.fixed.inset-0.z-\\[100\\]')];
  return t.length > 0 && !!document.body.innerText.match(/Welcome to OmniSight/);
});

const login = async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('form', { timeout: 20000 });
  await page.locator('input[type=email]').fill(EMAIL);
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.locator('form button[type=submit]').first().click();
  await page.waitForSelector('nav, aside, [class*=sidebar]', { timeout: 30000 });
  await page.waitForTimeout(3000);
};

// ── 1. Fresh session: tour shows ──
await login();
console.log('[1] tour shows on fresh session:', await tourShown());

// ── 2. Dismiss via real Skip control ──
const skip = page.getByText('Skip tour', { exact: true }).first();
if ((await skip.count()) > 0) {
  await skip.click();
  await page.waitForTimeout(1000);
}
console.log('[2] tour dismissed:', !(await tourShown()));
const ls = await page.evaluate(() => localStorage.getItem('worklens-tour-completed'));
console.log('[3] localStorage worklens-tour-completed =', JSON.stringify(ls));

// ── 3. Hard reload in the SAME browser context ──
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
console.log('[4] tour after reload (same context):', await tourShown());

// ── 4. Fresh page load in the same context ──
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
console.log('[5] tour after fresh goto (same context):', await tourShown());

await browser.close();
process.exit(0);
