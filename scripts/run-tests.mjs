// Cross-platform runner for the unit/integration suite (tests/*.test.ts).
//
// `node --test` runs each file in a separate process — required because the
// suites set process.env.DATABASE_URL to per-suite throwaway databases BEFORE
// importing app modules (they cannot share one process). Windows cmd.exe does
// not expand `tests/*.test.ts` globs, so the glob is expanded here instead.
//
// The suite hits the live app on :3000 for ~60% of files — boot the dev
// server first (`npm run dev`), then run this. Exit code is non-zero if any
// suite fails.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files = readdirSync('tests')
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

// Ensure every suite runs against the Docker test database by default. Each
// test file reads PG_TEST_BASE_URL first and only falls back to a native
// localhost:5432 default when this variable is absent — always provide it so
// accidental use of a native PostgreSQL instance is avoided. CI overrides it.
const PG_TEST_BASE_URL =
  process.env.PG_TEST_BASE_URL ||
  (() => {
    const dockerBase = 'postgresql://omnisight_user:omnisight_password@127.0.0.1:5433';
    console.log(`[run-tests] PG_TEST_BASE_URL unset — defaulting to the Docker test database (${dockerBase})`);
    return dockerBase;
  })();

let failed = 0;
for (const file of files) {
  process.stdout.write(`\n=== tests/${file} ===\n`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', `tests/${file}`], {
    stdio: 'inherit',
    env: { ...process.env, PG_TEST_BASE_URL },
  });
  if (r.status !== 0) {
    failed += 1;
    console.error(`FAIL: tests/${file} (exit ${r.status})`);
  }
}

console.log(`\n[run-tests] ${files.length - failed}/${files.length} suites passed`);
process.exit(failed > 0 ? 1 : 0);