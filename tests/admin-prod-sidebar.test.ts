/**
 * S-2 — role-aware navigation.
 *
 * Pure tests of src/lib/navigation.ts (no DB): viewers must never see
 * admin-only items; managers gain Reports/Daily Report/My Portal; admins gain
 * Settings/AI Provider/Agent Approvals/Organization/Security; super_admin (and
 * owner) clear every gate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAccessPage, PAGE_MIN_ROLE } from '../src/lib/navigation';
import type { PageType } from '../src/lib/store';

const ALL_PAGES = Object.keys(PAGE_MIN_ROLE) as PageType[];

// 'consent' is manager+ by design (it exposes org-wide employee PII and
// matches the /api/consent RBAC) — see src/lib/navigation.ts.
// 'audit' is manager+ too (S-05): audit logs carry security telemetry
// (hostnames, employee codes, IPs, admin emails) and the export endpoint is
// already manager+ — the list must not be readable by the lowest role.
const VIEWER_PAGES: PageType[] = [
  'dashboard', 'employees', 'departments', 'devices', 'activities', 'screenshots',
  'break-status', 'live-monitor', 'analytics', 'insights', 'notifications',
  'alerts', 'anomalies', 'policies', 'projects', 'sentiment',
];

const MANAGER_ONLY: PageType[] = ['reports', 'daily-report', 'self-portal', 'consent', 'audit'];

const ADMIN_ONLY: PageType[] = ['settings', 'ai-provider', 'agent-approvals', 'organization', 'security'];

test('NAV-1: every page has an explicit minimum role mapping', () => {
  // PAGE_MIN_ROLE is typed Record<PageType, NavMinRole>, so this also proves
  // compile-time coverage of every PageType in src/lib/store.ts.
  assert.ok(ALL_PAGES.length >= 20, 'navigation mapping covers the full page set');
  for (const p of ALL_PAGES) {
    assert.ok(['viewer', 'manager', 'admin', 'org_admin'].includes(PAGE_MIN_ROLE[p]), `${p} has valid min role`);
  }
});

test('NAV-2: viewer sees monitoring surface but never admin/manager-only items', () => {
  for (const p of VIEWER_PAGES) {
    assert.equal(canAccessPage('viewer', p), true, `viewer must see ${p}`);
  }
  for (const p of [...MANAGER_ONLY, ...ADMIN_ONLY]) {
    assert.equal(canAccessPage('viewer', p), false, `viewer must NOT see ${p}`);
  }
});

test('NAV-3: manager additionally sees Reports, Daily Report and Employee Portal', () => {
  for (const p of [...VIEWER_PAGES, ...MANAGER_ONLY]) {
    assert.equal(canAccessPage('manager', p), true, `manager must see ${p}`);
  }
  for (const p of ADMIN_ONLY) {
    assert.equal(canAccessPage('manager', p), false, `manager must NOT see ${p}`);
  }
});

test('NAV-4: admin sees everything including admin-only pages', () => {
  for (const p of [...VIEWER_PAGES, ...MANAGER_ONLY, ...ADMIN_ONLY]) {
    assert.equal(canAccessPage('admin', p), true, `admin must see ${p}`);
  }
});

test('NAV-5: owner and super_admin clear every gate', () => {
  const superAdminOnlyPages = ['super-admin-organizations', 'super-admin-organization-detail'];
  for (const role of ['owner', 'super_admin']) {
    for (const p of ALL_PAGES) {
      const expected = superAdminOnlyPages.includes(p) ? role === 'super_admin' : true;
      assert.equal(canAccessPage(role, p), expected, `${role} must see ${p}`);
    }
  }
});

test('NAV-6: unknown / missing roles are denied (fail closed)', () => {
  assert.equal(canAccessPage(null, 'dashboard'), false);
  assert.equal(canAccessPage(undefined, 'reports'), false);
  assert.equal(canAccessPage('', 'dashboard'), false);
  assert.equal(canAccessPage('pirate', 'dashboard'), false);
});
