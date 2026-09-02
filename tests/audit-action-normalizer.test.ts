/**
 * Audit Action Normalizer — regression tests
 *
 * Verifies the canonical action normalization layer that prevents
 * raw/internal action identifiers from leaking into Action Distribution.
 *
 * Run: npx tsx --test tests/audit-action-normalizer.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAuditAction,
  aggregateActionDistribution,
  ACTION_DISPLAY_LABELS,
  type CanonicalAction,
} from '../src/lib/audit-action-normalizer';

// ─── Canonical actions — standard CRUD/Auth/Config ──────────────────────────

test('NORM-01: create → Create', () => {
  assert.equal(normalizeAuditAction('create'), 'Create');
});

test('NORM-02: update → Update', () => {
  assert.equal(normalizeAuditAction('update'), 'Update');
});

test('NORM-03: delete → Delete', () => {
  assert.equal(normalizeAuditAction('delete'), 'Delete');
});

test('NORM-04: login → Login', () => {
  assert.equal(normalizeAuditAction('login'), 'Login');
});

test('NORM-05: logout → Logout', () => {
  assert.equal(normalizeAuditAction('logout'), 'Logout');
});

test('NORM-06: export → Export', () => {
  assert.equal(normalizeAuditAction('export'), 'Export');
});

test('NORM-07: configure → Configure', () => {
  assert.equal(normalizeAuditAction('configure'), 'Configure');
});

// ─── Raw/internal actions — the problematic values ─────────────────────────

test('NORM-08: AI_ANALYSIS_GENERATED → AI Analysis', () => {
  assert.equal(normalizeAuditAction('AI_ANALYSIS_GENERATED'), 'AI Analysis');
});

test('NORM-09: DATA_SUMMARY_GENERATED → AI Analysis', () => {
  assert.equal(normalizeAuditAction('DATA_SUMMARY_GENERATED'), 'AI Analysis');
});

test('NORM-10: detect → Detect', () => {
  assert.equal(normalizeAuditAction('detect'), 'Detect');
});

test('NORM-11: ACTIVE_TRACKING_PROJECT_SET → Create', () => {
  assert.equal(normalizeAuditAction('ACTIVE_TRACKING_PROJECT_SET'), 'Create');
});

test('NORM-12: ACTIVE_TRACKING_PROJECT_CHANGED → Update', () => {
  assert.equal(normalizeAuditAction('ACTIVE_TRACKING_PROJECT_CHANGED'), 'Update');
});

test('NORM-13: ACTIVE_TRACKING_PROJECT_CLEARED → Delete', () => {
  assert.equal(normalizeAuditAction('ACTIVE_TRACKING_PROJECT_CLEARED'), 'Delete');
});

test('NORM-14: blocked → Other', () => {
  assert.equal(normalizeAuditAction('blocked'), 'Other');
});

test('NORM-15: import → Import', () => {
  assert.equal(normalizeAuditAction('import'), 'Import');
});

test('NORM-16: reset → Reset', () => {
  assert.equal(normalizeAuditAction('reset'), 'Reset');
});

test('NORM-17: revoke → Revoke', () => {
  assert.equal(normalizeAuditAction('revoke'), 'Revoke');
});

// ─── Case normalization ─────────────────────────────────────────────────────

test('NORM-18: case-insensitive — CREATE → Create', () => {
  assert.equal(normalizeAuditAction('CREATE'), 'Create');
});

test('NORM-19: case-insensitive — Create → Create', () => {
  assert.equal(normalizeAuditAction('Create'), 'Create');
});

test('NORM-20: case-insensitive — ai_analysis_generated → AI Analysis', () => {
  assert.equal(normalizeAuditAction('ai_analysis_generated'), 'AI Analysis');
});

test('NORM-21: case-insensitive — Ai_Analysis_Generated → AI Analysis', () => {
  assert.equal(normalizeAuditAction('Ai_Analysis_Generated'), 'AI Analysis');
});

test('NORM-22: whitespace trimmed — "  create  " → Create', () => {
  assert.equal(normalizeAuditAction('  create  '), 'Create');
});

// ─── Unknown/future actions ─────────────────────────────────────────────────

test('NORM-23: unknown action → Other (deterministic)', () => {
  assert.equal(normalizeAuditAction('totally_new_action_2027'), 'Other');
});

test('NORM-24: empty string → Other', () => {
  assert.equal(normalizeAuditAction(''), 'Other');
});

test('NORM-25: future action with special chars → Other', () => {
  assert.equal(normalizeAuditAction('SOME_NEW_INTERNAL_V2'), 'Other');
});

// ─── Aggregation ────────────────────────────────────────────────────────────

test('NORM-AGG-01: CREATE_USER + CREATE_PROJECT + CREATE_DEVICE → Create=3', () => {
  const result = aggregateActionDistribution({
    CREATE_USER: 1,
    CREATE_PROJECT: 1,
    CREATE_DEVICE: 1,
  });
  assert.deepEqual(result, { Create: 3 });
});

test('NORM-AGG-02: mixed standard actions aggregate correctly', () => {
  const result = aggregateActionDistribution({
    create: 10,
    update: 5,
    delete: 3,
    login: 8,
    logout: 2,
    export: 1,
    configure: 4,
  });
  assert.deepEqual(result, {
    Create: 10,
    Update: 5,
    Delete: 3,
    Login: 8,
    Logout: 2,
    Export: 1,
    Configure: 4,
  });
});

test('NORM-AGG-03: AI_ANALYSIS_GENERATED + DATA_SUMMARY_GENERATED → AI Analysis', () => {
  const result = aggregateActionDistribution({
    AI_ANALYSIS_GENERATED: 12,
    DATA_SUMMARY_GENERATED: 5,
  });
  assert.deepEqual(result, { 'AI Analysis': 17 });
});

test('NORM-AGG-04: full realistic distribution — no raw values leak through', () => {
  const result = aggregateActionDistribution({
    login: 50,
    create: 30,
    update: 20,
    delete: 10,
    export: 5,
    configure: 8,
    AI_ANALYSIS_GENERATED: 15,
    DATA_SUMMARY_GENERATED: 7,
    detect: 3,
    ACTIVE_TRACKING_PROJECT_SET: 4,
    ACTIVE_TRACKING_PROJECT_CHANGED: 2,
    ACTIVE_TRACKING_PROJECT_CLEARED: 1,
    blocked: 6,
    import: 2,
    reset: 1,
    revoke: 3,
  });
  // Every key must be a canonical category — no raw values
  for (const key of Object.keys(result)) {
    assert.ok(
      key in ACTION_DISPLAY_LABELS,
      `Key "${key}" must be a recognized canonical category`,
    );
  }
  // Counts must be accurate
  assert.equal(result['Create'], 30 + 4); // create + ACTIVE_TRACKING_PROJECT_SET
  assert.equal(result['Update'], 20 + 2); // update + ACTIVE_TRACKING_PROJECT_CHANGED
  assert.equal(result['Delete'], 10 + 1); // delete + ACTIVE_TRACKING_PROJECT_CLEARED
  assert.equal(result['AI Analysis'], 15 + 7); // AI_ANALYSIS_GENERATED + DATA_SUMMARY_GENERATED
  assert.equal(result['Detect'], 3);
  assert.equal(result['Login'], 50);
  assert.ok(!('Logout' in result), 'Logout not in result (no logout actions in input)');
  assert.equal(result['Export'], 5);
  assert.equal(result['Configure'], 8);
  assert.equal(result['Import'], 2);
  assert.equal(result['Reset'], 1);
  assert.equal(result['Revoke'], 3);
  assert.equal(result['Other'], 6); // blocked
});

test('NORM-AGG-05: empty input → empty output', () => {
  const result = aggregateActionDistribution({});
  assert.deepEqual(result, {});
});

test('NORM-AGG-06: no double-counting — same canonical from different raw values', () => {
  const result = aggregateActionDistribution({
    create: 5,
    CREATE_USER: 3,
    CREATE_DEVICE: 2,
    ACTIVE_TRACKING_PROJECT_SET: 1,
  });
  // All should merge into Create = 5+3+2+1 = 11
  assert.equal(result['Create'], 11);
  // Only one key for Create
  assert.equal(Object.keys(result).length, 1);
});

test('NORM-AGG-07: stable ordering — keys are deterministically ordered', () => {
  const result = aggregateActionDistribution({
    update: 1,
    create: 1,
    delete: 1,
    login: 1,
  });
  // Object.keys returns insertion order — the normalizer inserts in the
  // order processes are iterated. Verify all expected keys exist and
  // there are no duplicates.
  const keys = Object.keys(result);
  assert.equal(keys.length, 4, 'exactly 4 categories');
  assert.ok(keys.includes('Create'));
  assert.ok(keys.includes('Update'));
  assert.ok(keys.includes('Delete'));
  assert.ok(keys.includes('Login'));
  // Verify sorted order is deterministic (same input → same output)
  const result2 = aggregateActionDistribution({
    update: 1,
    create: 1,
    delete: 1,
    login: 1,
  });
  assert.deepEqual(Object.keys(result), Object.keys(result2), 'deterministic ordering');
});

// ─── Display labels ─────────────────────────────────────────────────────────

test('NORM-LABEL-01: all canonical actions have display labels', () => {
  const canonicalActions: CanonicalAction[] = [
    'Create', 'Update', 'Delete', 'Login', 'Logout',
    'Export', 'Configure', 'Detect', 'AI Analysis',
    'Import', 'Reset', 'Revoke', 'Other',
  ];
  for (const action of canonicalActions) {
    assert.ok(
      action in ACTION_DISPLAY_LABELS,
      `Missing display label for "${action}"`,
    );
    assert.equal(
      ACTION_DISPLAY_LABELS[action],
      action,
      `Display label for "${action}" should match category name`,
    );
  }
});

// ─── Security: tenant isolation (normalizer is stateless) ───────────────────

test('NORM-SEC-01: normalizer is a pure function — no side effects, no state', () => {
  // Calling with different inputs should never affect subsequent calls
  const a = normalizeAuditAction('create');
  const b = normalizeAuditAction('unknown_action_xyz');
  const c = normalizeAuditAction('create');
  assert.equal(a, 'Create');
  assert.equal(b, 'Other');
  assert.equal(c, 'Create'); // no state leakage
});
