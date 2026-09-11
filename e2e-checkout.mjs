export default async function run(page, ui) {
  // Wait for plans to load (plan radio cards)
  await page.waitForSelector('input[name="plan"]', { timeout: 20000 });
  // Select the Business plan card (3rd) if present, else keep preselected
  const snap0 = await ui.snapshot();
  // Choose YEARLY period
  const yearly = snap0.match(/@(e\d+) button "Yearly"/)?.[1];
  if (yearly) await ui.click(yearly);
  await page.waitForTimeout(600);
  // Fill contact info
  const snap = await ui.snapshot();
  const byPlaceholder = async (ph) => {
    const m = snap.match(new RegExp(`@(e\\d+) textbox "${ph}"`)) || snap.match(new RegExp(`@(e\\d+) textbox \\"${ph}\\"`));
    return m?.[1];
  };
  const company = await byPlaceholder('Acme Inc.');
  const contact = await byPlaceholder('Jane Doe');
  const email = await byPlaceholder('admin@company.com');
  if (company) await ui.fill(company, 'E2E Acme Ltd');
  if (contact) await ui.fill(contact, 'E2E Tester');
  if (email) await ui.fill(email, 'e2e-acme@example.test');
  // Device quantity — default 25 is fine; read price summary total
  await page.waitForTimeout(1200);
  const priceText = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('main .space-y-6 > div, main [class*="Card"]')];
    const total = [...document.querySelectorAll('span')].find(s => s.previousElementSibling?.textContent === 'Total');
    return total?.nextElementSibling?.textContent ?? null;
  });
  // Submit
  const submit = snap.match(/@(e\d+) button "Submit Purchase Request"/)?.[1];
  if (!submit) return { error: 'no submit button', snapshot: snap };
  await ui.click(submit);
  // Wait for confirmation
  await page.waitForSelector('text=Purchase request submitted', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const confirmation = await page.evaluate(() => document.querySelector('.max-w-lg')?.innerText ?? document.body.innerText.slice(0, 800));
  return { pricePreview: priceText, confirmation };
}
