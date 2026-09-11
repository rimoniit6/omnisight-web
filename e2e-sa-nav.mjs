export default async function run(page, ui) {
  const out = {};
  // Dismiss the tour overlay if visible (localStorage flag persists in this session)
  const skip = page.getByText('Skip tour', { exact: true });
  if (await skip.count()) {
    await skip.click().catch(() => {});
    await page.waitForTimeout(800);
  }
  await page.evaluate(() => localStorage.setItem('tour-completed', 'true').catch?.(() => {}) ?? localStorage.setItem('tour-completed', 'true'));
  // Navigate to Purchase Requests via sidebar text click (overlay now gone)
  await page.getByText('Purchase Requests', { exact: true }).first().click({ timeout: 15000 }).catch(async () => {
    // fallback: command palette
    await page.keyboard.press('Control+KeyK');
    await page.waitForTimeout(800);
    await page.keyboard.type('purchase requests', { delay: 30 });
    await page.waitForTimeout(600);
    await page.keyboard.press('Enter');
  });
  await page.waitForTimeout(3500);
  out.pageText = await page.evaluate(() => document.body.innerText.slice(0, 3200));
  out.snapshot = await ui.snapshot();
  return out;
}
