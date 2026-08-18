import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
const env = readFileSync('.env', 'utf8');
const ADMIN_EMAIL = env.match(/SUPER_ADMIN_EMAIL=(.*)/)[1].trim();
const ADMIN_PASSWORD = env.match(/SUPER_ADMIN_PASSWORD=(.*)/)[1].trim();
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('form', { timeout: 20000 });
await page.locator('input[type=email]').fill(ADMIN_EMAIL);
await page.locator('input[type=password]').fill(ADMIN_PASSWORD);
await page.locator('form button[type=submit]').first().click();
await page.waitForSelector('nav, aside, [class*=sidebar]', { timeout: 30000 });
await page.waitForTimeout(1500);
// Dismiss tour if present
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  const t = btns.find((b) => /skip/i.test(b.textContent || ''));
  if (t) { t.click(); return true; }
  return false;
});
await page.waitForTimeout(1000);
// Open Live Monitor
const lm = page.getByRole('button', { name: /live monitor/i }).first();
if (await lm.count()) { await lm.click(); await page.waitForTimeout(3000); } else {
  await page.goto('http://localhost:3000/live-monitor', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3000);
}
// Insert a real activity while the Live Monitor is open
const p = new PrismaClient();
const tok = await p.agentToken.findFirst({ where: { employeeId: 'cmssi3spk000cfi5k8uzi0i0v' } });
const marker = 'live-monitor-ui-' + Date.now();
const res = await fetch('http://localhost:3000/api/agent/activity', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + tok.token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ activities: [{ type: 'application', applicationName: 'Visual Studio Code', title: marker, category: 'productive', duration: 30, timestamp: new Date().toISOString() }] }),
});
console.log('activity POST:', res.status);
// Wait for the event to flow through WS → eventLog → UI
await page.waitForTimeout(8000);
const body = await page.evaluate(() => document.body.innerText);
const found = body.includes(marker);
const wsState = await page.evaluate(() => {
  const el = [...document.querySelectorAll('span')].find(e => /Connected|Disconnected/.test(e.textContent || ''));
  return el ? el.textContent.trim() : null;
});
console.log('marker rendered in Live Monitor UI:', found);
console.log('WS connection indicator:', wsState);
// cleanup
await p.activity.deleteMany({ where: { title: marker } });
await p.$disconnect();
await browser.close();
process.exit(found ? 0 : 1);
