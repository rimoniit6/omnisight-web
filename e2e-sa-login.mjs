export default async function run(page, ui) {
  const out = { steps: [] };
  // Login as Super Admin
  await page.goto('http://localhost:3000/login');
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 20000 });
  const email = await page.locator('input[type="email"], input[name="email"]').first();
  const pass = await page.locator('input[type="password"]').first();
  await email.fill('rimon@admin.com');
  await pass.fill('Rimon0000000');
  const snap = await ui.snapshot();
  const btn = snap.match(/@(e\d+) button "[^"]*(?:sign in|Sign in|log in|Log in|Login)[^"]*"/i)?.[1];
  if (btn) await ui.click(btn);
  await page.waitForTimeout(6000);
  out.afterLoginUrl = page.url();
  out.landingText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  return out;
}
