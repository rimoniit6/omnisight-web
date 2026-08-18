// Browser E2E: Employee Portal Overview must render LIVE non-zero values.
// Regression for the P1 where the dashboard queryFn never unwrapped the
// { data } envelope → every Overview card rendered 0.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@worklens.ai';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
let dashboardApi = null;
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// Capture the dashboard API response as early as possible (before portal nav).
page.on('response', async (res) => {
  if (res.url().includes('/api/self/dashboard') && res.status() === 200 && !dashboardApi) {
    try { dashboardApi = await res.json(); } catch { /* ignore */ }
  }
});
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  // ── Login through the real form ──
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('form', { timeout: 20000 });
  await page.locator('input[type=email]').fill(ADMIN_EMAIL);
  await page.locator('input[type=password]').fill(ADMIN_PASSWORD);
  await page.locator('form button[type=submit]').first().click();
  await page.waitForSelector('nav, aside, [class*=sidebar]', { timeout: 30000 });
  await page.waitForTimeout(2500);

  // ── Dismiss onboarding tour (blocks pointer events) + persist flag ──
  await page.evaluate(() => {
    const overlays = [...document.querySelectorAll('.fixed.inset-0')];
    for (const o of overlays) {
      const btns = [...o.querySelectorAll('button')];
      const target = btns.find((b) => /skip/i.test(b.textContent || ''));
      if (target) { target.click(); return true; }
    }
    return false;
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));

  // ── Dismiss onboarding tour if present ──
  const skip = page.getByRole('button', { name: /skip tour/i });
  if (await skip.count()) await skip.click().catch(() => {});
  await page.waitForTimeout(800);

  // ── Navigate to Employee Portal via sidebar ──
  const portalNav = page.getByRole('button', { name: 'Employee Portal' }).first();
  await portalNav.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await portalNav.evaluate((el) => el.click());
  await page.waitForTimeout(3000);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  // Confirm we're on the portal
  const bodyText = await page.evaluate(() => document.body.innerText);
  record('portal page renders', /Employee Portal/i.test(bodyText) && /Manager view of a selected employee/i.test(bodyText));

  // ── Employee selector → ensure an employee is selected ──
  await page.waitForTimeout(2500);
  const selectorText = await page.evaluate(() => document.body.innerText);
  const hasEmployee = /Rimon Rana|Rimon/i.test(selectorText);
  record('employee auto-selected (Rimon Rana)', hasEmployee);

  // ── Wait for Overview cards to render with values ──
  await page.waitForTimeout(3000);
  const text = await page.evaluate(() => document.body.innerText);

  // Extract card values
  const todayHoursMatch = text.match(/(\d+(?:\.\d+)?)h\b/);
  const devicesMatch = text.match(/Devices\s*\n?\s*(\d+)\s*\/\s*(\d+)/);
  const consentMatch = text.match(/Consent Status\s*\n?\s*(\d+)\s*\/\s*(\d+)/);
  const weeklyMatch = text.match(/Weekly Productivity\s*\n?\s*(\d+)%/);

  const todayHours = todayHoursMatch ? parseFloat(todayHoursMatch[1]) : 0;
  const devices = devicesMatch ? `${devicesMatch[1]}/${devicesMatch[2]}` : 'none';
  const consent = consentMatch ? `${consentMatch[1]}/${consentMatch[2]}` : 'none';
  const weekly = weeklyMatch ? parseInt(weeklyMatch[1], 10) : null;

  record('Today Hours is non-zero', todayHours > 0, `rendered ${todayHours}h`);
  record('Devices non-zero', devices !== 'none' && devices !== '0/0', `rendered ${devices}`);
  record('Consents non-zero', consent !== 'none' && consent !== '0/0', `rendered ${consent}`);
  record('Weekly Productivity non-zero', weekly !== null && weekly > 0, `rendered ${weekly}%`);

  // Cross-check against API
  if (dashboardApi?.data) {
    const api = dashboardApi.data;
    const apiHours = api.todayHours / 3600;
    record('UI hours match API', Math.abs(todayHours - apiHours) < 0.5,
      `UI ${todayHours}h vs API ${apiHours.toFixed(2)}h (${api.todayHours}s)`);
    record('UI devices match API', devices === `${api.deviceOnline}/${api.deviceTotal}`,
      `UI ${devices} vs API ${api.deviceOnline}/${api.deviceTotal}`);
    record('UI consents match API', consent === `${api.consentGranted}/${api.consentTotal}`,
      `UI ${consent} vs API ${api.consentGranted}/${api.consentTotal}`);
  } else {
    record('API dashboard captured for cross-check', false, 'no /api/self/dashboard 200 response seen');
  }

  // Activity Breakdown percentages present
  record('Activity Breakdown renders', /Productive \d+%/.test(text) && /Neutral \d+%/.test(text));

  // No console errors — filter pre-login boot probes (auth/me + presence 401s
  // before the session cookie exists) and favicon/abort noise.
  const realErrors = consoleErrors.filter((e) => !/favicon|net::ERR_ABORTED|401/.test(e));
  record('no console/page errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  await page.screenshot({ path: '/tmp/portal-overview.png', fullPage: true });
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length > 0) {
  console.log('FAILED:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
