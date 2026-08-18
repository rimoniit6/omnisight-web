#!/usr/bin/env node
/**
 * Dev-only Prisma schema push with a hard production guard.
 *
 * `prisma db push` has no migration history and can destroy data, so it is
 * NEVER safe against a production database. This wrapper:
 *   1. refuses to run when NODE_ENV === 'production';
 *   2. prints a loud warning and requires an explicit `--yes` confirmation
 *      (deliberate friction — this command must never be a muscle-memory
 *      default);
 *   3. otherwise runs `npx prisma db push --accept-data-loss`.
 *
 * Production deployments MUST use:  npx prisma migrate deploy
 * (see `npm run db:deploy`).
 */
import { execSync } from 'node:child_process';

const nodeEnv = process.env.NODE_ENV;
const isProd = nodeEnv === 'production';

if (isProd) {
  console.error('[db-push:dev] REFUSING to run: NODE_ENV=production.');
  console.error('[db-push:dev] Use `npm run db:deploy` (npx prisma migrate deploy) instead.');
  process.exit(1);
}

if (!process.argv.includes('--yes')) {
  console.error('[db-push:dev] WARNING: `prisma db push` is DEV-ONLY. It has no migration');
  console.error('[db-push:dev] history and can destroy data. Confirm you are on a throwaway');
  console.error('[db-push:dev] or development database by re-running with `--yes`.');
  console.error('[db-push:dev]   npm run db:push:dev -- --yes');
  process.exit(1);
}

// Second line of defense (NODE_ENV is frequently UNSET on Windows): only a
// local database may be pushed. A remote/production-looking host is refused
// unless --force is explicitly supplied.
const dbUrl = process.env.DATABASE_URL || '';
let dbHost = '';
try {
  dbHost = new URL(dbUrl).hostname;
} catch {
  dbHost = '';
}
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
if (!LOCAL_HOSTS.has(dbHost) && !process.argv.includes('--force')) {
  console.error(`[db-push:dev] REFUSING to run: DATABASE_URL host "${dbHost || '(unset/invalid)'}" is not local.`);
  console.error('[db-push:dev] db push must only ever target a local development database.');
  console.error('[db-push:dev] Re-run with --force ONLY if you are certain this is a throwaway dev DB.');
  process.exit(1);
}

console.warn('[db-push:dev] Running `prisma db push --accept-data-loss` against the configured DATABASE_URL…');
execSync('npx prisma db push --accept-data-loss', { stdio: 'inherit' });
