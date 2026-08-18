import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const env = readFileSync('.env', 'utf8');
const email = (env.match(/^SUPER_ADMIN_EMAIL=(.+)$/m) || [])[1]?.trim();
const password = (env.match(/^SUPER_ADMIN_PASSWORD=(.+)$/m) || [])[1]?.trim();

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const bad = new Set();
page.on('response', (res) => {
  if (res.status() === 404) bad.add(`${res.status()} ${res.url()}`);
});
page.on('requestfailed', (req) => bad.add(`FAILED ${req.url()} ${req.failure()?.errorText}`));

const login = await context.request.post('http://localhost:3000/api/auth/login', {
  headers: { 'x-forwarded-for': '10.0.0.99' },
  data: { email, password },
});
console.log('login:', login.status());

const PAGES = [
  ['dashboard', 'Dashboard'], ['employees', 'Employees'], ['departments', 'Departments'],
  ['devices', 'Devices'], ['activities', 'Activities'], ['screenshots', 'Screenshots'],
  ['break-status', 'Break Monitor'], ['live-monitor', 'Live Monitor'], ['analytics', 'Analytics'],
];

for (const [pageKey, label] of PAGES) {
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const menu = page.getByRole('button', { name: 'Open navigation menu' });
  if (await menu.count()) {
    await menu.first().click();
    await page.waitForTimeout(400);
  }
  const item = page.getByRole('button', { name: label, exact: true }).first();
  if (await item.count()) await item.click();
  await page.waitForTimeout(2500);
}

console.log('404s/FAILED per page visit (dashboard + 8 more):');
for (const b of bad) console.log('  ', b);
console.log(bad.size === 0 ? 'NO 404s across all pages' : `${bad.size} bad requests`);
await browser.close();
