// Phase 1 Step 12: tenant-scope helper unit tests (no DB required).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withTenantScope,
  assertTenantScope,
  TENANT_SCOPED_MODELS,
} from '../../src/lib/tenant-scope';

test('withTenantScope injects organizationId', () => {
  const out = withTenantScope({ id: 'abc' }, 'org-1');
  assert.deepEqual(out, { id: 'abc', organizationId: 'org-1' });
});

test('withTenantScope: organizationId always wins over existing value', () => {
  const out = withTenantScope({ id: 'abc', organizationId: 'evil-org' }, 'org-1');
  assert.equal(out.organizationId, 'org-1', 'client-influenced value must never widen scope');
});

test('assertTenantScope passes on matching scope', () => {
  assert.doesNotThrow(() =>
    assertTenantScope({ id: 'abc', organizationId: 'org-1' }, 'org-1'),
  );
});

test('assertTenantScope throws fail-closed on missing organizationId', () => {
  assert.throws(
    () => assertTenantScope({ id: 'abc' }, 'org-1'),
    /fail-closed/,
  );
});

test('assertTenantScope throws fail-closed on mismatched org', () => {
  assert.throws(
    () => assertTenantScope({ id: 'abc', organizationId: 'other' }, 'org-1'),
    /fail-closed/,
  );
});

test('assertTenantScope throws fail-closed on empty caller org', () => {
  assert.throws(
    () => assertTenantScope({ id: 'abc', organizationId: 'org-1' }, ''),
    /fail-closed/,
  );
});

test('TENANT_SCOPED_MODELS includes activity and hardened FK models', () => {
  const models = [...TENANT_SCOPED_MODELS];
  for (const m of ['activity', 'screenshot', 'usbEvent', 'policyViolation', 'appListEntry', 'consentLog']) {
    assert.ok(models.includes(m as never), `${m} must be tenant-scoped`);
  }
});
