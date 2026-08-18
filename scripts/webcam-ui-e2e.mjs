import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const env = readFileSync('.env', 'utf8');
const ADMIN_EMAIL = env.match(/SUPER_ADMIN_EMAIL=(.*)/)[1].trim();
const ADMIN_PASSWORD = env.match(/SUPER_ADMIN_PASSWORD=(.*)/)[1].trim();
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

async function webcamState() {
  return page.evaluate(() => {
    const badge = [...document.querySelectorAll('.badge, span')]
      .map(e => e.textContent.trim().toUpperCase())
      .find(t => ['LIVE','STOPPED','REQUESTING','STOPPING','ERROR','OFFLINE','NO CONSENT','DISABLED'].includes(t));
    const img = document.querySelector('img[alt="Live webcam frame"]');
    return { badge: badge || null, hasFrame: !!img, imgLoaded: img ? img.complete && img.naturalWidth > 0 : false };
  });
}

try {
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForSelector('form', { timeout: 20000 });
  await page.locator('input[type=email]').fill(ADMIN_EMAIL);
  await page.locator('input[type=password]').fill(ADMIN_PASSWORD);
  await page.locator('form button[type=submit]').first().click();
  await page.waitForSelector('nav, aside, [class*=sidebar]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const t = btns.find((b) => /skip/i.test(b.textContent || ''));
    if (t) { t.click(); return true; }
    return false;
  });
  await page.waitForTimeout(1000);
  // Navigate: Employees → employee → Webcam tab
  const empNav = page.getByRole('button', { name: /employees/i }).first();
  if (await empNav.count()) await empNav.click().catch(() => {});
  await page.waitForTimeout(2500);
  // Click the first employee row (table <tr> onClick → handleView)
  const row = page.locator('table tbody tr').first();
  if (await row.count()) await row.click().catch(() => {});
  await page.waitForTimeout(2500);
  // Open Webcam tab (only present once Employee Details is mounted)
  const wcTab = page.getByRole('tab', { name: /webcam/i }).first();
  if (await wcTab.count()) await wcTab.click().catch(() => {});
  await page.waitForTimeout(2500);

  const s0 = await webcamState();
  log('INITIAL state:', JSON.stringify(s0));
  if (s0.badge !== 'STOPPED') {
    const dbg = await page.evaluate(() => ({
      url: location.pathname,
      hasWebcamText: document.body.innerText.includes('On-Demand Webcam'),
      tabs: [...document.querySelectorAll('[role=tab]')].map(t => t.textContent.trim()),
      bodyStart: document.body.innerText.slice(0, 300),
    }));
    log('DEBUG:', JSON.stringify(dbg));
    log('FAIL: expected STOPPED initially, got ' + s0.badge);
    await browser.close();
    process.exit(1);
  }

  // Click Start Webcam
  const start = page.getByRole('button', { name: /start webcam/i }).first();
  if (!(await start.count())) { log('FAIL: Start button not found'); await browser.close(); process.exit(1); }
  await start.click();
  log('clicked Start — polling for LIVE...');
  await page.waitForTimeout(3000);
  const s1 = await webcamState();
  log('after start:', JSON.stringify(s1));

  // Wait up to 40s for LIVE + a real loaded frame
  let live = false, frameOk = false;
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(3000);
    const st = await webcamState();
    log('  poll:', JSON.stringify(st));
    if (st.badge === 'LIVE') live = true;
    if (live && st.hasFrame && st.imgLoaded) frameOk = true;
    if (live && frameOk) break;
  }
  if (!live) { log('FAIL: never reached LIVE'); await browser.close(); process.exit(1); }
  if (!frameOk) { log('FAIL: LIVE but no loaded frame'); await browser.close(); process.exit(1); }
  log('PASS: LIVE with real frame rendered');

  // Click Stop — then poll until the server session ends + panel flips (the
  // agent polls commands every 10s, so allow up to 25s). During the stop
  // window the panel may legitimately stay LIVE until the camera is released.
  const stop = page.getByRole('button', { name: /stop webcam/i }).first();
  if (await stop.count()) await stop.click().catch(() => {});
  let stopped = false;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2500);
    const st = await webcamState();
    if (!st.badge || st.badge === 'STOPPED') { stopped = true; log('  after stop poll ' + i + ':', JSON.stringify(st)); break; }
    log('  after stop poll ' + i + ' (still ' + st.badge + '):', JSON.stringify(st));
  }
  const s2 = await webcamState();
  log('after stop:', JSON.stringify(s2));
  if (!stopped) { log('FAIL: panel never left LIVE after stop'); await browser.close(); process.exit(1); }
  log('PASS: camera released — not LIVE, no frame');
  await browser.close();
  process.exit(0);
} catch (e) {
  console.error('ERROR:', e.message);
  await browser.close().catch(() => {});
  process.exit(1);
}
