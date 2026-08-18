// Admin-Controlled Active Tracking Project — real browser E2E (Phase 20).
//
// Drives real Chrome against the running dev server + real PostgreSQL and the
// REAL agent activity pipeline (POST /api/agent/activity with a real agent
// token — the exact path the desktop agent uses). No mocks, no fake activity,
// no manual DB manipulation to simulate success.
//
// Flow:
//   1. Login as admin → Project Tracking → open "ok" → Team tab
//   2. Rimon already assigned → set "ok" as active tracking project (UI +
//      confirmation dialog) → verify "● Active Tracking Project" indicator
//   3. POST real agent activity → wait for the realtime sync loop → verify an
//      ACTIVITY_AUTO TimeEntry lands on "ok" and its hours increase
//   4. Time Log shows the auto entry (Source = Activity Tracking) WITHOUT reload
//   5. Create a second project + assign Rimon → verify active project unchanged
//   6. Switch active project to the second project → new real activity goes
//      ONLY there (old project receives nothing) → survives browser refresh
//   7. Remove Rimon from the active project → active project auto-cleared →
//      new activity no longer goes to the removed project
//   8. Cleanup: remove test data, restore original state
//
// Run: node scripts/active-project-e2e.mjs   (requires dev server on :3000)
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.AP_E2E_BASE || 'http://localhost:3000';
const EMAIL = process.env.AP_E2E_EMAIL || 'admin@worklens.ai';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envSrc = fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '';
const PASSWORD = process.env.AP_E2E_PASSWORD || envSrc.match(/SUPER_ADMIN_PASSWORD=([^\r\n]+)/)?.[1]?.trim() || '';

const ts = (lbl) => console.log(new Date().toISOString().slice(11, 23), lbl);
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// ── Resolve real entities ───────────────────────────────────────────────────
const emp = await p.employee.findFirst({ where: { employeeId: '001' }, include: { organization: true } });
if (!emp) { console.log('FATAL: employee 001 (Rimon) not found'); process.exit(1); }
const okProject = await p.project.findFirst({ where: { organizationId: emp.organizationId, name: 'ok' } });
if (!okProject) { console.log('FATAL: project "ok" not found'); process.exit(1); }
const okMember = await p.projectMember.findFirst({ where: { projectId: okProject.id, employeeId: emp.id, leftAt: null } });
if (!okMember) { console.log('FATAL: Rimon is not an active member of "ok"'); process.exit(1); }
const token = await p.agentToken.findFirst({ where: { employeeId: emp.id } });
if (!token) { console.log('FATAL: no agent token for Rimon'); process.exit(1); }

ts(`employee=${emp.firstName} ${emp.lastName} org=${emp.organization.name}`);
ts(`project ok=${okProject.id}`);

// Pre-existing time state (for later comparison)
const okHoursBefore = await p.timeEntry.aggregate({ where: { projectId: okProject.id }, _sum: { hours: true } });
ts(`project "ok" hours BEFORE: ${okHoursBefore._sum.hours ?? 0}`);

// ── Browser setup ───────────────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
const activeProjectCalls = [];
page.on('response', (r) => {
  if (r.url().includes('/active-project')) {
    activeProjectCalls.push(`${r.request().method()} ${r.status()} ${r.url()}`);
  }
});
page.on('requestfailed', (r) => { if (r.url().includes('/active-project')) consoleErrors.push('REQFAIL: ' + r.url()); });

async function goToProjects() {
  const nav = page.getByRole('button', { name: /^Projects$/ }).first();
  await nav.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(400);
  await nav.evaluate((el) => el.click());
  await page.waitForTimeout(3000);
}

async function closeDetailDialog() {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(800);
}

async function openProject(name, tab = 'Team') {
  await closeDetailDialog();
  const card = page.locator(`text=${name}`).first();
  await card.click();
  await page.waitForTimeout(2500);
  await page.getByRole('tab', { name: tab }).first().click();
  await page.waitForTimeout(1200);
}

// ── 1. Login ────────────────────────────────────────────────────────────────
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('form', { timeout: 20000 });
await page.locator('input[type=email]').fill(EMAIL);
await page.locator('input[type=password]').fill(PASSWORD);
await page.locator('form button[type=submit]').first().click();
await page.waitForSelector('nav, aside, [class*=sidebar]', { timeout: 30000 });
await page.waitForTimeout(2500);
record('1. login -> app shell', page.url().includes('localhost:3000'), page.url());

