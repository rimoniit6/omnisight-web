// Probe: identify the full-screen overlay on the Projects page.
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
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message.slice(0, 200)));

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('form', { timeout: 20000 });
await page.locator('input[type=email]').fill(EMAIL);
await page.locator('input[type=password]').fill(PASSWORD);
await page.locator('form button[type=submit]').first().click();
await page.waitForSelector('nav, aside, [class*=sidebar]', { timeout: 30000 });
await page.waitForTimeout(2500);

await page.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));
await page.waitForTimeout(800);

const nav = page.getByRole('button', { name: /^Projects$/ }).first();
await nav.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(400);
await nav.evaluate((el) => el.click());
await page.waitForTimeout(3500);

// Enumerate every fixed overlay on the page
const overlays = await page.evaluate(() => {
  const all = [...document.querySelectorAll('div.fixed.inset-0, [class*="fixed"][class*="inset-0"]')];
  return all.map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const txt = (el.textContent || '').replace(/\s+/g, ' ').slice(0, 160);
    return {
      cls: (el.className || '').toString().slice(0, 120),
      role: el.getAttribute('role'),
      state: el.getAttribute('data-state') || el.getAttribute('data-radix'),
      w: Math.round(r.width), h: Math.round(r.height),
      z: cs.zIndex,
      pointer: cs.pointerEvents,
      bg: cs.backgroundColor,
      visible: r.width > 0 && r.height > 0,
      text: txt,
    };
  }).filter((o) => o.visible && o.w >= 300 && o.h >= 300);
});
console.log('=== fixed overlays ===');
for (const o of overlays) console.log(JSON.stringify(o));
console.log('count:', overlays.length);

// Can we close it with Escape?
const before = await page.locator('body').innerText();
await page.keyboard.press('Escape');
await page.waitForTimeout(1000);
const after = await page.locator('body').innerText();
console.log('=== after Escape: overlay count ===');
const overlays2 = await page.evaluate(() => {
  const all = [...document.querySelectorAll('div.fixed.inset-0, [class*="fixed"][class*="inset-0"]')];
  return all.filter((el) => { const r = el.getBoundingClientRect(); return r.width >= 300 && r.height >= 300; }).length;
});
console.log('remaining large overlays after Escape:', overlays2);
console.log('body text changed by Escape:', before !== after);

console.log('=== console errors ===');
console.log(consoleErrors.slice(0, 6).join('\n') || '(none)');
await browser.close();
process.exit(0);
