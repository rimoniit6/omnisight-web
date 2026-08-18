// OmniSight — PostgreSQL test-database helper (G17)
//
// Creates or drops a dedicated throwaway PostgreSQL database used by a test
// suite. Each suite owns its own database (workai_test_<suite>), so parallel
// test files never collide.
//
// Usage:
//   node scripts/pg-test-db.mjs ensure workai_test_zerotouch
//   node scripts/pg-test-db.mjs drop   workai_test_zerotouch
//
// The server connection is derived from PG_TEST_BASE_URL (default matches the
// local dev instance used by .env): postgresql://postgres:123456@localhost:5432
// The helper connects to the maintenance database `postgres` to run CREATE /
// DROP DATABASE (these cannot run inside a transaction).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const [action, dbName] = process.argv.slice(2);
if (!['ensure', 'drop'].includes(action) || !dbName || !/^[a-z0-9_]+$/.test(dbName)) {
  console.error('usage: node scripts/pg-test-db.mjs <ensure|drop> <dbname>');
  process.exit(2);
}

const base = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
// Connect to the maintenance `postgres` database to run CREATE/DROP DATABASE.
const maintenanceUrl = (() => {
  const u = new URL(base);
  u.pathname = '/postgres';
  return u.toString();
})();

function findPsql() {
  try {
    execFileSync('psql', ['--version'], { stdio: 'pipe' });
    return 'psql';
  } catch {
    /* not on PATH — probe common Windows install paths */
  }
  const baseDir = 'C:/Program Files/PostgreSQL';
  if (existsSync(baseDir)) {
    for (const v of ['18', '17', '16', '15', '14', '13']) {
      const p = join(baseDir, v, 'bin', 'psql.exe');
      if (existsSync(p)) return p;
    }
  }
  return 'psql';
}

const PSQL = findPsql();
function run(sql) {
  execFileSync(PSQL, [maintenanceUrl, '-tAc', sql], { stdio: 'pipe' });
}
function exists() {
  try {
    const out = execFileSync(PSQL, [maintenanceUrl, '-tAc', `SELECT 1 FROM pg_database WHERE datname='${dbName}'`], { stdio: 'pipe', encoding: 'utf8' });
    return out.trim() === '1';
  } catch {
    return false;
  }
}

if (action === 'ensure') {
  if (!exists()) run(`CREATE DATABASE "${dbName}"`);
  console.log(`postgres test db ensured: ${dbName}`);
} else {
  run(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  console.log(`postgres test db dropped: ${dbName}`);
}
