// OmniSight — PostgreSQL test-database helper (G17)
//
// Creates or drops a dedicated throwaway PostgreSQL database used by a test
// suite. Each suite owns its own database (workai_test_<suite>), so parallel
// test files never collide.
//
// `drop` terminates any lingering connections first (e.g. a Prisma pool or a
// pg_notify LISTEN socket that outlived db.$disconnect()) so the teardown
// cannot fail with "database ... is being accessed by other users" while a
// sibling test process still owns a connection. Requires PostgreSQL >= 13.
//
// Usage:
//   node scripts/pg-test-db.mjs ensure workai_test_zerotouch
//   node scripts/pg-test-db.mjs drop   workai_test_zerotouch
//
// The server connection is derived from PG_TEST_BASE_URL (default matches the
// Docker test instance used by .env): postgresql://omnisight_user:omnisight_password@127.0.0.1:5433
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

const base = process.env.PG_TEST_BASE_URL || 'postgresql://omnisight_user:omnisight_password@127.0.0.1:5433';
const baseUrl = new URL(base);
// Connect to the maintenance `postgres` database to run CREATE/DROP DATABASE.
const maintenanceUrl = (() => {
  const u = new URL(base);
  u.pathname = '/postgres';
  return u.toString();
})();

/** Explicit libpq env for psql — avoids peer-auth fallback to the OS user on CI. */
function pgClientEnv() {
  return {
    ...process.env,
    PGHOST: process.env.PGHOST || baseUrl.hostname,
    PGPORT: process.env.PGPORT || String(baseUrl.port || 5432),
    PGUSER: process.env.PGUSER || decodeURIComponent(baseUrl.username),
    PGPASSWORD: process.env.PGPASSWORD || decodeURIComponent(baseUrl.password),
    PGDATABASE: process.env.PGDATABASE || 'postgres',
  };
}

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
const psqlArgs = (sql) => ['-d', maintenanceUrl, '-tAc', sql];

// ── Docker fallback ─────────────────────────────────────────────────────────
// Hosts without a local psql client (e.g. Docker-only dev machines) can still
// administer the test server by exec-ing psql inside a running postgres
// container. Override with PG_TEST_DOCKER_CONTAINER when several are up.
function findPostgresContainer() {
  const override = process.env.PG_TEST_DOCKER_CONTAINER;
  if (override) return override;
  try {
    const out = execFileSync(
      'docker',
      ['ps', '--format', '{{.Names}}\t{{.Image}}', '--filter', 'status=running'],
      { stdio: 'pipe', encoding: 'utf8' }
    );
    const line = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .find((l) => /postgres/i.test(l));
    return line ? line.split('\t')[0] : null;
  } catch {
    return null;
  }
}

function runViaDocker(sql) {
  const container = findPostgresContainer();
  if (!container) return null;
  const args = [
    'exec',
    '-e', `PGPASSWORD=${decodeURIComponent(baseUrl.password)}`,
    container,
    'psql',
    '-U', decodeURIComponent(baseUrl.username),
    '-d', 'postgres',
    '-tAc', sql,
  ];
  try {
    return execFileSync('docker', args, { stdio: 'pipe', encoding: 'utf8' });
  } catch (err) {
    // Surface real SQL/connection failures; only ENOENT (no docker) may fall through.
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function psql(sql) {
  try {
    return execFileSync(PSQL, psqlArgs(sql), { stdio: 'pipe', encoding: 'utf8', env: pgClientEnv() });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const out = runViaDocker(sql);
      if (out !== null) return out;
    }
    throw err;
  }
}

function run(sql) {
  psql(sql);
}
function exists() {
  try {
    const out = psql(`SELECT 1 FROM pg_database WHERE datname='${dbName}'`);
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
