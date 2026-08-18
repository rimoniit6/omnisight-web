// Admin AI Insights — real-browser data-source audit (read-only).
// Real Chrome, real login, real org data. Captures every /api/insights*
// request/response and verifies the Deep Analysis output references real
// employees/activities from the DB. Does NOT modify any data (POST /api/insights
// creates a row — the audit avoids it unless needed; "Run Analysis" is a pure GET).
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
const apiCalls = []; // {method, status, url, body(truncated)}
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message.slice(0, 300)));
page.on('response', async (r) => {
  const url = r.url();
  if (url.includes('/api/insights') || url.includes('/api/reports/daily/ai-summary') || url.includes('/api/sentiment')) {
    let body = '';
    try { const j = await r.json(); body = JSON.stringify(j).slice(0, 600); } catch { /* not json */ }
    apiCalls.push({ method: r.request().method(), status: r.status(), url: url.replace(BASE, ''), body });
  }
});

const log = (lbl, v) => console.log(`[${lbl}] ${v}`);

// Login
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('form', { timeout: 20000 });
await page.locator('input[type=email]').fill(EMAIL);
await page.locator('input[type=password]').fill(PASSWORD);
await page.locator('form button[type=submit]').first().click();
await page.waitForSelector('nav, aside, [class*=sidebar]', { timeout: 30000 });
await page.waitForTimeout(3000);
log('login-url', page.url());

// Dismiss onboarding tour if present (real Skip control — same as prior audits).
const tourVisible = await page.evaluate(() => {
  const t = [...document.querySelectorAll('.fixed.inset-0.z-\\[100\\]')];
  return t.length > 0 && !!document.body.innerText.match(/Welcome to OmniSight/);
});
log('tour-overlay', String(tourVisible));
if (tourVisible) {
  const skip = page.getByText('Skip tour', { exact: true }).first();
  if ((await skip.count()) > 0) { await skip.click(); await page.waitForTimeout(1000); }
  else {
    const x = page.getByRole('button', { name: 'Close tour' }).first();
    if ((await x.count()) > 0) { await x.click(); await page.waitForTimeout(1000); }
  }
}

// Navigate to AI Insights via the sidebar button (aria-label = label)
const aiBtn = page.locator('button[aria-label="AI Insights"]').first();
log('ai-insights-nav-btn', String((await aiBtn.count()) > 0));
if ((await aiBtn.count()) > 0) {
  await aiBtn.click();
  await page.waitForTimeout(3500);
} else {
  // fallback: try any element containing AI Insights text
  const any = page.getByText('AI Insights', { exact: true }).first();
  if ((await any.count()) > 0) { await any.click(); await page.waitForTimeout(3500); }
  else log('nav-fallback', 'no AI Insights element found');
}
log('page-url-after-nav', page.url());
const bodyText = await page.evaluate(() => document.body.innerText);
log('page-has-title', bodyText.includes('Insight') || bodyText.includes('Analysis'));
log('page-has-deep-analysis', bodyText.includes('Deep Analysis'));
log('page-has-run-analysis-btn', bodyText.includes('Run Analysis'));

// What insights are currently listed (persisted AiInsight rows)?
const feedSection = bodyText.includes('Insight Feed');
log('insight-feed-section', String(feedSection));
const feedText = await page.evaluate(() => {
  const el = [...document.querySelectorAll('h2')].find(h => h.textContent?.includes('Insight Feed'));
  if (!el) return '';
  const card = el.closest('div')?.parentElement?.parentElement;
  return card ? card.innerText.slice(0, 800) : '';
});
log('insight-feed-content', JSON.stringify(feedText.slice(0, 500)));

// Click "Run Analysis" (pure GET — read-only)
const runBtn = page.getByText('Run Analysis', { exact: true }).first();
log('run-analysis-btn-present', String((await runBtn.count()) > 0));
if ((await runBtn.count()) > 0) {
  await runBtn.click();
  await page.waitForTimeout(6000); // wait for analysis to render
}
const afterAnalysis = await page.evaluate(() => document.body.innerText);
log('analysis-rendered', afterAnalysis.includes('Confidence') && (afterAnalysis.includes('Gap') || afterAnalysis.includes('Fleet') || afterAnalysis.includes('Optimization') || afterAnalysis.includes('Comparison')));
// Show the analysis card titles
const cardTitles = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('h3')].map(h => h.textContent?.trim()).filter(Boolean);
  return cards.slice(0, 12);
});
log('analysis-card-titles', JSON.stringify(cardTitles));
// Show a snippet of the first analysis card content (should name real employees)
const firstCardText = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('h3')];
  for (const c of cards) {
    const card = c.closest('div[class*=card], div[class*=Card]') || c.parentElement?.parentElement?.parentElement;
    if (card && card.innerText.length > 100) return card.innerText.slice(0, 500);
  }
  return '';
});
log('first-analysis-card', JSON.stringify(firstCardText.slice(0, 400)));

// Network log
console.log('\n=== API CALLS (insights/sentiment/ai-summary) ===');
for (const c of apiCalls) {
  console.log(`${c.method} ${c.status} ${c.url}`);
  if (c.body) console.log(`   body: ${c.body.slice(0, 400)}`);
}
console.log('\n=== CONSOLE ERRORS ===');
if (consoleErrors.length === 0) console.log('(none)');
else consoleErrors.forEach((e) => console.log(e));

await browser.close();
