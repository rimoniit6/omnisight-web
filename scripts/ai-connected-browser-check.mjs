// Browser check of the genuinely AI-connected surfaces: Daily Report AI summary
// panel + Sentiment page. Verifies they load, and that the AI failure is
// reported honestly (fallback text, never fake AI content).
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
const apiCalls = [];
page.on('response', async (r) => {
  const url = r.url();
  if (url.includes('/api/reports/daily/ai-summary') || url.includes('/api/reports/daily') || url.includes('/api/sentiment')) {
    let body = '';
    try { const j = await r.json(); body = JSON.stringify(j).slice(0, 500); } catch {}
    apiCalls.push({ m: r.request().method(), s: r.status(), u: url.replace(BASE, ''), b: body });
  }
});
const log = (l, v) => console.log(`[${l}] ${v}`);

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('form', { timeout: 20000 });
await page.locator('input[type=email]').fill(EMAIL);
await page.locator('input[type=password]').fill(PASSWORD);
await page.locator('form button[type=submit]').first().click();
await page.waitForSelector('nav, aside, [class*=sidebar]', { timeout: 30000 });
await page.waitForTimeout(3000);
const tour = await page.evaluate(() => {
  const t = [...document.querySelectorAll('.fixed.inset-0.z-\\[100\\]')];
  return t.length > 0 && !!document.body.innerText.match(/Welcome to OmniSight/);
});
if (tour) {
  const skip = page.getByText('Skip tour', { exact: true }).first();
  if ((await skip.count()) > 0) { await skip.click(); await page.waitForTimeout(800); }
}

// Daily Report page
await page.locator('button[aria-label="Daily Report"]').first().click();
await page.waitForTimeout(5000);
let txt = await page.evaluate(() => document.body.innerText);
log('daily-report-loaded', txt.includes('Daily Summary Report'));
// Open the AI summary panel
const showAi = page.getByText('Show AI Summary', { exact: true }).first();
log('show-ai-summary-btn', String((await showAi.count()) > 0));
if ((await showAi.count()) > 0) {
  await showAi.click();
  await page.waitForTimeout(4000);
  txt = await page.evaluate(() => document.body.innerText);
  const aiPanel = txt.match(/AI Executive Summary[\s\S]{0,400}/)?.[0]?.slice(0, 300) || '';
  log('ai-summary-panel-text', JSON.stringify(aiPanel));
  log('ai-fallback-shown', /provider|unavailable|configure|not found/i.test(aiPanel));
  // Is the provider/model named (honest)? The response includes aiProviderUsed
  log('ai-summary-copy-honest', /AI provider endpoint was not found|AI provider request failed|not configured/i.test(txt));
}

// Sentiment page
await page.locator('button[aria-label="Sentiment"]').first().click();
await page.waitForTimeout(4000);
txt = await page.evaluate(() => document.body.innerText);
log('sentiment-page-loaded', txt.includes('Sentiment'));
log('sentiment-has-employee', txt.includes('Rimon'));
log('sentiment-provider-label', /rules|AI|provider/i.test(txt) ? (txt.match(/rules|provider|AI/i)?.[0] || '') : 'n/a');

console.log('\n=== API CALLS ===');
for (const c of apiCalls) console.log(`${c.m} ${c.s} ${c.u}\n   ${c.b.slice(0, 350)}`);
await browser.close();
