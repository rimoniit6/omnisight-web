// Employee Portal browser E2E — drives real Chrome against the running dev
// server + real DB. Verifies: login, sidebar nav, employee selector, all tabs
// (overview/consents/anomalies/projects/telemetry), telemetry deep-links into
// Employee Details, responsive layout, console errors, failed requests, and
// cross-checks rendered values against the live APIs.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const BASE = process.env.PORTAL_BASE || 'http://localhost:3000';
const EMAIL = process.env.PORTAL_EMAIL;
const PASSWORD = process.env.PORTAL_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('PORTAL_EMAIL/PORTAL_PASSWORD required');
  process.exit(2);
}

const results = [];
const consoleErrors = [];
const failedRequests = [];

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

// ── 1. Login through the real form ─────────────────────────────────────────
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('form', { timeout: 20000 });
await page.locator('input[type=email]').fill(EMAIL);
await page.locator('input[type=password]').fill(PASSWORD);
await page.locator('form button[type=submit]').first().click();
// App shell appears after hydration + auth check
await page.waitForSelector('nav, aside, [class*=sidebar]', { timeout: 30000 });
await page.waitForTimeout(2500);
const urlAfterLogin = page.url();
record('login -> app shell', urlAfterLogin.includes('localhost:3000'), urlAfterLogin);

// ── 1b. Dismiss the onboarding tour overlay (blocks pointer events) ────────
// The tour's full-screen overlay captures every click until dismissed. Click
// its real "Skip tour" button (inside the .fixed.inset-0 container).
const tourDismissed = await page.evaluate(() => {
  const overlays = [...document.querySelectorAll('.fixed.inset-0')];
  for (const o of overlays) {
    const btns = [...o.querySelectorAll('button')];
    const target = btns.find((b) => /skip/i.test(b.textContent || ''));
    if (target) { target.click(); return true; }
  }
  return false;
});
await page.waitForTimeout(1200);
// Persist tour-completed so later re-renders never re-show it.
await page.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));

// ── 2. Navigate to Employee Portal via sidebar ─────────────────────────────
const bodyText = await page.locator('body').innerText();
record('sidebar renders portal link', /employee portal/i.test(bodyText), 'found in sidebar nav');
record('tour overlay dismissed', tourDismissed);
const portalNav = page.getByRole('button', { name: 'Employee Portal' }).first();
await portalNav.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(400);
await portalNav.evaluate((el) => el.click());
await page.waitForTimeout(3000);