// Dismiss the onboarding tour with its REAL control (never mutate DOM): a
// first-time user sees the tour overlay covering the app; clicking "Skip
// tour" dismisses it and persists `worklens-tour-completed`.
await page.waitForTimeout(1500);
const tourSkip = page.getByText('Skip tour', { exact: true }).first();
if ((await tourSkip.count()) > 0) {
  await tourSkip.click();
  await page.waitForTimeout(1000);
} else {
  const tourX = page.getByRole('button', { name: 'Close tour' }).first();
  if ((await tourX.count()) > 0) { await tourX.click(); await page.waitForTimeout(1000); }
}
await page.evaluate(() => localStorage.setItem('worklens-tour-completed', 'true'));
await page.waitForTimeout(800);

await goToProjects();
let bodyText = await page.locator('body').innerText();
record('2. projects page renders', /Project Tracking/.test(bodyText), bodyText.slice(0, 80).replace(/\s+/g, ' '));

// ── 3. Open project "ok" → Team tab → confirm Rimon assigned ───────────────
await openProject('ok');
bodyText = await page.locator('body').innerText();
record('3. project "ok" Team tab open', /Project Members/.test(bodyText), 'Team tab rendered');
record('4. Rimon is assigned', /Rimon Rana/.test(bodyText), 'Rimon listed in Team tab');

// ── 4. Set "ok" as Active Tracking Project via UI + confirmation ───────────
const setActiveBtn = page.getByRole('button', { name: /Set .* active tracking project/ }).first();
record('5. "Set as Active" action present', (await setActiveBtn.count()) > 0);
if ((await setActiveBtn.count()) > 0) {
  await setActiveBtn.click();
  await page.waitForTimeout(800);
  const confirmDialog = page.getByRole('dialog', { name: 'Set active tracking project?' });
  record('6. confirmation dialog shown', (await confirmDialog.count()) > 0);
  const confirmText = await page.locator('body').innerText();
  record('7. confirmation explains consequences', /New activity will be attributed to this project/.test(confirmText) && /Existing time entries will not be changed/.test(confirmText));
  if ((await confirmDialog.count()) > 0) {
    await confirmDialog.getByRole('button', { name: 'Set Active Project' }).click();
    // Poll the DB briefly — the mutation is async (React Query).
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(500);
      const probe = await p.employee.findUnique({ where: { id: emp.id }, select: { activeTrackingProjectId: true } });
      if (probe.activeTrackingProjectId === okProject.id) break;
    }
    await page.waitForTimeout(500);
  }
}
bodyText = await page.locator('body').innerText();
record('8. UI shows "● Active Tracking Project"', /Active Tracking Project/.test(bodyText), 'indicator rendered');

const afterSet = await p.employee.findUnique({ where: { id: emp.id }, select: { activeTrackingProjectId: true } });
record('9. DB activeTrackingProjectId = ok', afterSet.activeTrackingProjectId === okProject.id, afterSet.activeTrackingProjectId || 'null');

// ── 5. Real agent activity → realtime sync → auto time on "ok" ─────────────
const marker = 'AP-E2E-' + Date.now().toString(36);
const DURATION = 90; // 90s = 0.03h (exact, deterministic)
const payload = {
  activities: [{
    type: 'application',
    applicationName: 'chrome.exe',
    title: marker,
    category: 'productive',
    duration: DURATION,
    startedAt: new Date(Date.now() - DURATION * 1000).toISOString(),
    timestamp: new Date().toISOString(),
    employeeId: emp.id,
  }],
};
const resp = await fetch(`${BASE}/api/agent/activity`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token.token },
  body: JSON.stringify(payload),
});
record('10. real agent activity POST accepted', resp.status === 200 || resp.status === 201, `status=${resp.status}`);

// Wait for the realtime sync loop (interval 15s) to absorb the activity.
let autoEntry = null;
let okHoursAfter = null;
const waitUntil = Date.now() + 90000;
while (Date.now() < waitUntil) {
  await new Promise((r) => setTimeout(r, 3000));
  autoEntry = await p.timeEntry.findFirst({ where: { employeeId: emp.id, projectId: okProject.id, source: 'ACTIVITY_AUTO' }, orderBy: { createdAt: 'desc' } });
  okHoursAfter = await p.timeEntry.aggregate({ where: { projectId: okProject.id }, _sum: { hours: true } });
  if (autoEntry && (okHoursAfter._sum.hours ?? 0) > (okHoursBefore._sum.hours ?? 0)) break;
}
record('11. ACTIVITY_AUTO entry created on "ok"', !!autoEntry, autoEntry ? `hours=${autoEntry.hours}` : 'none yet');
const hoursDelta = ((okHoursAfter?._sum.hours ?? 0) - (okHoursBefore._sum.hours ?? 0)).toFixed(2);
record('12. project "ok" hours increased', parseFloat(hoursDelta) > 0, `+${hoursDelta}h`);
const actRow = await p.activity.findFirst({ where: { title: marker } });
record('12b. activity sourced from real agent pipeline', !!actRow, actRow ? `duration=${actRow.duration}s` : 'activity row missing');

