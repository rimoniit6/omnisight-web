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
//
// MIGRATION GUARANTEE: `ensure` runs `prisma migrate deploy` against the
// database whenever it was freshly created or lacks migration history
// (`_prisma_migrations` missing — e.g. left behind by a `db push --force-reset`
// from a previous run). Application tests therefore never start on a database
// without the full migration-plan schema, even if the owning suite's own sync
// step is skipped or fails. Suites that run their own `db push` afterwards
// simply refine the already-migrated schema. CI separately migrates the four
// fixed databases (test_server/test_unit/test_integration/test_all) — the two
// mechanisms have different responsibilities and both remain in place.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const psqlArgs = (sql, target = maintenanceUrl) => ['-d', target, '-tAc', sql];

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

function runViaDocker(sql, dbName = 'postgres') {
  let container = getDockerContainer();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!container) return null;
    const args = [
      'exec',
      '-e', `PGPASSWORD=${decodeURIComponent(baseUrl.password)}`,
      container,
      'psql',
      '-U', decodeURIComponent(baseUrl.username),
      '-d', dbName,
      '-tAc', sql,
    ];
    try {
      return execFileSync('docker', args, { stdio: 'pipe', encoding: 'utf8' });
    } catch (err) {
      // Surface real SQL/connection failures; only ENOENT (no docker) may fall through.
      if (err && err.code === 'ENOENT') return null;
      // The cached container name may be stale (container recreated) — re-probe
      // once and retry before giving up.
      dockerContainer = undefined;
      container = getDockerContainer();
      if (attempt === 1 || !container) throw err;
    }
  }
  return null;
}

// Resolve the running postgres container ONCE (with one retry) and cache it.
// Without a local psql client every SQL statement would otherwise re-run
// `docker ps`; a transient probe failure mid-run then surfaced as a fatal
// ENOENT inside the calling test suite. CI always has psql, so this cache
// only affects Docker-fallback hosts.
let dockerContainer;
function getDockerContainer() {
  if (dockerContainer === undefined) {
    dockerContainer = findPostgresContainer();
    if (!dockerContainer) dockerContainer = findPostgresContainer();
  }
  return dockerContainer;
}

function psql(sql, target) {
  try {
    return execFileSync(PSQL, psqlArgs(sql, target), { stdio: 'pipe', encoding: 'utf8', env: pgClientEnv() });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const out = runViaDocker(sql, target ? decodeURIComponent(new URL(target).pathname.slice(1)) : undefined);
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

// ── Migration (fresh/empty databases) ──────────────────────────────────────
// Repo root = parent of scripts/, so `bun run db:deploy` resolves package.json
// even when the helper is invoked from another working directory.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbUrl = `${base}/${dbName}?schema=public`; // for Prisma (schema param)
const dbConnString = `${base}/${dbName}`; // for psql (libpq ignores no query params)

function hasMigrationsTable() {
  try {
    return psql(`SELECT to_regclass('public._prisma_migrations') IS NOT NULL`, dbConnString).trim() === 't';
  } catch {
    return false;
  }
}

/** True when application tables already exist (e.g. a `db push --force-reset`
 * leftover from a previous run). Such databases have no `_prisma_migrations`
 * history and `migrate deploy` CANNOT succeed on them (the initial migration
 * would collide with the existing tables) — their owning suite re-syncs them
 * with its own `db push`, so the helper must leave them untouched. */
function hasApplicationTables() {
  try {
    return psql(`SELECT to_regclass('public."Organization"') IS NOT NULL`, dbConnString).trim() === 't';
  } catch {
    return false;
  }
}

function migrateDatabase() {
  const env = { ...process.env, DATABASE_URL: dbUrl, DIRECT_URL: dbUrl };
  try {
    execFileSync('bun', ['run', 'db:deploy'], { cwd: repoRoot, env, stdio: 'inherit' });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // bun not on PATH — fall back to the Prisma CLI via npx.
      execFileSync('npx', ['prisma', 'migrate', 'deploy'], { cwd: repoRoot, env, stdio: 'inherit', shell: process.platform === 'win32' });
    } else {
      throw err;
    }
  }
}

if (action === 'ensure') {
  let created = false;
  if (!exists()) {
    run(`CREATE DATABASE "${dbName}"`);
    created = true;
  }
  // Migrate ONLY databases the deploy can actually succeed on: a freshly
  // created (empty) one, or an existing one that is still empty. A reused
  // push-provisioned database (app tables, no migration history) is skipped —
  // deploying there would crash on the initial migration; its suite re-pushes
  // it as before.
  if (created || (!hasMigrationsTable() && !hasApplicationTables())) {
    try {
      migrateDatabase();
    } catch (err) {
      // Non-fatal: the owning suite's own schema sync remains the fallback.
      console.error(`[pg-test-db] WARNING: migrate deploy failed for ${dbName} — leaving provisioning to the owning suite (${err.message})`);
    }
  }
  console.log(`postgres test db ensured${created ? ' (created + migrated)' : ''}: ${dbName}`);
} else {
  run(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  console.log(`postgres test db dropped: ${dbName}`);
}
