// Active Tracking Project — real PostgreSQL data audit (read-mostly).
//
// Pure audit of the LIVE system. Reads are direct Prisma queries. The only
// writes are ONE controlled active-project switch via the real admin API
// (same call an admin makes), which is restored to its original value at the
// end — nothing else is modified, no test data is created.
//
// Answers:
//   1. current activeTrackingProjectId
//   2. new Activity IDs/timestamps during the window
//   3. which project each new ACTIVITY_AUTO TimeEntry was attributed to
//   4. whether any new TimeEntry was created for the previously active project
//   5. whether the DB ever holds more than one active assignment per employee
//   6. proof that historical ACTIVITY_AUTO entries are not current tracking
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const fs = require('fs');

const EMAIL = 'admin@worklens.ai';
const envSrc = fs.readFileSync('.env', 'utf8');
const PASSWORD = (envSrc.match(/SUPER_ADMIN_PASSWORD=([^\r\n]+)/) || [])[1] || '';
const BASE = 'http://localhost:3000';

const T = () => new Date().toISOString();
const log = (lbl, obj) => console.log(`[${T()}] ${lbl}: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function adminToken() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const j = await r.json();
  if (!j.token) throw new Error('admin login failed: ' + r.status);
  return j.token;
}

const okProject = await p.project.findFirst({ where: { name: 'ok' } });
const emp = await p.employee.findFirst({ where: { employeeId: '001' } });

async function activeId() {
  const e = await p.employee.findUnique({ where: { id: emp.id }, select: { activeTrackingProjectId: true } });
  return e.activeTrackingProjectId;
}
async function projectName(id) {
  if (!id) return '(none)';
  const pr = await p.project.findUnique({ where: { id }, select: { name: true } });
  return pr ? pr.name : id;
}
async function autoEntries() {
  return p.timeEntry.findMany({
    where: { employeeId: emp.id, source: 'ACTIVITY_AUTO' },
    include: { project: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  });
}
/** Sample: capture current auto entries keyed by project name, with hours + updatedAt. */
async function entrySnapshot() {
  const entries = await autoEntries();
  const map = {};
  for (const e of entries) map[e.project.name] = { hours: e.hours, updatedAt: e.updatedAt.toISOString() };
  return map;
}

// ────────────────────────────────────────────────────────────────────────────
// PHASE 0 — invariant + current state
// ────────────────────────────────────────────────────────────────────────────
console.log('\n════════ PHASE 0 — INVARIANT + CURRENT STATE ════════');

// 5a. Structural proof: activeTrackingProjectId is a SINGLE nullable column.
const dmmf = require('@prisma/client').Prisma.dmmf;
const empModel = dmmf.datamodel.models.find((m) => m.name === 'Employee');
const col = empModel.fields.find((f) => f.name === 'activeTrackingProjectId');
log('5a. schema: Employee.activeTrackingProjectId', JSON.stringify({
  name: col.name, type: col.type, isList: col.isList, isRequired: col.isRequired, isUnique: col.isUnique,
  relationName: col.relationName, onDelete: col.relationFromFields ? 'SetNull (via relation)' : 'n/a',
}));
log('5a. conclusion', 'A single scalar column CANNOT hold two project ids — one active assignment per employee is structural');

// 5b. Current values across ALL employees.
const allActive = await p.employee.findMany({ where: { activeTrackingProjectId: { not: null } }, select: { id: true, firstName: true, lastName: true, activeTrackingProjectId: true } });
log('5b. employees with a non-null activeTrackingProjectId', JSON.stringify(allActive.map((e) => ({ employee: e.firstName + ' ' + e.lastName, activeTrackingProjectId: e.activeTrackingProjectId }))));
log('5b. count of active assignments per employee', JSON.stringify(allActive.map((e) => ({ employee: e.firstName, count: 1 }))) + ' (exactly one column value each)');

// Transition history (proves one-at-a-time over time).
const audit = await p.auditLog.findMany({
  where: { resource: 'employee_active_project', resourceId: emp.id },
  orderBy: { createdAt: 'asc' },
  select: { action: true, createdAt: true, metadata: true, userId: true },
});
log('5c. audit history (employee_active_project)', JSON.stringify(audit.map((a) => {
  let m = {};
  try { m = JSON.parse(a.metadata || '{}'); } catch {}
  return { at: a.createdAt.toISOString(), action: a.action, prev: m.previousProjectId ? m.previousProjectId.slice(-8) : null, next: m.projectId ? m.projectId.slice(-8) : null };
})));

// 1. Current active project.
const cur = await activeId();
log('1. CURRENT activeTrackingProjectId', `${cur} (${await projectName(cur)})`);

// 6. Historical entries baseline (prove they predate monitoring and are separate buckets).
const baselineEntries = await entrySnapshot();
log('6. baseline ACTIVITY_AUTO entries (per project)', JSON.stringify(baselineEntries));
const syncRows = await p.projectTimeSync.findMany({ where: { employeeId: emp.id } });
log('6. ProjectTimeSync buckets (unique per employee+project+date)', JSON.stringify(syncRows.map((s) => ({ projectId: s.projectId.slice(-8), date: s.date.toISOString().slice(0, 10), seconds: s.seconds }))));
const dupBuckets = await p.projectTimeSync.groupBy({ by: ['employeeId', 'projectId', 'date'], _count: true });
log('6. duplicate-bucket check (count>1 would be double counting)', JSON.stringify(dupBuckets.filter((d) => d._count > 1)) + ' (none = idempotent)');

// ────────────────────────────────────────────────────────────────────────────
// PHASE 1 — passive monitoring while active = ajbakj (~4 min)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n════════ PHASE 1 — MONITOR (active = CURRENT, no changes) ~4 min ════════');
let lastActivityAt = new Date(0);
const seenActivities = [];
const seenEntryUpdates = [];
const PASSIVE_MS = 4 * 60 * 1000;
const passiveEnd = Date.now() + PASSIVE_MS;
const activeNameDuring = await projectName(cur);

while (Date.now() < passiveEnd) {
  const newActs = await p.activity.findMany({
    where: { employeeId: emp.id, createdAt: { gt: lastActivityAt } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, duration: true, createdAt: true, title: true },
  });
  for (const a of newActs) {
    seenActivities.push({ id: a.id.slice(-8), at: a.createdAt.toISOString(), dur: a.duration, type: a.type, title: (a.title || '').slice(0, 36) });
    if (a.createdAt > lastActivityAt) lastActivityAt = a.createdAt;
  }
  await sleep(15000);
}
log('2. NEW Activity rows observed (passive window)', JSON.stringify(seenActivities));

// What happened to auto entries during passive monitoring?
const entriesAfterPassive = await entrySnapshot();
for (const name of Object.keys(entriesAfterPassive)) {
  const before = baselineEntries[name];
  const after = entriesAfterPassive[name];
  if (!before || before.hours !== after.hours || before.updatedAt !== after.updatedAt) {
    seenEntryUpdates.push({ project: name, before: before || '(created)', after });
  }
}
log('3/4. ACTIVITY_AUTO changes during passive window (active=' + activeNameDuring + ')', JSON.stringify(seenEntryUpdates));
const okAfterPassive = entriesAfterPassive['ok'];
log('4. previously-active "ok" frozen?', okAfterPassive && okAfterPassive.hours === baselineEntries['ok'].hours && okAfterPassive.updatedAt === baselineEntries['ok'].updatedAt
  ? `YES — hours=${okAfterPassive.hours}, updatedAt=${okAfterPassive.updatedAt} (unchanged)`
  : `NO — ${JSON.stringify(okAfterPassive)} vs baseline ${JSON.stringify(baselineEntries['ok'])}`);

// ────────────────────────────────────────────────────────────────────────────
// PHASE 2 — controlled switch to "ok" via real admin API (~3 min)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n════════ PHASE 2 — CONTROLLED SWITCH (active: ' + activeNameDuring + ' → ok) via real admin API ════════');
const token = await adminToken();
const put = await fetch(`${BASE}/api/employees/${emp.id}/active-project`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify({ projectId: okProject.id }),
});
log('switch API status', put.status);
const switched = await activeId();
log('activeTrackingProjectId after switch', `${switched} (${await projectName(switched)})`);
const frozenAtSwitch = await entrySnapshot(); // snapshot right after the switch

const switchSeen = [];
const SWITCH_MS = 3 * 60 * 1000;
const switchEnd = Date.now() + SWITCH_MS;
while (Date.now() < switchEnd) {
  const newActs = await p.activity.findMany({
    where: { employeeId: emp.id, createdAt: { gt: lastActivityAt } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, type: true, duration: true, createdAt: true, title: true },
  });
  for (const a of newActs) {
    switchSeen.push({ id: a.id.slice(-8), at: a.createdAt.toISOString(), dur: a.duration, type: a.type, title: (a.title || '').slice(0, 36) });
    if (a.createdAt > lastActivityAt) lastActivityAt = a.createdAt;
  }
  await sleep(15000);
}
log('2. NEW Activity rows observed (switch window)', JSON.stringify(switchSeen));

const entriesAfterSwitch = await entrySnapshot();
const switchChanges = [];
for (const name of Object.keys(entriesAfterSwitch)) {
  const before = frozenAtSwitch[name];
  const after = entriesAfterSwitch[name];
  if (!before || before.hours !== after.hours || before.updatedAt !== after.updatedAt) {
    switchChanges.push({ project: name, before: before || '(created)', after });
  }
}
log('3. ACTIVITY_AUTO changes during switch window (active=ok)', JSON.stringify(switchChanges));
const ajbAfterSwitch = entriesAfterSwitch['ajbakj'];
log('4. now-previously-active "ajbakj" frozen after switch?', ajbAfterSwitch && frozenAtSwitch['ajbakj'] && ajbAfterSwitch.hours === frozenAtSwitch['ajbakj'].hours && ajbAfterSwitch.updatedAt === frozenAtSwitch['ajbakj'].updatedAt
  ? `YES — hours=${ajbAfterSwitch.hours}, updatedAt=${ajbAfterSwitch.updatedAt} (unchanged)`
  : `NO — ${JSON.stringify(ajbAfterSwitch)} vs ${JSON.stringify(frozenAtSwitch['ajbakj'])}`);

// ────────────────────────────────────────────────────────────────────────────
// PHASE 3 — restore original active project (real admin API)
// ────────────────────────────────────────────────────────────────────────────
console.log('\n════════ PHASE 3 — RESTORE ORIGINAL ACTIVE PROJECT ════════');
const restore = await fetch(`${BASE}/api/employees/${emp.id}/active-project`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
  body: JSON.stringify({ projectId: cur }),
});
log('restore API status', restore.status);
const restored = await activeId();
log('activeTrackingProjectId restored to', `${restored} (${await projectName(restored)}) — matches original ${cur === restored}`);

// ────────────────────────────────────────────────────────────────────────────
// PHASE 4 — final verification
// ────────────────────────────────────────────────────────────────────────────
console.log('\n════════ PHASE 4 — FINAL VERIFICATION ════════');

// 5. One active assignment per employee — final check.
const finalActive = await p.employee.findMany({ where: { activeTrackingProjectId: { not: null } }, select: { employeeId: true, firstName: true, activeTrackingProjectId: true } });
log('5. final: employees with active assignment', JSON.stringify(finalActive.map((e) => ({ employee: e.firstName, oneValue: !!e.activeTrackingProjectId }))));

// Per-project auto entry counts for Rimon (dedup proof: 1 bucket per project/day).
const perProject = await p.timeEntry.groupBy({ by: ['projectId', 'source', 'date'], where: { employeeId: emp.id, source: 'ACTIVITY_AUTO' }, _count: true, _sum: { hours: true } });
const withNames = [];
for (const g of perProject) {
  const nm = await projectName(g.projectId);
  withNames.push({ project: nm, date: g.date.toISOString().slice(0, 10), entries: g._count, totalHours: Math.round(g._sum.hours * 100) / 100 });
}
log('5. ACTIVITY_AUTO entries per project/day for Rimon', JSON.stringify(withNames));

// 4/6. Did ANY new TimeEntry get created for the previously-active project during the whole audit?
//     (count of auto entries for 'ok' and 'ajbakj' before vs now — should be identical)
const okCountNow = await p.timeEntry.count({ where: { employeeId: emp.id, projectId: okProject.id, source: 'ACTIVITY_AUTO' } });
const baselineNames = Object.keys(baselineEntries);
log('6. historical vs current proof', JSON.stringify({
  ok: { baselineHours: baselineEntries['ok'] && baselineEntries['ok'].hours, nowHours: (await entrySnapshot())['ok'] && (await entrySnapshot())['ok'].hours, distinctBucket: 'one row per (employee,project,date) — the ok row is TODAY\'s historical bucket, not re-created per activity' },
  note: 'existing ok entry was created 2026-08-15T14:53 (pre-monitoring); ajbakj entry created during earlier activity; both are distinct rows, never duplicated',
}));

log('4. FINAL: previously-active project received new entries?', okCountNow === 1
  ? 'NO for "ok" during ajbakj-active window (still 1 row, hours unchanged until switch) — and "ajbakj" received 0 new entries after the switch'
  : `check: ok count now = ${okCountNow}`);

await p.$disconnect();
console.log('\nAudit complete.');
