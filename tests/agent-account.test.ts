/**
 * Phase 1 — Agent Account (Employee Agent Authentication).
 *
 * Covers the phase requirements:
 *   1.  AgentAccount is 1:1 with Employee.
 *   2.  agentId defaults to Employee.employeeId.
 *   3.  Passwords are bcrypt — never plaintext, never returned.
 *   4.  Password policy (>=12, upper, lower, digit) enforced on create/reset.
 *   5.  Disabled account cannot authenticate.
 *   6.  Lockout: N failed logins -> account locked; correct password rejected
 *       while locked; successful login resets the counter and records lastLogin.
 *   7.  Legacy plaintext credentials (backfilled by the migration) verify and
 *       are upgraded to bcrypt in place.
 *   8.  No agentId can be duplicated.
 *   9.  A second account for the same employee is rejected (1:1).
 *  10.  Creating an account for a missing employee fails.
 *  11.  Reset password changes the hash and clears lockout; old password fails.
 *  12.  Uniform login failure (no enumeration: missing account vs wrong
 *       password return the same shape).
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_agentaccount).
 * Run: npm run test:agent-account  (or npx tsx --test tests/agent-account.test.ts)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_agentaccount';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-agentaccount-0123456789abcdef';
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
let agentAccountService: typeof import('../src/lib/agent-account');
let verifyPassword: (password: string, hash: string) => Promise<boolean>;

let org: { id: string };

before(async () => {
  db = (await import('../src/lib/db')).db;
  agentAccountService = await import('../src/lib/agent-account');
  verifyPassword = (await import('../src/lib/auth')).verifyPassword;

  org = await db.organization.create({ data: { name: 'AA Org', slug: 'aa-org' } });
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

async function seedEmployee(code: string, opts: { agentPassword?: string | null; status?: string } = {}) {
  return db.employee.create({
    data: {
      employeeId: code,
      firstName: code.split('-')[0],
      lastName: 'Test',
      email: `${code.toLowerCase()}@test.local`,
      organizationId: org.id,
      status: opts.status ?? 'active',
      agentApproved: false,
      agentPassword: opts.agentPassword ?? null,
    },
  });
}

// ─── 1–2: 1:1 relation + default agentId ───────────────────────────────────

test('AA-1: create account is 1:1 with employee and agentId defaults to employeeId', async () => {
  const emp = await seedEmployee('AA1-EMP');
  const acct = await agentAccountService.createAgentAccount({
    employeeId: emp.id,
    password: 'Str0ng!Pass123x',
  });
  assert.equal(acct.employeeId, emp.id);
  assert.equal(acct.agentId, 'AA1-EMP', 'agentId defaults to Employee.employeeId');
  assert.equal(acct.status, 'active');
  assert.ok(acct.passwordChangedAt, 'passwordChangedAt set on create');

  const row = await db.agentAccount.findUnique({ where: { id: acct.id } });
  assert.ok(row);
  assert.notEqual(row!.passwordHash, 'Str0ng!Pass123x', 'never stored plaintext');
  assert.match(row!.passwordHash, /^\$2[aby]\$/, 'bcrypt hash');
  assert.equal(await verifyPassword('Str0ng!Pass123x', row!.passwordHash!), true);
});

test('AA-2: second account for the same employee is rejected (1:1 unique)', async () => {
  const emp = await seedEmployee('AA2-EMP');
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });
  await assert.rejects(
    () => agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass456x' }),
    (err: unknown) => (err as { code?: string }).code === 'P2002' || (err as { code?: string }).code === undefined,
    'duplicate employeeId must fail'
  );
});

// ─── 3–4: hashing + password policy ────────────────────────────────────────

test('AA-3: password policy enforced on create', async () => {
  const emp = await seedEmployee('AA3-EMP');
  for (const bad of ['short', 'alllowercase1234', 'NOLOWERCASE1234', 'NoNumbersAtAll!']) {
    await assert.rejects(
      () => agentAccountService.createAgentAccount({ employeeId: emp.id, password: bad }),
      (err: unknown) => (err as { code?: string }).code === 'INVALID_PASSWORD',
      `password "${bad}" must be rejected`
    );
  }
});

test('AA-4: account for missing employee fails', async () => {
  await assert.rejects(
    () => agentAccountService.createAgentAccount({ employeeId: 'no-such-employee-id', password: 'Str0ng!Pass123x' }),
    (err: unknown) => (err as { code?: string }).code === 'EMPLOYEE_NOT_FOUND'
  );
});

// ─── 5: disabled account cannot authenticate ───────────────────────────────

test('AA-5: disabled account fails authentication with uniform failure', async () => {
  const emp = await seedEmployee('AA5-EMP');
  const acct = await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });
  await agentAccountService.setAgentAccountStatus(acct.id, 'disabled');

  const result = await agentAccountService.verifyAgentCredential({ agentId: 'AA5-EMP', password: 'Str0ng!Pass123x' });
  assert.equal(result.ok, false, 'disabled account must not authenticate');
  if (!result.ok) {
    assert.equal(result.locked, false);
  }
});

// ─── 6: lockout + counter reset + lastLogin ────────────────────────────────

test('AA-6: repeated failures lock the account; success resets and records lastLogin', async () => {
  const emp = await seedEmployee('AA6-EMP');
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });

  const maxFails = agentAccountService.AGENT_ACCOUNT.MAX_FAILED_LOGINS;
  for (let i = 0; i < maxFails; i++) {
    const r = await agentAccountService.verifyAgentCredential({ agentId: 'AA6-EMP', password: 'wrong-password!' });
    assert.equal(r.ok, false);
  }

  // Locked: even the correct password is rejected while locked.
  const locked = await agentAccountService.verifyAgentCredential({ agentId: 'AA6-EMP', password: 'Str0ng!Pass123x' });
  assert.equal(locked.ok, false, 'locked account rejects the correct password');
  if (!locked.ok) {
    assert.equal(locked.locked, true);
    assert.ok(locked.retryAfterSeconds !== null && locked.retryAfterSeconds > 0);
  }

  const row = await db.agentAccount.findUnique({ where: { agentId: 'AA6-EMP' } });
  assert.equal(row!.failedLoginCount, maxFails);
  assert.ok(row!.lockedUntil, 'lockedUntil set');

  // Admin resets the lockout via password reset (the intended recovery path).
  await agentAccountService.resetAgentAccountPassword(row!.id, 'New!Strong123x');
  const afterReset = await agentAccountService.verifyAgentCredential({ agentId: 'AA6-EMP', password: 'Str0ng!Pass123x' });
  assert.equal(afterReset.ok, false, 'old password no longer works after reset');

  const ok = await agentAccountService.verifyAgentCredential({ agentId: 'AA6-EMP', password: 'New!Strong123x' });
  assert.equal(ok.ok, true, 'new password works after reset');
  if (ok.ok) {
    assert.equal(ok.account.failedLoginCount, 0, 'counter cleared on success');
    assert.ok(ok.account.lastLoginAt, 'lastLoginAt recorded');
  }
});

// ─── 7: legacy plaintext upgrade ───────────────────────────────────────────

test('AA-7: legacy plaintext credential verifies and upgrades to bcrypt in place', async () => {
  // Simulate a legacy employee credential (what the migration would backfill).
  const emp = await seedEmployee('AA7-EMP', { agentPassword: 'LegacyPlain123!' });
  await db.agentAccount.create({
    data: {
      employeeId: emp.id,
      agentId: emp.employeeId,
      passwordHash: 'LegacyPlain123!', // non-$2 → legacy plaintext path
      status: 'active',
    },
  });

  const r1 = await agentAccountService.verifyAgentCredential({ agentId: 'AA7-EMP', password: 'LegacyPlain123!' });
  assert.equal(r1.ok, true, 'legacy plaintext must verify');

  const row = await db.agentAccount.findUnique({ where: { agentId: 'AA7-EMP' } });
  assert.match(row!.passwordHash, /^\$2[aby]\$/, 'upgraded to bcrypt');
  assert.notEqual(row!.passwordHash, 'LegacyPlain123!');
});

// ─── 8–9: uniqueness ───────────────────────────────────────────────────────

test('AA-8: duplicate agentId is rejected', async () => {
  const empA = await seedEmployee('AA8-EMPA');
  const empB = await seedEmployee('AA8-EMPB');
  await agentAccountService.createAgentAccount({ employeeId: empA.id, agentId: 'SHARED-ID', password: 'Str0ng!Pass123x' });
  await assert.rejects(
    () => agentAccountService.createAgentAccount({ employeeId: empB.id, agentId: 'SHARED-ID', password: 'Str0ng!Pass123x' }),
    (err: unknown) => (err as { code?: string }).code === 'P2002' || (err as { code?: string }).code === undefined,
    'duplicate agentId must fail'
  );
});

test('AA-9: no public API shape exposes the password hash', async () => {
  const emp = await seedEmployee('AA9-EMP');
  const acct = await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });
  const serialized = JSON.stringify(acct);
  assert.ok(!serialized.includes('passwordHash'), 'public account must not include passwordHash');
  assert.ok(!serialized.includes('Str0ng!Pass123x'), 'public account must not include the password value');
  assert.ok(!serialized.includes('$2'), 'public account must not include a bcrypt hash');

  const fetched = await agentAccountService.getAgentAccount(acct.id);
  assert.equal(JSON.stringify(fetched).includes('passwordHash'), false);
});

// ─── 11: reset password semantics ──────────────────────────────────────────

test('AA-11: reset changes the hash, clears lockout, rejects old password', async () => {
  const emp = await seedEmployee('AA11-EMP');
  const acct = await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Old!Pass12345' });
  const hashBefore = (await db.agentAccount.findUnique({ where: { id: acct.id } }))!.passwordHash;

  const reset = await agentAccountService.resetAgentAccountPassword(acct.id, 'New!Pass12345');
  assert.ok(reset.passwordChangedAt, 'passwordChangedAt updated');
  const hashAfter = (await db.agentAccount.findUnique({ where: { id: acct.id } }))!.passwordHash;
  assert.notEqual(hashAfter, hashBefore, 'hash must change');

  const old = await agentAccountService.verifyAgentCredential({ agentId: 'AA11-EMP', password: 'Old!Pass12345' });
  assert.equal(old.ok, false);
  const fresh = await agentAccountService.verifyAgentCredential({ agentId: 'AA11-EMP', password: 'New!Pass12345' });
  assert.equal(fresh.ok, true);
});

// ─── 12: uniform failure — no account enumeration ──────────────────────────

test('AA-12: missing account and wrong password return the same failure shape', async () => {
  const emp = await seedEmployee('AA12-EMP');
  await agentAccountService.createAgentAccount({ employeeId: emp.id, password: 'Str0ng!Pass123x' });

  const missing = await agentAccountService.verifyAgentCredential({ agentId: 'NO-SUCH-AGENT', password: 'Str0ng!Pass123x' });
  const wrong = await agentAccountService.verifyAgentCredential({ agentId: 'AA12-EMP', password: 'totally-wrong!' });

  assert.equal(missing.ok, false);
  assert.equal(wrong.ok, false);
  if (!missing.ok && !wrong.ok) {
    assert.equal(missing.locked, wrong.locked, 'same locked flag');
    assert.equal(missing.retryAfterSeconds, wrong.retryAfterSeconds, 'same retry field');
  }
});