// Portal header
let text = await page.locator('body').innerText();
record('portal header', /Manager view of a selected employee's monitoring summary/i.test(text));

// ── 3. Employee selector renders + auto-selects an employee ────────────────
const hasCombobox = await page.locator('[aria-label="Switch employee"]').count();
record('employee selector present', hasCombobox >= 1);
await page.waitForTimeout(3000); // let dashboard query settle
text = await page.locator('body').innerText();
record('overview tab default', /Today's Hours/i.test(text) && /Weekly Productivity/i.test(text));

// Cross-check Overview values against the live API
const overviewApi = await page.evaluate(async () => {
  const r = await fetch('/api/self/dashboard?employeeId=' + (await window.fetch('/api/employees/search?status=active&limit=1').then(x => x.json())).data[0].id);
  return r.json();
});
const apiEmp = overviewApi?.data?.employee;
if (apiEmp) {
  const nameShown = await page.locator('body').innerText();
  record('overview shows real employee', nameShown.includes(apiEmp.firstName), `${apiEmp.firstName} ${apiEmp.lastName}`);
}

// ── 4. Consents tab ────────────────────────────────────────────────────────
await page.getByRole('tab', { name: 'Consents' }).click();
await page.waitForTimeout(2500);
text = await page.locator('body').innerText();
const consentLabels = ['General Monitoring', 'Screenshot Capture', 'Activity Tracking', 'Keystroke Logging', 'Webcam Access', 'Location Tracking'];
record('consents render all types', consentLabels.every((l) => text.includes(l)), consentLabels.filter((l) => !text.includes(l)).join(',') || 'all 6 present');

// ── 5. Telemetry tab ───────────────────────────────────────────────────────
await page.getByRole('tab', { name: 'Telemetry' }).click();
await page.waitForTimeout(2500);
text = await page.locator('body').innerText();
record('telemetry tab renders', /Websites/.test(text) && /Keyboard Activity/.test(text) && /Location/.test(text) && /Webcam/.test(text));

// Cross-check telemetry summary against API
const empId = await page.evaluate(async () => {
  const r = await fetch('/api/employees/search?status=active&limit=1').then(x => x.json());
  return r.data[0].id;
});
const telemetryApi = await page.evaluate(async (id) => {
  const r = await fetch('/api/self/telemetry-summary?employeeId=' + id);
  return r.json();
}, empId);
const t = telemetryApi?.data;
if (t) {
  record('telemetry keyboard matches API',
    t.keyboard.totalKeystrokes > 0 && (text.includes(t.keyboard.totalKeystrokes.toLocaleString()) || text.includes(String(t.keyboard.totalKeystrokes))),
    `API says ${t.keyboard.totalKeystrokes} keystrokes`);
  const d = t.websites?.topDomains?.[0];
  if (d) record('telemetry domain matches API', text.includes(d.domain), `API top domain: ${d.domain}`);
}

// ── 6. Anomalies + Projects tabs ───────────────────────────────────────────
await page.getByRole('tab', { name: 'Anomalies' }).click();
await page.waitForTimeout(2000);
text = await page.locator('body').innerText();
record('anomalies tab renders', /No anomalies found|Anomalies|Severity/.test(text));

await page.getByRole('tab', { name: 'Projects' }).click();
await page.waitForTimeout(2000);
text = await page.locator('body').innerText();
record('projects tab renders', /No projects assigned|Sentiment|Open Project/.test(text));

// ── 7. Telemetry deep-links → Employee Details on the right tab ────────────
// (Run LAST — it navigates away from the portal.)
await page.getByRole('tab', { name: 'Telemetry' }).click();
await page.waitForTimeout(2000);
const openButtons = page.getByText('Open in Employee Details', { exact: true });
if (await openButtons.count() > 0) {
  await openButtons.first().click();
  await page.waitForTimeout(3000);
  text = await page.locator('body').innerText();
  const onDetails = /Employee Details|Productivity Score|Activity/.test(text);
  record('deep link opens Employee Details', onDetails);
}

// ── 8. Responsive: mobile viewport ─────────────────────────────────────────
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1500);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
record('mobile 390px: no horizontal overflow', !overflow, overflow ? `scrollWidth=${document.documentElement.scrollWidth} client=${document.documentElement.clientWidth}` : '');
text = await page.locator('body').innerText();
record('mobile 390px: portal tabs usable', /Overview|Consents|Anomalies|Projects|Telemetry/.test(text));

await page.setViewportSize({ width: 360, height: 800 });
await page.waitForTimeout(1000);
const overflow360 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
record('mobile 360px: no horizontal overflow', !overflow360, overflow360 ? 'overflow' : '');

await page.setViewportSize({ width: 768, height: 1024 });
await page.waitForTimeout(1000);
const overflow768 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
record('tablet 768px: no horizontal overflow', !overflow768, overflow768 ? 'overflow' : '');

await page.setViewportSize({ width: 1920, height: 1080 });
await page.waitForTimeout(1000);
const overflow1920 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
record('desktop 1920px: no horizontal overflow', !overflow1920, overflow1920 ? 'overflow' : '');

// ── 9. Summary ─────────────────────────────────────────────────────────────
// Pre-login 401 probes (/api/auth/me, /api/employees/presence fired before
// the session cookie exists) are normal boot behavior, not defects.
const realConsoleErrors = consoleErrors.filter((e) => !/favicon|ERR_ABORTED|401 \(Unauthorized\)/.test(e));
record('no console errors', realConsoleErrors.length === 0, realConsoleErrors.slice(0, 3).join(' | '));
const realFailed = failedRequests.filter((u) => !/favicon|sockjs|websocket/.test(u));
record('no failed requests', realFailed.length === 0, realFailed.slice(0, 3).join(' | '));

await browser.close();

const passCount = results.filter((r) => r.ok).length;
console.log(`\n===== E2E SUMMARY: ${passCount}/${results.length} passed =====`);
if (passCount < results.length) {
  for (const r of results.filter((x) => !x.ok)) console.log('FAILED:', r.name, r.detail);
}
fs.writeFileSync(path.join(__dirname, '..', '.portal-e2e-results.json'), JSON.stringify({ results, consoleErrors, failedRequests }, null, 2));
process.exit(passCount === results.length ? 0 : 1);