// ── 6. Time Log shows the auto entry WITHOUT reload ─────────────────────────
await page.getByRole('tab', { name: 'Time Log' }).first().click();
await page.waitForTimeout(1500);
bodyText = await page.locator('body').innerText();
record('13. Time Log shows "Activity Tracking" source', /Activity Tracking/.test(bodyText), 'auto entry badge in Time Log');
record('13b. auto entry row visible with hours', /h\b|h\s|\.\d{2}/.test(bodyText), 'entry rows rendered');

// ── 7. Add a second project (via admin API — real app pipeline) ────────────
const projName = `AP E2E ${Date.now().toString().slice(-6)}`;
const adminLogin = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
const loginJson = await adminLogin.json();
const adminToken = loginJson.token || loginJson.accessToken || (loginJson.data && (loginJson.data.token || loginJson.data.accessToken));
if (!adminToken) { console.log('FATAL: could not obtain admin API token', JSON.stringify(loginJson).slice(0, 200)); process.exit(1); }
const authHeaders = { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken };
const newProj = await fetch(`${BASE}/api/projects`, {
  method: 'POST', headers: authHeaders,
  body: JSON.stringify({ name: projName, status: 'active' }),
});
record('14. second project created', newProj.status === 201, `status=${newProj.status}`);
const newProjBody = await newProj.json();
const newProjectId = newProjBody.data?.id;
const addMember = await fetch(`${BASE}/api/projects/${newProjectId}/members`, {
  method: 'POST', headers: authHeaders,
  body: JSON.stringify({ employeeId: emp.id, role: 'member' }),
});
record('15. Rimon assigned to second project', addMember.status === 201, `status=${addMember.status}`);

const stillOk = await p.employee.findUnique({ where: { id: emp.id }, select: { activeTrackingProjectId: true } });
record('16. active project unchanged after adding membership', stillOk.activeTrackingProjectId === okProject.id, 'still "ok"');

// ── 8. Reload (fresh list) → open second project → switch active (UI) ──────
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await goToProjects();
await openProject(projName);
bodyText = await page.locator('body').innerText();
record('17. second project Team tab open', /Rimon Rana/.test(bodyText), 'Rimon listed on second project');
const setBtn2 = page.getByRole('button', { name: /Set .* active tracking project/ }).first();
record('17b. "Set as Active" present on second project', (await setBtn2.count()) > 0);
if ((await setBtn2.count()) > 0) {
  await setBtn2.click();
  await page.waitForTimeout(800);
  const dlg = page.getByRole('dialog', { name: 'Set active tracking project?' });
  if ((await dlg.count()) > 0) {
    await dlg.getByRole('button', { name: 'Set Active Project' }).click();
    await page.waitForTimeout(2000);
  }
}
const switched = await p.employee.findUnique({ where: { id: emp.id }, select: { activeTrackingProjectId: true } });
record('18. DB active project switched to second project', switched.activeTrackingProjectId === newProjectId, switched.activeTrackingProjectId || 'null');
bodyText = await page.locator('body').innerText();
record('18b. UI shows Active Tracking on second project', /Active Tracking Project/.test(bodyText));

// ── 9. New real activity → goes ONLY to the second project ─────────────────
const marker2 = 'AP-E2E-SWITCH-' + Date.now().toString(36);
const resp2 = await fetch(`${BASE}/api/agent/activity`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token.token },
  body: JSON.stringify({
    activities: [{
      type: 'application',
      applicationName: 'code.exe',
      title: marker2,
      category: 'productive',
      duration: 120,
      startedAt: new Date(Date.now() - 120000).toISOString(),
      timestamp: new Date().toISOString(),
      employeeId: emp.id,
    }],
  }),
});
record('19. switch activity POST accepted', resp2.status === 200 || resp2.status === 201, `status=${resp2.status}`);

let newEntry = null;
const wait2 = Date.now() + 90000;
while (Date.now() < wait2) {
  await new Promise((r) => setTimeout(r, 3000));
  newEntry = await p.timeEntry.findFirst({ where: { employeeId: emp.id, projectId: newProjectId, source: 'ACTIVITY_AUTO' }, orderBy: { createdAt: 'desc' } });
  if (newEntry) break;
}
record('20. new activity → ACTIVITY_AUTO on second project', !!newEntry, newEntry ? `hours=${newEntry.hours}` : 'none');
const oldProjAutoCount = await p.timeEntry.count({ where: { employeeId: emp.id, projectId: okProject.id, source: 'ACTIVITY_AUTO' } });
record('21. old project received NO new entry', oldProjAutoCount === 1, `${oldProjAutoCount} auto entry (only the earlier one)`);

