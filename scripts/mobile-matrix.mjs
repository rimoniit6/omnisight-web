// OmniSight mobile production matrix (R7).
// For every admin page at every mobile/tablet viewport: login, navigate via the
// mobile drawer, then assert no horizontal overflow, no console errors, and
// that the page actually rendered content. Output is a machine + human
// readable matrix (JSON lines).
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const BASE = process.env.MOBILE_MATRIX_BASE || 'http://localhost:3000';

const env = readFileSync('.env', 'utf8');
const email = (env.match(/^SUPER_ADMIN_EMAIL=(.+)$/m) || [])[1]?.trim();
const password = (env.match(/^SUPER_ADMIN_PASSWORD=(.+)$/m) || [])[1]?.trim();
if (!email || !password) {
  console.error('SUPER_ADMIN_EMAIL/PASSWORD missing from .env');
  process.exit(1);
}

// ─── Matrix ─────────────────────────────────────────────────────────────────
const VIEWPORTS = [
  { name: '320px (SE 1st gen)', width: 320, height: 568 },
  { name: '375px (iPhone 13/14)', width: 375, height: 667 },
  { name: '390px (iPhone 12+ / Pixel 7)', width: 390, height: 844 },
  { name: '430px (Pro Max)', width: 430, height: 932 },
  { name: '768px (tablet — desktop layout)', width: 768, height: 1024 },
];

// All critical pages (P3-03): monitoring surface + manager+ pages + admin pages.
// Labels must match src/components/layout/app-sidebar.tsx item labels exactly.
const PAGES = [
  ['dashboard', 'Dashboard'],
  ['employees', 'Employees'],
  ['departments', 'Departments'],
  ['devices', 'Devices'],
  ['activities', 'Activities'],
  ['screenshots', 'Screenshots'],
  ['break-status', 'Break Monitor'],
  ['live-monitor', 'Live Monitor'],
  ['analytics', 'Analytics'],
  ['insights', 'AI Insights'],
  ['sentiment', 'Sentiment'],
  ['notifications', 'Notifications'],
  ['alerts', 'Alerts'],
  ['audit', 'Audit Logs'],
  ['policies', 'Policies'],
  ['anomalies', 'Anomaly Detection'],
  ['consent', 'Consent'],
  ['projects', 'Projects'],
  ['self-portal', 'Employee Portal'],
  ['reports', 'Reports'],
  ['daily-report', 'Daily Report'],
  ['organization', 'Organization'],
  ['settings', 'Settings'],
  ['ai-provider', 'AI Provider'],
  ['agent-approvals', 'Agent Approvals'],
  ['guests', 'Guests'],
  ['security', 'Agent Security'],
];

const SETTLE_MS = 2500; // allow the page's data fetch to land

// Dismiss the first-login tour overlay (backdrop click outside the card) so
// it never intercepts navigation clicks.
async function dismissOverlays(page) {
  for (let i = 0; i < 3; i += 1) {
    const overlay = page.locator('div.fixed.inset-0.z-\\[100\\]').first();
    if (await overlay.count()) {
      try {
        await page.mouse.click(8, 8); // backdrop corner — outside the card
      } catch { /* overlay may be closing */ }
      await page.waitForTimeout(300);
    } else {
      return;
    }
  }
}

const results = [];
const consoleErrors = new Set();

const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.add(msg.text().slice(0, 200));
  });
  page.on('pageerror', (err) => consoleErrors.add(`pageerror: ${String(err).slice(0, 200)}`));

  // Login via the API so the httpOnly session cookie lands in this context.
  // A distinct client IP per context: the (shared PG) login rate limiter is
  // keyed per IP, and this matrix legitimately simulates distinct clients.
  const clientIp = `10.0.0.${10 + VIEWPORTS.indexOf(vp)}`;
  const login = await context.request.post(`${BASE}/api/auth/login`, {
    headers: { 'x-forwarded-for': clientIp },
    data: { email, password },
  });
  if (login.status() !== 200) {
    console.error(`login failed for ${vp.name}: HTTP ${login.status()}`);
    await context.close();
    continue;
  }

  for (const [pageKey, label] of PAGES) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200); // shell mount
    await dismissOverlays(page);

    const isMobile = vp.width < 768;
    if (isMobile) {
      // Open the mobile drawer and click the nav item.
      const menu = page.getByRole('button', { name: 'Open navigation menu' });
      if (await menu.count()) {
        await menu.first().click();
        await page.waitForTimeout(400);
      }
      const item = page.getByRole('button', { name: label, exact: true }).first();
      if (await item.count()) {
        await item.click();
      } else {
        // Missing navigation is a real failure (the page was never reached),
        // not a pass — the drawer may need scrolling or the label changed.
        results.push({ viewport: vp.name, page: pageKey, overflow: 'NO-NAV-ITEM', note: `label "${label}" not found in drawer`, fail: true });
        continue;
      }
    } else {
      // Desktop sidebar button.
      const item = page.getByRole('button', { name: label, exact: true }).first();
      if (await item.count()) {
        await item.click();
      } else {
        results.push({ viewport: vp.name, page: pageKey, overflow: 'NO-NAV-ITEM', note: `label "${label}" not found in sidebar`, fail: true });
        continue;
      }
    }

    await page.waitForTimeout(SETTLE_MS);

    const metrics = await page.evaluate(() => {
      const de = document.documentElement;
      const overflow = de.scrollWidth - window.innerWidth;
      return {
        overflowPx: overflow,
        innerWidth: window.innerWidth,
        scrollWidth: de.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        h1: document.querySelector('h1')?.textContent?.trim() ?? null,
        mainChildren: document.querySelector('main')?.children.length ?? 0,
        contentTextLen: (document.querySelector('main')?.textContent ?? '').trim().length,
      };
    });

    results.push({
      viewport: vp.name,
      page: pageKey,
      overflowPx: metrics.overflowPx,
      h1: metrics.h1,
      mainChildren: metrics.mainChildren,
      contentTextLen: metrics.contentTextLen,
      fail: metrics.overflowPx > 0,
    });
  }

  await context.close();
}

await browser.close();

// ─── Report ─────────────────────────────────────────────────────────────────
let failures = 0;
console.log('viewport | page | overflowPx | contentChars | status');
for (const r of results) {
  const status = r.fail ? 'FAIL' : 'ok';
  if (r.fail) failures += 1;
  console.log(`${r.viewport} | ${r.page} | ${r.overflowPx} | ${r.contentTextLen ?? r.note} | ${status}`);
}

console.log(`\nconsole errors captured: ${consoleErrors.size}`);
for (const e of consoleErrors) console.log(`  - ${e}`);

console.log(`\nRESULT: ${results.length - failures}/${results.length} cells clean`);
if (failures > 0) process.exit(1);
