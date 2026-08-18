// Active Tracking Project — UI visibility audit (Phase 2/9), v2.
// Real Chrome, real login, real project "ok", real employee Rimon.
// Dismisses the onboarding tour via its REAL Skip control (never mutates DOM),
// then reports exactly what renders in the Team tab member rows.
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
const apiResponses = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message.slice(0, 300)));
page.on('response', (r) => {
  if (r.url().includes('/members')) apiResponses.push(`${r.request().method()} ${r.status()} ${r.url()}`);
});

const log = (lbl, v) => console.log(`[${lbl}] ${v}`);

// Fresh profile so the tour is guaranteed to show (like a first-time user).
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('form', { timeout: 20000 });
await page.locator('input[type=email]').fill(EMAIL);
await page.locator('input[type=password]').fill(PASSWORD);
await page.locator('form button[type=submit]').first().click();
await page.waitForSelector('nav, aside, [class*=sidebar]', { timeout: 30000 });
await page.waitForTimeout(3000);
log('login', page.url());

// Does the tour overlay appear for a fresh user?
let tourVisible = await page.evaluate(() => {
  const t = [...document.querySelectorAll('.fixed.inset-0.z-\\[100\\]')];
  return t.length > 0 && !!document.body.innerText.match(/Welcome to OmniSight/);
});
log('A. onboarding tour overlay visible for fresh user', String(tourVisible));

if (tourVisible) {
  // Dismiss via the REAL Skip control.
  const skip = page.getByText('Skip tour', { exact: true }).first();
  const skipCount = await skip.count();
  log('B. real "Skip tour" control present', String(skipCount > 0));
  if (skipCount > 0) {
    await skip.click();
    await page.waitForTimeout(1000);
  } else {
    // fall back to the X (aria-label "Close tour")
    const x = page.getByRole('button', { name: 'Close tour' }).first();
    if ((await x.count()) > 0) { await x.click(); await page.waitForTimeout(1000); }
  }
  tourVisible = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.fixed.inset-0.z-\\[100\\]')];
    return t.length > 0 && !!document.body.innerText.match(/Welcome to OmniSight/);
  });
  log('C. tour dismissed after Skip', String(!tourVisible));
  // Persist so it never re-shows (store reads at init; this helps future loads)
  await page.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));
}

// Navigate to Projects
const nav = page.getByRole('button', { name: /^Projects$/ }).first();
await nav.scrollIntoViewIfNeeded().catch(() => {});
await page.waitForTimeout(400);
await nav.evaluate((el) => el.click());
await page.waitForTimeout(3500);
let bodyText = await page.locator('body').innerText();
log('D. projects page renders', /Project Tracking/.test(bodyText));

// Open project "ok"
const okCard = page.locator('text=ok').first();
await okCard.click();
await page.waitForTimeout(2500);
bodyText = await page.locator('body').innerText();
log('E. project detail opens', /Overview|Time Log|Team/.test(bodyText));

// Team tab
await page.getByRole('tab', { name: 'Team' }).first().click();
await page.waitForTimeout(1500);
bodyText = await page.locator('body').innerText();
log('F. Team tab renders (Project Members)', /Project Members/.test(bodyText));
log('G. Rimon visible', /Rimon Rana/.test(bodyText));

const setButtons = await page.getByRole('button', { name: /Set .* active tracking project/ }).count();
const clearButtons = await page.getByRole('button', { name: /Clear .* active tracking project/ }).count();
const activeText = await page.getByText('Active Tracking Project').count();
const assignedText = await page.getByText('Assigned').count();
log('H. "Set as Active" buttons', String(setButtons));
log('I. "Clear Active" buttons', String(clearButtons));
log('J. "Active Tracking Project" text', String(activeText));
log('K. "Assigned" text', String(assignedText));

// Per-row button detail
const rows = page.locator('div.flex.flex-wrap.items-center.gap-3');
const rc = await rows.count();
log('L. member rows found', String(rc));
if (rc > 0) {
  const detail = await rows.first().evaluate((el) => {
    const btns = [...el.querySelectorAll('button')];
    return {
      rowText: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220),
      buttons: btns.map((b) => {
        const r = b.getBoundingClientRect();
        return {
          text: (b.textContent || '').trim().slice(0, 30),
          aria: b.getAttribute('aria-label') || '',
          w: Math.round(r.width), h: Math.round(r.height),
          visible: r.width > 0 && r.height > 0,
        };
      }),
    };
  });
  console.log('[row detail] ' + JSON.stringify(detail, null, 1));
  fs.writeFileSync('active-project-audit-row.html', await rows.first().evaluate((el) => el.outerHTML));
}

await page.screenshot({ path: 'active-project-audit-desktop.png' });

// Mobile viewport
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1500);
const mobileSet = await page.getByRole('button', { name: /Set .* active tracking project/ }).count();
const mobileActive = await page.getByText('Active Tracking Project').count();
log('M. mobile: "Set as Active" buttons', String(mobileSet));
log('N. mobile: "Active Tracking Project" text', String(mobileActive));
await page.screenshot({ path: 'active-project-audit-mobile.png' });

console.log('[api responses] ' + (apiResponses.join(' | ') || '(none)'));
console.log('[console errors] ' + (consoleErrors.slice(0, 6).join(' || ') || '(none)'));
await browser.close();
process.exit(0);
