export default async function run(page, ui) {
  await page.waitForSelector('input[name="plan"]', { timeout: 20000 });
  await page.waitForTimeout(800);
  // Select Customer Database mode card
  await page.getByText('Customer Database', { exact: false }).first().click();
  await page.waitForTimeout(500);
  // Select MONTHLY (already default, but click to be sure)
  const monthly = await page.getByRole('button', { name: 'Monthly', exact: true }).first();
  if (await monthly.count()) await monthly.click().catch(() => {});
  await page.waitForTimeout(800);
  // Fill contact info
  const snap = await ui.snapshot();
  const find = (ph) => snap.match(new RegExp(`@(e\\d+) textbox "${ph}"`))?.[1];
  const company = find('Acme Inc.');
  const contact = find('Jane Doe');
  const email = find('admin@company.com');
  if (company) await ui.fill(company, 'E2E DB Traders');
  if (contact) await ui.fill(contact, 'DB Tester');
  if (email) await ui.fill(email, 'e2e-db@example.test');
  await page.waitForTimeout(1200);
  // Read the unlimited-devices note and total
  const summary = await page.evaluate(() => {
    const unlimited = [...document.querySelectorAll('p, span')].find(el => el.textContent.includes('unlimited devices'));
    const total = [...document.querySelectorAll('span')].find(s => s.previousElementSibling?.textContent === 'Total');
    return { unlimitedNote: unlimited?.textContent ?? null, total: total?.nextElementSibling?.textContent ?? null };
  });
  const submit = snap.match(/@(e\d+) button "Submit Purchase Request"/)?.[1];
  if (!submit) return { error: 'no submit button' };
  await ui.click(submit);
  await page.waitForSelector('text=Purchase request submitted', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const confirmation = await page.evaluate(() => document.querySelector('.max-w-lg')?.innerText ?? document.body.innerText.slice(0, 800));
  return { summary, confirmation };
}
