export default async function run(page, ui) {
  const out = {};
  await page.goto('http://localhost:3000/login');
  await page.waitForSelector('input[type="email"]', { timeout: 30000 });
  await page.locator('input[type="email"]').first().fill('rimon@admin.com');
  await page.locator('input[type="password"]').first().fill('Rimon0000000');
  const snap0 = await ui.snapshot();
  const btn = snap0.match(/@(e\d+) button "[^"]*(?:sign in|log in)[^"]*"/i)?.[1];
  if (btn) await ui.click(btn);
  await page.waitForSelector('text=CONTROL CENTER', { timeout: 30000 });
  await page.waitForTimeout(1500);

  // Dismiss the onboarding tour if present
  const skip = page.getByText('Skip tour', { exact: true });
  if (await skip.count()) {
    await skip.click().catch(() => {});
    await page.waitForTimeout(600);
  }

  // Command palette → Purchase Requests
  await page.keyboard.press('Control+KeyK');
  await page.waitForTimeout(1000);
  await page.keyboard.type('purchase requests', { delay: 40 });
  await page.waitForTimeout(900);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(4000);
  out.url = page.url();
  out.queueText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  return out;
}
