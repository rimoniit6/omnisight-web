import { chromium } from 'playwright-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.PORTAL_BASE || 'http://localhost:3000';
const ADMIN_EMAIL = process.env.PORTAL_EMAIL;
const ADMIN_PASSWORD = process.env.PORTAL_PASSWORD;

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const results = [];
const rec = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };

// ── Login as super admin and create a temp viewer user ─────────────────────
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('form', { timeout: 30000 });
await page.locator('input[type=email]').fill(ADMIN_EMAIL);
await page.locator('input[type=password]').fill(ADMIN_PASSWORD);
await page.locator('form button[type=submit]').first().click();
await page.waitForTimeout(6000);
// Dismiss the onboarding tour on the admin page too (blocks pointer events)
await page.evaluate(() => {
  const overlays = [...document.querySelectorAll('.fixed.inset-0')];
  for (const o of overlays) {
    const btns = [...o.querySelectorAll('button')];
    const t = btns.find((b) => /skip/i.test(b.textContent || ''));
    if (t) { t.click(); return; }
  }
});
await page.waitForTimeout(1200);
await page.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));

const VIEWER_EMAIL = 'portal-e2e-viewer@temp.local';
const VIEWER_PW = 'PortalE2E-Temp-123';
let viewerUserId = null;
let orgId = null;

const created = await page.evaluate(async ({ email, password }) => {
  const orgRes = await fetch('/api/organization');
  const orgJson = await orgRes.json().catch(() => null);
  const orgId = orgJson?.data?.id || orgJson?.organization?.id || null;
  const res = await fetch('/api/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: 'Portal E2E Viewer', password, role: 'viewer', organizationId: orgId }),
  });
  return { status: res.status, orgId };
}, { email: VIEWER_EMAIL, password: VIEWER_PW });
orgId = created.orgId;
// Resolve the created user's id via the admin users list (the create response
// shape varies; the list is stable) so cleanup is reliable.
const usersList = await page.evaluate(async (email) => {
  const r = await fetch('/api/auth/users?search=' + encodeURIComponent(email) + '&limit=10');
  const j = await r.json().catch(() => ({}));
  const u = (j.data || j.users || []).find((x) => x.email === email);
  return u ? u.id : null;
}, VIEWER_EMAIL);
viewerUserId = usersList;
rec('temp viewer user created', created.status === 201 || created.status === 200, `status ${created.status} id=${viewerUserId || '?'}`);

// ── Viewer browser: portal hidden + API denied ─────────────────────────────
const viewerPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await viewerPage.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await viewerPage.waitForSelector('form', { timeout: 30000 });
await viewerPage.locator('input[type=email]').fill(VIEWER_EMAIL);
await viewerPage.locator('input[type=password]').fill(VIEWER_PW);
await viewerPage.locator('form button[type=submit]').first().click();
await viewerPage.waitForTimeout(6000);
await viewerPage.evaluate(() => {
  const overlays = [...document.querySelectorAll('.fixed.inset-0')];
  for (const o of overlays) {
    const btns = [...o.querySelectorAll('button')];
    const t = btns.find((b) => /skip/i.test(b.textContent || ''));
    if (t) { t.click(); return; }
  }
});
await viewerPage.waitForTimeout(1000);
const viewerBody = await viewerPage.locator('body').innerText();
rec('viewer: portal NOT in sidebar', !/employee portal/i.test(viewerBody), 'hidden from nav');

// Viewer direct API access must be denied at the proxy (403)
const apiStatus = await viewerPage.evaluate(async () => {
  const r = await fetch('/api/self/dashboard?employeeId=x');
  return { status: r.status, body: (await r.text()).slice(0, 80) };
});
rec('viewer: /api/self denied (403)', apiStatus.status === 403, `got ${apiStatus.status}`);
const empSearch = await viewerPage.evaluate(async () => {
  const r = await fetch('/api/employees/search?status=active&limit=1');
  return { status: r.status };
});
rec('viewer: employee search allowed (viewer floor)', empSearch.status === 200, `got ${empSearch.status}`);

