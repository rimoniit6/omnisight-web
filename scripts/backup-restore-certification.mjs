// OmniSight — Backup/Restore Certification (SQLite, current production DB)
//
// Real evidence for workload/52: BACKUP → DELETE/RESET test DB → RESTORE →
// verify integrity + row counts + representative queries.
//
// Uses Node's built-in `node:sqlite` (requires Node >= 22.5; experimental
// warning is expected). Safe: it operates on COPIES of the live DB, never on
// db/custom.db itself. Writes artifacts under os.tmpdir() so no binaries ever
// land in the tracked db/ folder.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, statSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// NOTE: this certification targets the current production DB file. If
// DATABASE_URL ever points elsewhere, pass the path as argv[2].
const live = process.argv[2] || join(root, 'db', 'custom.db');
const workDir = mkdtempSync(join(tmpdir(), 'wls-backup-cert-'));
const backup = join(workDir, 'cert-backup.sqlite3');
const testDb = join(workDir, 'cert-restore-test.sqlite3');

if (!existsSync(live)) {
  console.error('LIVE DB NOT FOUND at', live);
  process.exit(1);
}

/** Full SQLite-backed backup via VACUUM INTO (consistent, compact copy).
 *  The destination path is embedded as a literal — validated here to contain
 *  only path-safe characters (no single quotes), so there is no injection. */
function backupDb(src, dst) {
  if (/['"]/.test(dst)) throw new Error('unsafe backup path: ' + dst);
  const t0 = Date.now();
  const s = new DatabaseSync(src, { readOnly: true });
  s.exec(`VACUUM INTO '${dst}'`);
  s.close();
  return Date.now() - t0;
}

/** Row counts for every table. */
function rowCounts(path) {
  const s = new DatabaseSync(path, { readOnly: true });
  const tables = s
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const counts = {};
  for (const t of tables) {
    try {
      counts[t] = s.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
    } catch {
      counts[t] = 'ERR';
    }
  }
  s.close();
  return counts;
}

function integrity(path) {
  const s = new DatabaseSync(path, { readOnly: true });
  const r = s.prepare('PRAGMA integrity_check').get();
  s.close();
  return r;
}

// ── 1. BACKUP ────────────────────────────────────────────────────────────────
console.log('[1] BACKUP');
const liveSize = statSync(live).size;
const backupMs = backupDb(live, backup);
const backupSize = statSync(backup).size;
console.log(`    live db size  : ${liveSize} bytes`);
console.log(`    backup size   : ${backupSize} bytes (${((backupSize / liveSize) * 100).toFixed(1)}% of live)`);
console.log(`    backup time   : ${backupMs} ms`);
console.log(`    backup integrity: ${JSON.stringify(integrity(backup))}`);

// ── 2. DELETE / RESET TEST DB (simulate data-loss event) ────────────────────
console.log('[2] RESET test database (simulating a data-loss event)');
if (existsSync(testDb)) unlinkSync(testDb);
new DatabaseSync(testDb).close(); // create empty DB
console.log(`    empty test db created (${statSync(testDb).size} bytes)`);

// ── 3. RESTORE ───────────────────────────────────────────────────────────────
console.log('[3] RESTORE backup into test db');
const tRestore0 = Date.now();
copyFileSync(backup, testDb);
const restoreMs = Date.now() - tRestore0;
console.log(`    restore time  : ${restoreMs} ms`);
console.log(`    restored size : ${statSync(testDb).size} bytes`);
console.log(`    restore integrity: ${JSON.stringify(integrity(testDb))}`);

// ── 4. VERIFY: row counts match live ─────────────────────────────────────────
console.log('[4] VERIFY row counts (live vs restored)');
const liveCounts = rowCounts(live);
const restoredCounts = rowCounts(testDb);
const allTables = new Set([...Object.keys(liveCounts), ...Object.keys(restoredCounts)]);
let mismatches = 0;
for (const t of [...allTables].sort()) {
  const a = liveCounts[t] ?? 0;
  const b = restoredCounts[t] ?? 0;
  const ok = a === b;
  if (!ok) mismatches++;
  console.log(`    ${ok ? 'OK ' : 'MISMATCH'} ${t.padEnd(32)} live=${a} restored=${b}`);
}
console.log(mismatches === 0 ? '    ALL TABLES MATCH' : `    ${mismatches} TABLE MISMATCHES`);

// ── 5. VERIFY: representative application queries work on the restored DB ────
console.log('[5] REPRESENTATIVE QUERIES on restored db');
const q = new DatabaseSync(testDb, { readOnly: true });
const orgs = q.prepare('SELECT COUNT(*) AS c FROM Organization').get().c;
const devices = q.prepare('SELECT COUNT(*) AS c FROM Device').get().c;
const claims = q.prepare('SELECT COUNT(*) AS c FROM DeviceClaim').get().c;
const tokens = q.prepare('SELECT COUNT(*) AS c FROM AgentToken').get().c;
const consents = q.prepare('SELECT COUNT(*) AS c FROM Consent').get().c;
const consentLogs = q.prepare('SELECT COUNT(*) AS c FROM ConsentLog').get().c;
const consentPolicies = q.prepare('SELECT COUNT(*) AS c FROM ConsentPolicy').get().c;
const activities = q.prepare('SELECT COUNT(*) AS c FROM Activity').get().c;
const screenshots = q.prepare('SELECT COUNT(*) AS c FROM Screenshot').get().c;
const audit = q.prepare('SELECT COUNT(*) AS c FROM AuditLog').get().c;
const projects = q.prepare('SELECT COUNT(*) AS c FROM Project').get().c;
const members = q.prepare('SELECT COUNT(*) AS c FROM ProjectMember').get().c;
q.close();
console.log(`    organizations=${orgs} devices=${devices} claims=${claims} tokens=${tokens}`);
console.log(`    consents=${consents} consentLogs=${consentLogs} policies=${consentPolicies}`);
console.log(`    activities=${activities} screenshots=${screenshots} audit=${audit}`);
console.log(`    projects=${projects} members=${members}`);

// ── 6. VERIFY: zero-touch discovery would see the restored claim data ───────
console.log('[6] ZERO-TOUCH surface check on restored db');
const z = new DatabaseSync(testDb, { readOnly: true });
const pending = z.prepare("SELECT COUNT(*) AS c FROM DeviceClaim WHERE status='pending'").get().c;
const approved = z.prepare("SELECT COUNT(*) AS c FROM DeviceClaim WHERE status='approved'").get().c;
z.close();
console.log(`    pending claims=${pending} approved claims=${approved}`);

const pass = mismatches === 0;
console.log(pass ? '\n=== BACKUP/RESTORE CERTIFICATION: PASS ===' : '\n=== BACKUP/RESTORE CERTIFICATION: FAIL ===');
// Clean up the temp artifacts (evidence is recorded in the log above).
for (const f of [backup, testDb]) {
  try { unlinkSync(f); } catch { /* best-effort */ }
}
process.exit(pass ? 0 : 1);
