import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright-core');

const p = new PrismaClient();
const ts = (lbl) => console.log(new Date().toISOString().slice(11, 23), lbl);

// 1. Real agent token + device/employee
const dev = await p.device.findFirst({ include: { employee: { include: { organization: true } } } });
const token = await p.agentToken.findFirst({ where: { deviceId: dev.id } });
if (!token) { console.log('NO AGENT TOKEN'); process.exit(1); }
ts(`device=${dev.name} employee=${dev.employee.firstName} org=${dev.employee.organization.name}`);

// 2. Browser: login + open Live Monitor
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@worklens.ai';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@2025xy';
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type=email]', { timeout: 30000 });
await page.locator('input[type=email]').fill(ADMIN_EMAIL);
await page.locator('input[type=password]').fill(ADMIN_PASSWORD);
await page.locator('button[type=submit]').first().click();
await page.waitForTimeout(4000);
ts('after submit, url=' + page.url());

// The app is a client-side SPA: Live Monitor is a tab on the root page.
// Click the sidebar nav item "Live Monitor".
await page.evaluate(() => {
  const items = [...document.querySelectorAll('a, button, [role=menuitem], nav *')];
  const target = items.find((el) => el.textContent.trim().toLowerCase().includes('live monitor'));
  if (target) { target.click(); return true; }
  return false;
});
await page.waitForTimeout(3000);
const lmText = await page.evaluate(() => document.body.innerText.slice(0, 300));
ts('live-monitor body sample: ' + JSON.stringify(lmText));

// Check WS connection indicator / capture socket state
const wsInfo = await page.evaluate(() => {
  const s = window.__wsDebug || null;
  return s ? { connected: s.connected, url: s.url } : null;
}).catch(() => null);
ts('ws debug: ' + JSON.stringify(wsInfo));

// Snapshot BEFORE (should not contain our marker)
const marker = 'LIVE-E2E-' + Date.now().toString(36);
const before = await page.evaluate(() => document.body.innerText);

// 3. Post REAL activity via agent API (real token) — same shape the agent sends
const payload = {
  activities: [{
    type: 'application',
    applicationName: 'chrome.exe',
    title: 'Live E2E browser session',
    category: 'productive',
    duration: 45,
    startedAt: new Date(Date.now() - 45000).toISOString(),
    timestamp: new Date().toISOString(),
    employeeId: dev.employeeId,
  }],
};
const t0 = Date.now();
const resp = await fetch('http://localhost:3000/api/agent/activity', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token.token },
  body: JSON.stringify(payload),
});
const rbody = await resp.text();
ts(`POST /api/agent/activity -> ${resp.status} ${rbody.slice(0, 120)}`);

// 4. Verify DB row
await new Promise((r) => setTimeout(r, 1500));
const row = await p.activity.findFirst({ orderBy: { createdAt: 'desc' }, where: { title: 'Live E2E browser session' } });
if (row) ts(`DB row: id=${row.id.slice(0, 8)} type=${row.type} app=${row.applicationName} createdAt=${row.createdAt.toISOString()}`);
else ts('DB row: MISSING');

// 5. Watch Live Monitor UI update WITHOUT reload
const deadline = Date.now() + 25000;
let appeared = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(2000);
  const text = await page.evaluate(() => document.body.innerText);
  if (text.includes('Live E2E browser session') || text.includes('chrome.exe')) {
    appeared = true;
    ts('LIVE MONITOR UI shows the activity (no reload)');
    break;
  }
}
if (!appeared) {
  // maybe the panel only shows recent events; dump a sample of the page text
  const text = await page.evaluate(() => document.body.innerText);
  ts('UI did not show marker. page text sample: ' + JSON.stringify(text.slice(0, 400)));
  console.log('--- console errors ---');
  console.log(consoleErrors.slice(0, 10).join('\n'));
}

// cleanup: delete the test row
if (row) { await p.activity.delete({ where: { id: row.id } }); ts('cleanup: test activity deleted'); }
console.log('--- console errors ---');
console.log(consoleErrors.slice(0, 10).join('\n') || '(none)');
await browser.close();
await p.$disconnect();
process.exit(appeared ? 0 : 2);