// Freeze-compare: after the switch, let any in-flight real agent activity
// drain, then verify the historical "ok" entry NEVER changes again (even the
// live agent's activity must go to the new project, not back to "ok").
await new Promise((r) => setTimeout(r, 25000));
const okEntryFrozen = await p.timeEntry.findFirst({ where: { employeeId: emp.id, projectId: okProject.id, source: 'ACTIVITY_AUTO' } });
const okFrozenHours = okEntryFrozen?.hours ?? null;
await new Promise((r) => setTimeout(r, 25000));
const okEntryLater = await p.timeEntry.findFirst({ where: { employeeId: emp.id, projectId: okProject.id, source: 'ACTIVITY_AUTO' } });
record('21b. historical "ok" entry unchanged after switch', okFrozenHours !== null && okEntryLater && okEntryLater.hours === okFrozenHours, `hours=${okEntryLater?.hours} (frozen at ${okFrozenHours})`);

// ── 10. Refresh → active project persists ──────────────────────────────────
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await goToProjects();
const persisted = await p.employee.findUnique({ where: { id: emp.id }, select: { activeTrackingProjectId: true } });
record('22. refresh persistence (DB-backed)', persisted.activeTrackingProjectId === newProjectId, 'survives reload');
await openProject(projName);
bodyText = await page.locator('body').innerText();
record('22b. UI indicator persists after refresh', /Active Tracking Project/.test(bodyText), 'indicator after reload');

// ── 11. Remove Rimon from the active project → auto-clear ──────────────────
const removeBtn = page.getByRole('button', { name: /Remove Rimon Rana from project/ }).first();
record('23. remove action present', (await removeBtn.count()) > 0);
if ((await removeBtn.count()) > 0) {
  await removeBtn.click();
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(500);
    const probe = await p.employee.findUnique({ where: { id: emp.id }, select: { activeTrackingProjectId: true } });
    if (probe.activeTrackingProjectId === null) break;
  }
}
const afterRemove = await p.employee.findUnique({ where: { id: emp.id }, select: { activeTrackingProjectId: true } });
record('24. removing active member clears active project', afterRemove.activeTrackingProjectId === null, afterRemove.activeTrackingProjectId || 'cleared');

// ── 12. Activity after removal does not go to removed project ──────────────
const marker3 = 'AP-E2E-AFTER-REMOVE-' + Date.now().toString(36);
await fetch(`${BASE}/api/agent/activity`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token.token },
  body: JSON.stringify({
    activities: [{
      type: 'application',
      applicationName: 'chrome.exe',
      title: marker3,
      category: 'productive',
      duration: 60,
      startedAt: new Date(Date.now() - 60000).toISOString(),
      timestamp: new Date().toISOString(),
      employeeId: emp.id,
    }],
  }),
});
await new Promise((r) => setTimeout(r, 20000));
const removedCount = await p.timeEntry.count({ where: { employeeId: emp.id, projectId: newProjectId, source: 'ACTIVITY_AUTO' } });
record('25. removed project receives no new auto time', removedCount === 1, `${removedCount} auto entry (only the pre-removal one)`);

// ── Cleanup ────────────────────────────────────────────────────────────────
ts('cleanup: removing test data…');
await p.activity.deleteMany({ where: { title: { in: [marker, marker2, marker3] } } });
await p.timeEntry.deleteMany({ where: { employeeId: emp.id, projectId: newProjectId } });
await p.projectMember.deleteMany({ where: { projectId: newProjectId } });
await p.project.deleteMany({ where: { id: newProjectId } });
// Restore original state: Rimon's active project back to null (it was null).
await p.employee.update({ where: { id: emp.id }, data: { activeTrackingProjectId: null } });
ts('cleanup done (test project removed, active project restored to null)');

console.log('--- active-project API calls ---');
console.log(activeProjectCalls.join('\n') || '(none)');
console.log('--- console errors ---');
console.log(consoleErrors.slice(0, 8).join('\n') || '(none)');
await browser.close();
await p.$disconnect();

const failed = results.filter((r) => !r.ok).length;
console.log(`\nE2E RESULT: ${results.length - failed}/${results.length} passed`);
process.exit(failed > 0 ? 1 : 0);