// ── Consent mutation round-trip as admin (capture → revoke → verify → restore) ─
const adminPage = page; // still logged in as super admin
await adminPage.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));
const portalNav = adminPage.getByRole('button', { name: 'Employee Portal' }).first();
await portalNav.scrollIntoViewIfNeeded().catch(() => {});
await portalNav.evaluate((el) => el.click());
await adminPage.waitForTimeout(3000);
await adminPage.getByRole('tab', { name: 'Consents' }).click();
await adminPage.waitForTimeout(3000);

// Find the usb_monitoring consent state BEFORE (via API)
const stateBefore = await adminPage.evaluate(async () => {
  const empRes = await fetch('/api/employees/search?status=active&limit=1');
  const emp = (await empRes.json()).data[0];
  const cRes = await fetch('/api/self/consents?employeeId=' + emp.id);
  const cj = await cRes.json();
  const c = cj.data.find((x) => x.consentType === 'usb_monitoring');
  return { empId: emp.id, id: c.id, status: c.status, policyVersion: c.policy?.version || null };
});
rec('consent state captured', !!stateBefore.id && !!stateBefore.status, `${stateBefore.status} id=${stateBefore.id}`);

// Toggle: granted → revoked (only if granted; else granted)
const targetStatus = stateBefore.status === 'granted' ? 'revoked' : 'granted';
const mutated = await adminPage.evaluate(async ({ id, empId, status, consentType }) => {
  const r = await fetch('/api/self/consents/' + id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: empId, status, consentType }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, { id: stateBefore.id, empId: stateBefore.empId, status: targetStatus, consentType: 'usb_monitoring' });
rec(`consent mutation (${targetStatus}) accepted`, mutated.status === 200, `status ${mutated.status}`);

// Verify DB reflects the mutation
const dbCheck = await adminPage.evaluate(async ({ empId }) => {
  const cRes = await fetch('/api/self/consents?employeeId=' + empId);
  const cj = await cRes.json();
  const c = cj.data.find((x) => x.consentType === 'usb_monitoring');
  return { status: c.status, log: c.consentLogs?.[0]?.action || null, performedBy: c.consentLogs?.[0]?.performedBy || null };
}, { empId: stateBefore.empId });
rec('mutation reflected in API', dbCheck.status === targetStatus, `now ${dbCheck.status}`);

// Restore original state
if (dbCheck.status !== stateBefore.status) {
  const restored = await adminPage.evaluate(async ({ id, empId, status, consentType }) => {
    const r = await fetch('/api/self/consents/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: empId, status, consentType }),
    });
    return { status: r.status };
  }, { id: stateBefore.id, empId: stateBefore.empId, status: stateBefore.status, consentType: 'usb_monitoring' });
  rec('consent state restored', restored.status === 200, `status ${restored.status}`);
}
const afterRestore = await adminPage.evaluate(async ({ empId }) => {
  const cRes = await fetch('/api/self/consents?employeeId=' + empId);
  const cj = await cRes.json();
  return cj.data.find((x) => x.consentType === 'usb_monitoring').status;
}, { empId: stateBefore.empId });
rec('restoration verified via API', afterRestore === stateBefore.status, `back to ${afterRestore}`);

// ── Cleanup: delete the temp viewer user ───────────────────────────────────
if (viewerUserId) {
  const del = await adminPage.evaluate(async (uid) => {
    const r = await fetch('/api/auth/users/' + uid, { method: 'DELETE' });
    return { status: r.status };
  }, viewerUserId);
  rec('temp viewer user deleted', del.status === 200, `status ${del.status}`);
}

await viewerPage.close();
await browser.close();

const pass = results.filter((r) => r.ok).length;
console.log(`\n===== RBAC E2E: ${pass}/${results.length} passed =====`);
process.exit(pass === results.length ? 0 : 1);
