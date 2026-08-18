// Employee Location tab browser E2E — drives real Chrome against the running
// dev server + real DB. Verifies: login, sidebar -> Employees -> View ->
// Employee Details -> Location tab, LocationPanel renders, the admin location
// API responds with the right shape, no console errors, no failed requests.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const BASE = process.env.LOCATION_BASE || 'http://localhost:3000';
const EMAIL = process.env.LOCATION_EMAIL || 'admin@worklens.ai';
// Load the real password from the repo .env (same pattern as live-monitor-ui-test.mjs)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envSrc = fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '';
const envPassword = envSrc.match(/SUPER_ADMIN_PASSWORD=([^\r\n]+)/)?.[1]?.trim();
const PASSWORD = process.env.LOCATION_PASSWORD || envPassword || '';

const results = [];
const consoleErrors = [];
const failedRequests = [];
const apiResponses = [];

function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
console.log('browser launched');

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', async (r) => {
  if (r.url().includes('/api/employees/') && r.url().includes('/location')) {
    let body = null;
    try { body = await r.json(); } catch { /* ignore */ }
    apiResponses.push({ url: r.url(), status: r.status(), body });
  }
});

// ── 1. Login ───────────────────────────────────────────────────────────────
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('form', { timeout: 20000 });
await page.locator('input[type=email]').fill(EMAIL);
await page.locator('input[type=password]').fill(PASSWORD);
await page.locator('form button[type=submit]').first().click();
await page.waitForSelector('nav, aside, [class*=sidebar]', { timeout: 30000 });
await page.waitForTimeout(2500);
record('login -> app shell', page.url().includes('localhost:3000'), page.url());

// ── 1b. Dismiss onboarding tour overlay (blocks pointer events) ────────────
await page.evaluate(() => {
  const overlays = [...document.querySelectorAll('.fixed.inset-0')];
  for (const o of overlays) {
    const btns = [...o.querySelectorAll('button')];
    const target = btns.find((b) => /skip/i.test(b.textContent || ''));
    if (target) { target.click(); return true; }
  }
  return false;
});
await page.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));
await page.waitForTimeout(1200);
// Belt-and-braces: remove any lingering pointer-blocking overlay.
await page.evaluate(() => {
  const overlays = [...document.querySelectorAll('.fixed.inset-0')];
  for (const o of overlays) { if (o.getAttribute('data-radix') === null) o.remove(); }
});
await page.waitForTimeout(500);

// ── 2. Sidebar -> Employees ────────────────────────────────────────────────
const employeesNav = page.getByRole('button', { name: /^Employees$/ }).first();
await employeesNav.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(400);
await employeesNav.evaluate((el) => el.click());
await page.waitForTimeout(3500);
const listText = await page.locator('body').innerText();
record('employees list renders', /Add Employee|Employee List|Employees/.test(listText), listText.slice(0, 120).replace(/\s+/g, ' '));

// ── 3. Click the first employee row (the row opens details) ────────────────
const firstRow = page.locator('[role=grid] tbody tr, tbody tr').first();
const hasRow = await firstRow.count();
record('employee row present', hasRow > 0);
if (hasRow > 0) {
  await firstRow.evaluate((el) => el.click());
  await page.waitForTimeout(3500);
  const detailsText = await page.locator('body').innerText();
  record('employee details opened', /Employee Details|Overview|Productivity/i.test(detailsText), detailsText.slice(0, 120).replace(/\s+/g, ' '));

  // ── 4. Location tab ───────────────────────────────────────────────────────
  // Wait until the details tab bar has rendered (it loads after employee data).
  await page.waitForSelector('[role=tab]', { timeout: 15000 }).catch(() => {});
  const tabList = await page.evaluate(() => [...document.querySelectorAll('[role=tab]')].map((t) => (t.textContent || '').trim()));
  record('Location tab present', tabList.includes('Location'), tabList.join(','));
  if (tabList.includes('Location')) {
    const tab = page.getByRole('tab', { name: 'Location', exact: true }).first();
    await tab.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    await tab.click({ timeout: 15000 });
    await page.waitForTimeout(3500);
    const bodyText = await page.evaluate(() => document.body.innerText);
    record(
      'Location panel content present',
      /Latest Location|No location fixes|Location History|Accuracy/.test(bodyText),
      bodyText.slice(0, 220).replace(/\s+/g, ' ').slice(0, 160)
    );
  }

  // ── 5. Location API checks ────────────────────────────────────────────────
  record('location API responded', apiResponses.length > 0, `${apiResponses.length} calls`);
  if (apiResponses.length > 0) {
    const last = apiResponses[apiResponses.length - 1];
    record('location API status 200', last.status === 200, `status=${last.status}`);
    const b = last.body;
    record(
      'location API shape { latest, history, total }',
      b && 'latest' in b && 'history' in b && 'total' in b,
      b ? JSON.stringify({ latest: b.latest, historyLen: b.history?.length, total: b.total }) : 'no body'
    );
  }
}

// ── 6. Console/request hygiene ─────────────────────────────────────────────
const realConsoleErrors = consoleErrors.filter((e) => !/favicon|ERR_ABORTED|401 \(Unauthorized\)/.test(e));
record('no console errors', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 3).join(' | '));
const realFailed = failedRequests.filter((u) => !/favicon|sockjs|websocket/.test(u));
record('no failed requests', realFailed.length === 0, realFailed.slice(0, 3).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('FAILED:', failed.map((f) => f.name).join(', '));
  process.exit(1);
}
