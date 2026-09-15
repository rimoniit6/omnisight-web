/**
 * Super Admin Workspace Navigation — regression tests (AUTHORIZATION ≠ NAVIGATION).
 *
 * Validates:
 *   WSN-01  super_admin sidebar is exactly the Control Center — with AND
 *           without an active organization context (membership-driven or the
 *           MANAGED-org switch flow).
 *   WSN-02  no tenant operational/intelligence/security/admin item is ever
 *           visible to super_admin in the shell.
 *   WSN-03  org roles (org_admin / manager / viewer) never see Control Center
 *           items; their tenant items remain permission-filtered.
 *   WSN-04  Control Center pages stay super_admin-gated in the permission
 *           authority (PAGE_MIN_ROLE) — the navigation fix did not change
 *           authorization.
 *   WSN-05  representative Super Admin APIs remain super_admin-only server-side
 *           (route source inspection — same technique the existing suite uses).
 *
 * Run: npx tsx --test tests/super-admin-workspace-nav.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { navGroups, visibleGroupsFor, canAccessShellItem } from '../src/lib/sidebar-nav';
import { PAGE_MIN_ROLE, canAccessPage } from '../src/lib/navigation';
import { hasRolePermission } from '../src/lib/auth';

const ALL_ITEMS = navGroups.flatMap((g) => g.items);
const CONTROL_CENTER_IDS = new Set(navGroups.filter((g) => g.id === 'control-center').flatMap((g) => g.items.map((i) => i.page)));
const TENANT_GROUP_IDS = navGroups.filter((g) => g.id !== 'control-center').map((g) => g.id);

test('WSN-01: super_admin sidebar is exactly the Control Center, org context or not', () => {
  const expected = [...CONTROL_CENTER_IDS];

  for (const hasOrg of [false, true]) {
    const groups = visibleGroupsFor('super_admin', hasOrg);
    assert.deepEqual(
      groups.map((g) => g.id),
      ['control-center'],
      `super_admin sees only control-center (hasOrg=${hasOrg})`,
    );
    assert.deepEqual(
      groups.flatMap((g) => g.items.map((i) => i.page)),
      expected,
      `super_admin items are exactly the Control Center entries in order (hasOrg=${hasOrg})`,
    );
  }
});

test('WSN-02: no tenant workspace item is visible to super_admin in the shell', () => {
  const saPages = visibleGroupsFor('super_admin', true).flatMap((g) => g.items.map((i) => i.page));
  const tenantItems = navGroups
    .filter((g) => g.id !== 'control-center')
    .flatMap((g) => g.items.map((i) => i.page));

  for (const p of tenantItems) {
    assert.ok(!saPages.includes(p), `super_admin must NOT see tenant item ${p}`);
  }
  // Spot-check the workspace-defining surfaces explicitly.
  for (const p of ['dashboard', 'employees', 'activities', 'screenshots', 'settings', 'data-infrastructure', 'users', 'projects', 'consent'] as const) {
    assert.ok(!saPages.includes(p), `super_admin must NOT see ${p}`);
  }
});

test('WSN-03: org roles never see Control Center items; tenant filtering preserved', () => {
  for (const role of ['org_admin', 'manager', 'viewer']) {
    const pages = visibleGroupsFor(role, true).flatMap((g) => g.items.map((i) => i.page));
    for (const cc of CONTROL_CENTER_IDS) {
      assert.ok(!pages.includes(cc), `${role} must NOT see control-center item ${cc}`);
    }
  }
  // Org Admin keeps the tenant admin surface (settings/data-infrastructure/users).
  const adminPages = visibleGroupsFor('org_admin', true).flatMap((g) => g.items.map((i) => i.page));
  for (const p of ['dashboard', 'employees', 'settings', 'data-infrastructure', 'users'] as const) {
    assert.ok(adminPages.includes(p), `org_admin keeps ${p}`);
  }
  // Manager: permission-filtered — no org_admin-only items.
  const managerPages = visibleGroupsFor('manager', true).flatMap((g) => g.items.map((i) => i.page));
  for (const p of ['settings', 'users', 'security', 'ai-provider', 'agent-approvals', 'organization', 'data-infrastructure'] as const) {
    assert.ok(!managerPages.includes(p), `manager must not see org_admin-only ${p}`);
  }
  assert.ok(managerPages.includes('reports'), 'manager keeps reports');
  assert.ok(managerPages.includes('consent'), 'manager keeps consent');
  // Viewer: read-mostly surface, no admin items at all.
  const viewerPages = visibleGroupsFor('viewer', true).flatMap((g) => g.items.map((i) => i.page));
  for (const p of ['settings', 'users', 'reports', 'consent', 'audio'] as const) {
    assert.ok(!viewerPages.includes(p), `viewer must not see ${p}`);
  }
  assert.ok(viewerPages.includes('dashboard'), 'viewer keeps dashboard');
  assert.ok(viewerPages.includes('screenshots'), 'viewer keeps screenshots');
  // Tenant groups are the only groups for org roles.
  const adminGroupIds = visibleGroupsFor('org_admin', true).map((g) => g.id);
  for (const gid of adminGroupIds) {
    assert.ok(TENANT_GROUP_IDS.includes(gid), `org_admin group ${gid} is a tenant group`);
  }
});

test('WSN-04: permission authority unchanged — control-plane pages stay super_admin-gated', () => {
  for (const p of ALL_ITEMS.filter((i) => CONTROL_CENTER_IDS.has(i.page)).map((i) => i.page)) {
    assert.equal(PAGE_MIN_ROLE[p], 'super_admin', `${p} remains super_admin-gated`);
    assert.equal(canAccessPage('org_admin', p), false, `org_admin denied ${p}`);
    assert.equal(canAccessPage('manager', p), false, `manager denied ${p}`);
    assert.equal(canAccessPage('viewer', p), false, `viewer denied ${p}`);
  }
  // Unknown roles fail closed.
  assert.equal(canAccessPage(null, 'dashboard'), false);
  assert.equal(canAccessPage(undefined, 'sa-overview'), false);
  assert.equal(canAccessPage('', 'sa-overview'), false);
  // Legacy aliases still satisfy tenant gates (unchanged behavior).
  assert.equal(hasRolePermission('admin', 'org_admin'), true, 'legacy admin alias keeps org_admin level');
  assert.equal(hasRolePermission('owner', 'org_admin'), true, 'legacy owner alias keeps org_admin level');
  // Shell supersession unchanged: organization page still hidden from SA.
  assert.equal(canAccessShellItem('super_admin', 'organization'), false);
});

test('WSN-05: representative Super Admin routes remain super_admin-only server-side', () => {
  const mustBeSuperAdminOnly = [
    'src/app/api/super-admin/organizations/route.ts',
    'src/app/api/super-admin/purchase-requests/[id]/route.ts',
    'src/app/api/admin/infrastructure-requests/route.ts',
    'src/app/api/admin/infrastructure-migrations/[id]/activate/route.ts',
  ];
  for (const rel of mustBeSuperAdminOnly) {
    const src = readFileSync(resolve(__dirname, '..', rel), 'utf8');
    const isSaOnly =
      /requireSuperAdmin|requireSuperAdminContext|requireDbVerifiedRole|requirePlatformAdmin/.test(src);
    assert.ok(isSaOnly, `${rel} must enforce a super-admin server-side guard`);
    // An org-admin guard alone is not sufficient for these routes.
    const orgAdminOnly = /requireOrgAdmin\s*\(/.test(src) && !/requireSuperAdmin|requireDbVerifiedRole|requirePlatformAdmin/.test(src);
    assert.ok(!orgAdminOnly, `${rel} must not be org_admin-guarded only`);
  }
});
