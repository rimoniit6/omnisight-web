// Phase 1 Step 12: deployment-mode unit tests (no DB required).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isDeploymentMode,
  allowsSuperAdminTenantAccess,
  CONTROL_PLANE_ORG_FIELDS,
  DATA_PLANE_MODELS,
  DEPLOYMENT_MODES,
} from '../../src/lib/deployment-mode';

test('DEPLOYMENT_MODES contains exactly MANAGED, CUSTOMER_DB, PRIVATE', () => {
  assert.deepEqual([...DEPLOYMENT_MODES].sort(), ['CUSTOMER_DB', 'MANAGED', 'PRIVATE']);
});

test('isDeploymentMode accepts only the three canonical modes', () => {
  assert.equal(isDeploymentMode('MANAGED'), true);
  assert.equal(isDeploymentMode('CUSTOMER_DB'), true);
  assert.equal(isDeploymentMode('PRIVATE'), true);
  assert.equal(isDeploymentMode('SELF_HOSTED'), false);
  assert.equal(isDeploymentMode('managed'), false);
  assert.equal(isDeploymentMode(''), false);
  assert.equal(isDeploymentMode(null), false);
  assert.equal(isDeploymentMode(undefined), false);
  assert.equal(isDeploymentMode(42), false);
});

test('allowsSuperAdminTenantAccess: only MANAGED', () => {
  assert.equal(allowsSuperAdminTenantAccess('MANAGED'), true);
  assert.equal(allowsSuperAdminTenantAccess('CUSTOMER_DB'), false);
  assert.equal(allowsSuperAdminTenantAccess('PRIVATE'), false);
});

test('CONTROL_PLANE_ORG_FIELDS excludes data-plane identifiers', () => {
  const fields = [...CONTROL_PLANE_ORG_FIELDS];
  assert.ok(fields.includes('deploymentMode'), 'mode must be control-plane visible');
  assert.ok(fields.includes('subscriptionId'), 'subscription must be control-plane visible');
  assert.ok(!fields.includes('screenshotInterval'), 'screenshot cadence is operational config, not metadata');
  for (const f of ['employees', 'screenshots', 'activities']) {
    assert.ok(!fields.includes(f as never), `${f} must never be control-plane`);
  }
});

test('DATA_PLANE_MODELS covers all employee monitoring data', () => {
  const models = [...DATA_PLANE_MODELS];
  for (const m of ['employee', 'device', 'activity', 'screenshot', 'locationEvent', 'audioRecording', 'project']) {
    assert.ok(models.includes(m as never), `${m} must be classified data-plane`);
  }
});
