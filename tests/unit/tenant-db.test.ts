// Phase 1 Step 12: tenant-db fail-closed unit tests (no live DB required).
// Only the error contract is tested here; routing against real databases is
// covered by the DB-backed deployment-mode-switch suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TenantDatabaseError } from '../../src/lib/tenant-db';

test('TenantDatabaseError carries code and is fail-closed (no fallback hint)', () => {
  const err = new TenantDatabaseError('CUSTOMER_DB_NOT_CONFIGURED', 'org-1');
  assert.equal(err.name, 'TenantDatabaseError');
  assert.equal(err.code, 'CUSTOMER_DB_NOT_CONFIGURED');
  assert.match(err.message, /fail-closed/);
  assert.match(err.message, /org-1/);
  assert.match(err.message, /no fallback/);
});

test('TenantDatabaseError supports all three failure codes', () => {
  for (const code of ['MODE_UNRESOLVABLE', 'CUSTOMER_DB_NOT_CONFIGURED', 'PRIVATE_DB_NOT_REACHABLE'] as const) {
    const err = new TenantDatabaseError(code, 'org-x', 'detail');
    assert.equal(err.code, code);
    assert.match(err.message, /detail/);
  }
});
