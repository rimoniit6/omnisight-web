/**
 * P3-4 — expired agent-credential sweep.
 *
 * AgentToken (device-bound bearer) and AgentSession (login-only bootstrap)
 * rows carry an `expiresAt`. Previously expired rows were only deleted lazily
 * when a stale token was next presented; the sweep deletes them in the
 * background so expired credentials never accumulate.
 *
 * Cases:
 *   - expired AgentToken rows are deleted
 *   - expired AgentSession rows are deleted
 *   - still-valid (future-expiry) rows are NEVER touched
 *   - runScheduledJobs surfaces the sweep result under the agent_token_sweep
 *     key and records it in JobRun.lastResult (observability)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_tokensweep).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_tokensweep';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-tokensweep-0123456789abcdef';
(process.env as Record<string, string>).NODE_ENV = 'test';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
});

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];

let empId: string;
let orgId: string;

before(async () => {
  db = (await import('../src/lib/db')).db;
  const org = await db.organization.create({ data: { name: 'TS Org', slug: 'ts-org', timezone: 'UTC' } });
  orgId = org.id;
  empId = (await db.employee.create({
    data: { employeeId: 'TS-EMP-1', firstName: 'T', lastName: 'Sweep', email: 'ts@example.com', organizationId: org.id, status: 'active' },
  })).id;
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch {
    /* best-effort cleanup */
  }
});

const now = new Date();

test('TS-1: expired AgentTokens are deleted, valid ones are retained', async () => {
  await db.agentToken.create({ data: { token: 'ts-expired-token-0000000000000000000000', expiresAt: new Date(now.getTime() - 60_000), employee: { connect: { id: empId } }, organization: { connect: { id: orgId } } } });
  await db.agentToken.create({ data: { token: 'ts-valid-token-00000000000000000000000', expiresAt: new Date(now.getTime() + 86_400_000), employee: { connect: { id: empId } }, organization: { connect: { id: orgId } } } });

  const { sweepExpiredAgentCredentials } = await import('../src/lib/jobs/sweep-agent-tokens');
  const result = await sweepExpiredAgentCredentials();

  assert.equal(result.expiredAgentTokens, 1, 'exactly the expired token deleted');
  assert.equal(await db.agentToken.count({ where: { token: 'ts-expired-token-0000000000000000000000' } }), 0);
  assert.equal(await db.agentToken.count({ where: { token: 'ts-valid-token-00000000000000000000000' } }), 1, 'valid token untouched');
});

test('TS-2: expired AgentSessions are deleted', async () => {
  await db.agentSession.create({ data: { token: 'ts-expired-session-0000000000000000000000', employeeId: empId, organizationId: 'x', expiresAt: new Date(now.getTime() - 60_000) } });
  await db.agentSession.create({ data: { token: 'ts-valid-session-00000000000000000000000', employeeId: empId, organizationId: 'x', expiresAt: new Date(now.getTime() + 86_400_000) } });

  const { sweepExpiredAgentCredentials } = await import('../src/lib/jobs/sweep-agent-tokens');
  const result = await sweepExpiredAgentCredentials();

  assert.equal(result.expiredAgentSessions, 1);
  assert.equal(await db.agentSession.count({ where: { token: 'ts-expired-session-0000000000000000000000' } }), 0);
  assert.equal(await db.agentSession.count({ where: { token: 'ts-valid-session-00000000000000000000000' } }), 1);
});

test('TS-3: the sweep is wired into runScheduledJobs with lease + observability', async () => {
  // Seed one expired row so the sweep has something to report.
  await db.agentToken.create({ data: { token: 'ts-job-expired-00000000000000000000000', expiresAt: new Date(now.getTime() - 60_000), employee: { connect: { id: empId } }, organization: { connect: { id: orgId } } } });

  const { runScheduledJobs } = await import('../src/lib/jobs/run');
  const result = await runScheduledJobs();

  assert.ok(result.agentTokenSweep, 'agentTokenSweep result present');
  assert.equal(result.agentTokenSweep.expiredAgentTokens, 1, 'job reported the deleted token');
  assert.equal(result.errors.some((e) => e.startsWith('agent_token_sweep')), false, 'sweep ran without error');

  const jobRun = await db.jobRun.findUnique({ where: { job: 'agent_token_sweep' } });
  assert.ok(jobRun, 'JobRun lease row created');
  assert.equal(jobRun.status, 'completed');
  const lastResult = JSON.parse(jobRun.lastResult || '{}');
  assert.equal(lastResult.expiredAgentTokens, 1, 'observability records the sweep count');
});

test('TS-4: expired+revoked web sessions are swept, live and recently-expired rows are kept', async () => {
  const user = await db.appUser.create({ data: { email: 'ts4@example.com', name: 'TS4', password: null, role: 'admin' } });
  const past = new Date(now.getTime() - 60_000);
  const future = new Date(now.getTime() + 86_400_000);

  // Expired AND revoked → deleted.
  await db.userSession.create({ data: { userId: user.id, expiresAt: past, revokedAt: past } });
  // Expired but NOT revoked (within the 30-day grace) → kept (forensic evidence).
  await db.userSession.create({ data: { userId: user.id, expiresAt: past, revokedAt: null } });
  // Unexpired → always kept.
  await db.userSession.create({ data: { userId: user.id, expiresAt: future, revokedAt: null } });

  const { sweepExpiredUserSessions } = await import('../src/lib/jobs/sweep-user-sessions');
  const result = await sweepExpiredUserSessions();

  assert.equal(result.deleted, 1, 'only the expired+revoked row deleted');
  assert.equal(await db.userSession.count({ where: { userId: user.id } }), 2, 'grace and live rows retained');

  // Wiring: runScheduledJobs surfaces userSessionSweep without error.
  const { runScheduledJobs } = await import('../src/lib/jobs/run');
  const jobs = await runScheduledJobs();
  assert.ok(jobs.userSessionSweep, 'userSessionSweep result present');
  assert.equal(jobs.errors.some((e) => e.startsWith('user_session_sweep')), false, 'session sweep ran without error');
});
