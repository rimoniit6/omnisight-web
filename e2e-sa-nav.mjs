export default async function run(page, ui) {
  const out = {};
  // The sidebar is collapsible — expand if collapsed, then click the nav item
  // via the accessibility tree. Re-snapshot to get fresh refs.
  let snap = await ui.snapshot();
  // Try direct click on the nav item in the snapshot
  let ref = snap.match(/@(e\d+) (?:button|link) "Purchase Requests"/)?.[1];
  if (!ref) {
    // Expand the collapsed sidebar first
    const expand = snap.match(/@(e\d+) button "(?:Expand|Collapse|Open navigation[^"]*)"/)?.[1];
    if (expand) { await ui.click(expand); await page.waitForTimeout(600); snap = await ui.snapshot(); }
    ref = snap.match(/@(e\d+) (?:button|link) "Purchase Requests"/)?.[1];
  }
  if (ref) {
    await ui.click(ref);
  } else {
    // Last resort: command palette via the Search button
    const search = snap.match(/@(e\d+) button "Search"/)?.[1];
    if (search) {
      await ui.click(search);
      await page.waitForTimeout(700);
      await page.keyboard.type('purchase requests', { delay: 30 });
      await page.waitForTimeout(600);
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(3500);
  out.pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000));
  return out;
}
