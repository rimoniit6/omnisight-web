/**
 * Branding Sidebar Deduplication Tests
 *
 * Validates that the "Branding" sidebar item appears exactly once
 * for org_admin and is properly placed in the tenant-admin group.
 * Super_admin sees only the Control Center group, so branding
 * (which lives in tenant-admin) is not visible to super_admin.
 *
 * Run: npx tsx --test tests/branding-sidebar-dedup.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { navGroups, visibleGroupsFor, canAccessShellItem } from '../src/lib/sidebar-nav';

test('SIDEBAR-01: org_admin sees exactly one Branding item', () => {
  const groups = visibleGroupsFor('org_admin', true);
  const brandingItems = groups
    .flatMap(g => g.items)
    .filter(item => item.page === 'branding');
  
  assert.equal(brandingItems.length, 1, 'org_admin must see exactly one Branding item');
});

test('SIDEBAR-02: super_admin sees no Branding item (branding is in tenant-admin, super_admin only sees control-center)', () => {
  const groups = visibleGroupsFor('super_admin', false);
  const brandingItems = groups
    .flatMap(g => g.items)
    .filter(item => item.page === 'branding');
  
  assert.equal(brandingItems.length, 0, 'super_admin must NOT see Branding item in sidebar');
});

test('SIDEBAR-03: manager sees no Branding item (requires org_admin)', () => {
  const groups = visibleGroupsFor('manager', true);
  const brandingItems = groups
    .flatMap(g => g.items)
    .filter(item => item.page === 'branding');
  
  assert.equal(brandingItems.length, 0, 'manager must NOT see Branding item');
});

test('SIDEBAR-04: viewer sees no Branding item (requires org_admin)', () => {
  const groups = visibleGroupsFor('viewer', true);
  const brandingItems = groups
    .flatMap(g => g.items)
    .filter(item => item.page === 'branding');
  
  assert.equal(brandingItems.length, 0, 'viewer must NOT see Branding item');
});

test('SIDEBAR-05: no duplicate page keys across all groups', () => {
  const allItems = navGroups.flatMap(g => g.items);
  const pages = allItems.map(i => i.page);
  const unique = new Set(pages);
  
  assert.equal(pages.length, unique.size, 'No duplicate page keys allowed in navGroups');
});

test('SIDEBAR-06: branding is NOT superseded for org_admin in shell', () => {
  // org_admin should see branding via canAccessShellItem
  // because only super_admin has superseded pages
  assert.equal(
    canAccessShellItem('org_admin', 'branding'),
    true,
    'branding must NOT be superseded for org_admin'
  );
});

test('SIDEBAR-07: branding appears in tenant-admin group (not control-center)', () => {
  const tenantAdminGroup = navGroups.find(g => g.id === 'tenant-admin');
  const controlCenterGroup = navGroups.find(g => g.id === 'control-center');
  
  assert.ok(tenantAdminGroup, 'tenant-admin group exists');
  assert.ok(controlCenterGroup, 'control-center group exists');
  
  const brandingInTenantAdmin = tenantAdminGroup!.items.some(i => i.page === 'branding');
  const brandingInControlCenter = controlCenterGroup!.items.some(i => i.page === 'branding');
  
  assert.equal(brandingInTenantAdmin, true, 'branding must be in tenant-admin group');
  assert.equal(brandingInControlCenter, false, 'branding must NOT be in control-center group');
});
