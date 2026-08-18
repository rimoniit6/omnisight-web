import { chromium } from 'playwright-core';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const EMAIL = process.env.ADMIN_EMAIL, PASS = process.env.ADMIN_PASSWORD;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const viewports = [[1920,1080],[1366,768],[768,1024],[390,844],[360,800]];
let allOk = true;
for (const [w,h] of viewports) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  try {
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForSelector('form', { timeout: 20000 });
    await page.locator('input[type=email]').fill(EMAIL);
    await page.locator('input[type=password]').fill(PASS);
    await page.locator('form button[type=submit]').first().click();
    // App shell: desktop renders a sidebar; mobile hides it and shows a
    // hamburger in the header. Wait for whichever appears.
    await page.waitForFunction(
      () => document.querySelector('nav, aside, [class*=sidebar]') || document.querySelector('button[aria-label="Open navigation menu"]'),
      { timeout: 30000 }
    );
    await page.waitForTimeout(1500);
    await page.evaluate(() => { localStorage.setItem('worklens-tour-completed','true'); const os=[...document.querySelectorAll('.fixed.inset-0')]; for (const o of os){ const b=[...o.querySelectorAll('button')].find(x=>/skip/i.test(x.textContent||'')); if(b){b.click();return true;} } return false; });
    await page.waitForTimeout(800);
    // Desktop: sidebar link. Mobile: hamburger → mobile sidebar link.
    const navBtn = page.getByRole('button', { name: 'Employee Portal' }).first();
    if (await navBtn.isVisible().catch(() => false)) {
      await navBtn.evaluate((el) => el.click());
    } else {
      await page.getByRole('button', { name: 'Open navigation menu' }).first().evaluate((el) => el.click());
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: 'Employee Portal' }).first().evaluate((el) => el.click());
    }
    await page.waitForTimeout(4000);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const text = await page.evaluate(() => document.body.innerText);
    const hasHours = /3\.\dh/.test(text) || /[1-9]\dh/.test(text);
    const ok = overflow <= 1 && hasHours;
    if (!ok) allOk = false;
    console.log(`${ok?'PASS':'FAIL'} ${w}x${h} overflow=${overflow}px hours=${hasHours}`);
  } catch (e) {
    allOk = false;
    console.log(`FAIL ${w}x${h} ${e.message.split('\n')[0]}`);
  } finally { await page.close(); }
}
await browser.close();
console.log(allOk ? 'ALL VIEWPORTS OK' : 'VIEWPORT FAILURES');
process.exit(allOk ? 0 : 1);
