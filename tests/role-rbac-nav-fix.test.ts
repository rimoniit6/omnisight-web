/**
 * Organization Role & RBAC + Navigation Fix — Regression Tests
 *
 * Validates:
 *   - Role dropdown only shows org_admin, manager, viewer
 *   - super_admin is not assignable as membership role
 *   - User Management is a primary navigation section
 *   - PAGE_MIN_ROLE correctly documents super-admin pages
 *   - canAccessPage enforces super_admin for super-admin pages
 *
 * Run: npx tsx --test tests/role-rbac-nav-fix.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─── Test 1: Role dropdown only shows valid org roles ────────────────────

test('ROLE-01: UserManagement role selector contains only org_admin, manager, viewer', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const src = readFileSync(resolve(__dirname, '../src/components/users/user-management.tsx'), 'utf8');

  // The create/edit form role selector must only have these three options
  assert.ok(src.includes('value="org_admin"'), 'Must include org_admin');
  assert.ok(src.includes('value="manager"'), 'Must include manager');
  assert.ok(src.includes('value="viewer"'), 'Must include viewer');

  // Must NOT have these in the role selector (the SelectContent for role assignment)
  // Find the role selector section — it's the one with id="user-role"
  const roleSection = src.substring(src.indexOf('id="user-role"'));
  const selectContentEnd = roleSection.indexOf('</SelectContent>');
  const roleSelector = roleSection.substring(0, selectContentEnd);

  assert.ok(!roleSelector.includes('value="super_admin"'), 'Must NOT include super_admin in role selector');
  assert.ok(!roleSelector.includes('value="owner"'), 'Must NOT include owner in role selector');
  assert.ok(!roleSelector.includes('value="admin"'), 'Must NOT include admin in role selector');
});

// ─── Test 2: Role filter also updated ────────────────────────────────────

test('ROLE-02: UserManagement role filter contains only valid org roles', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const src = readFileSync(resolve(__dirname, '../src/components/users/user-management.tsx'), 'utf8');

  // Find the role filter section — it's before the "Add User" button
  const filterSection = src.substring(0, src.indexOf('Add User'));
  const lastSelectContent = filterSection.lastIndexOf('</SelectContent>');
  const filterStart = filterSection.lastIndexOf('<SelectContent>', lastSelectContent);
  const filterSelector = filterSection.substring(filterStart, lastSelectContent);

  assert.ok(filterSelector.includes('value="org_admin"'), 'Filter must include org_admin');
  assert.ok(filterSelector.includes('value="manager"'), 'Filter must include manager');
  assert.ok(filterSelector.includes('value="viewer"'), 'Filter must include viewer');
  assert.ok(!filterSelector.includes('value="super_admin"'), 'Filter must NOT include super_admin');
  assert.ok(!filterSelector.includes('value="owner"'), 'Filter must NOT include owner');
  assert.ok(!filterSelector.includes('value="admin"'), 'Filter must NOT include admin');
});

// ─── Test 3: super_admin is not an org role ──────────────────────────────

test('ROLE-03: isOrgRole("super_admin") returns false', async () => {
  const { isOrgRole } = await import('../src/lib/org-members');
  assert.equal(isOrgRole('super_admin'), false, 'super_admin must not be an org role');
});

// ─── Test 4: Valid org roles are accepted ────────────────────────────────

test('ROLE-04: isOrgRole accepts org_admin, manager, viewer', async () => {
  const { isOrgRole } = await import('../src/lib/org-members');
  assert.equal(isOrgRole('org_admin'), true, 'org_admin must be accepted');
  assert.equal(isOrgRole('manager'), true, 'manager must be accepted');
  assert.equal(isOrgRole('viewer'), true, 'viewer must be accepted');
});

// ─── Test 5: Legacy roles are NOT accepted as org roles ──────────────────

test('ROLE-05: isOrgRole rejects legacy owner and admin', async () => {
  const { isOrgRole } = await import('../src/lib/org-members');
  assert.equal(isOrgRole('owner'), false, 'owner must not be accepted as org role');
  assert.equal(isOrgRole('admin'), false, 'admin must not be accepted as org role');
});

// ─── Test 6: canAssignRole prevents super_admin assignment ───────────────

test('ROLE-06: canAssignRole prevents assigning super_admin', async () => {
  const { canAssignRole } = await import('../src/lib/org-members');
  // Even super_admin cannot assign super_admin via membership
  assert.equal(canAssignRole('super_admin', 'super_admin'), false, 'Cannot assign super_admin as membership role');
  // But super_admin CAN assign org_admin
  assert.equal(canAssignRole('super_admin', 'org_admin'), true, 'Super admin can assign org_admin');
});

// ─── Test 7: Org Admin cannot assign super_admin ─────────────────────────

test('ROLE-07: Org Admin cannot assign super_admin', async () => {
  const { canAssignRole } = await import('../src/lib/org-members');
  assert.equal(canAssignRole('org_admin', 'super_admin'), false, 'Org admin cannot assign super_admin');
});

// ─── Test 8: User Management is a primary nav item ───────────────────────

test('ROLE-08: Users page exists in sidebar navigation', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const sidebarSrc = readFileSync(resolve(__dirname, '../src/components/layout/app-sidebar.tsx'), 'utf8');
  assert.ok(sidebarSrc.includes("page: 'users'"), 'Sidebar must have users page');
  assert.ok(sidebarSrc.includes('Users & Members'), 'Sidebar must label it Users & Members');
});

// ─── Test 9: Users page exists in mobile sidebar ─────────────────────────

test('ROLE-09: Users page exists in mobile sidebar', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const mobileSrc = readFileSync(resolve(__dirname, '../src/components/layout/mobile-sidebar.tsx'), 'utf8');
  assert.ok(mobileSrc.includes("page: 'users'"), 'Mobile sidebar must have users page');
});

// ─── Test 10: Users page is registered in page.tsx ───────────────────────

test('ROLE-10: UsersPage is registered in page.tsx dynamic imports', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const pageSrc = readFileSync(resolve(__dirname, '../src/app/page.tsx'), 'utf8');
  assert.ok(pageSrc.includes('UsersPage'), 'page.tsx must import UsersPage');
  assert.ok(pageSrc.includes("users: UsersPage"), 'page.tsx must register users page');
});

// ─── Test 11: Settings no longer has User Management ─────────────────────

test('ROLE-11: Settings page no longer contains User Management section', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const settingsSrc = readFileSync(resolve(__dirname, '../src/components/settings/settings-page.tsx'), 'utf8');
  assert.ok(!settingsSrc.includes("activeSection === 'users'"), 'Settings must not render User Management');
  assert.ok(!settingsSrc.includes("key: 'users'"), 'Settings must not have users section');
});

// ─── Test 12: PAGE_MIN_ROLE for users page ───────────────────────────────

test('ROLE-12: PAGE_MIN_ROLE includes users page with org_admin', async () => {
  const { PAGE_MIN_ROLE } = await import('../src/lib/navigation');
  assert.equal(PAGE_MIN_ROLE['users'], 'org_admin', 'Users page requires org_admin');
});

// ─── Test 13: canAccessPage restricts super-admin pages ──────────────────

test('ROLE-13: canAccessPage restricts super-admin pages to super_admin only', async () => {
  const { canAccessPage } = await import('../src/lib/navigation');
  // super_admin can access
  assert.equal(canAccessPage('super_admin', 'super-admin-organizations'), true);
  assert.equal(canAccessPage('super_admin', 'super-admin-organization-detail'), true);
  // org_admin cannot (even though PAGE_MIN_ROLE says org_admin)
  assert.equal(canAccessPage('org_admin', 'super-admin-organizations'), false);
  assert.equal(canAccessPage('org_admin', 'super-admin-organization-detail'), false);
  // manager cannot
  assert.equal(canAccessPage('manager', 'super-admin-organizations'), false);
  // viewer cannot
  assert.equal(canAccessPage('viewer', 'super-admin-organizations'), false);
});

// ─── Test 14: canAccessPage allows org_admin to users page ───────────────

test('ROLE-14: canAccessPage allows org_admin to users page', async () => {
  const { canAccessPage } = await import('../src/lib/navigation');
  assert.equal(canAccessPage('org_admin', 'users'), true, 'Org admin can access users page');
  assert.equal(canAccessPage('super_admin', 'users'), true, 'Super admin can access users page');
  // Manager does NOT have org_admin privileges — users page requires org_admin+
  assert.equal(canAccessPage('manager', 'users'), false, 'Manager cannot access users page');
  assert.equal(canAccessPage('viewer', 'users'), false, 'Viewer cannot access users page');
});

// ─── Test 15: pageLabels includes users ───────────────────────────────────

test('ROLE-15: app-header pageLabels includes users', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const headerSrc = readFileSync(resolve(__dirname, '../src/components/layout/app-header.tsx'), 'utf8');
  assert.ok(headerSrc.includes("users: 'Users & Members'"), 'Header must have users label');
});

// ─── Test 16: ORG_ROLES constant is correct ──────────────────────────────

test('ROLE-16: ORG_ROLES constant contains exactly org_admin, manager, viewer', async () => {
  const { ORG_ROLES } = await import('../src/lib/org-members');
  assert.deepEqual([...ORG_ROLES], ['org_admin', 'manager', 'viewer']);
});

// ─── Test 17: Super Admin Organization Detail uses correct roles ──────────

test('ROLE-17: Super Admin Org Detail uses ORG_ROLES (not legacy roles)', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const detailSrc = readFileSync(
    resolve(__dirname, '../src/components/super-admin/super-admin-organization-detail-page.tsx'),
    'utf8'
  );
  assert.ok(detailSrc.includes("ORG_ROLES = ['org_admin', 'manager', 'viewer']"), 'Must use correct ORG_ROLES');
  assert.ok(!detailSrc.includes("ORG_ROLES = ['super_admin'"), 'Must NOT include super_admin in ORG_ROLES');
});

// ─── Test 18: API POST /api/auth/users rejects super_admin ───────────────

test('ROLE-18: POST /api/auth/users validRoles excludes super_admin', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const routeSrc = readFileSync(resolve(__dirname, '../src/app/api/auth/users/route.ts'), 'utf8');
  assert.ok(routeSrc.includes("const validRoles = ['org_admin', 'manager', 'viewer']"), 'validRoles must be correct');
  // Verify super_admin is NOT in the validRoles array (it may appear elsewhere for role-level checks)
  const validRolesMatch = routeSrc.match(/const validRoles = \[(.*?)\]/);
  assert.ok(validRolesMatch, 'validRoles array must exist');
  assert.ok(!validRolesMatch![1].includes('super_admin'), 'super_admin must not be in validRoles array');
});

// ─── Test 19: API PUT /api/auth/users/[id] rejects super_admin ──────────

test('ROLE-19: PUT /api/auth/users/[id] validRoles excludes super_admin', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const routeSrc = readFileSync(resolve(__dirname, '../src/app/api/auth/users/[id]/route.ts'), 'utf8');
  assert.ok(routeSrc.includes("const validRoles = ['org_admin', 'manager', 'viewer']"), 'validRoles must be correct');
});

// ─── Test 20: Navigation has correct comment for super-admin pages ────────

test('ROLE-20: PAGE_MIN_ROLE has clarifying comment for super-admin pages', async () => {
  const { readFileSync } = await import('fs');
  const { resolve } = await import('path');
  const navSrc = readFileSync(resolve(__dirname, '../src/lib/navigation.ts'), 'utf8');
  assert.ok(
    navSrc.includes('canAccessPage()') && navSrc.includes('special case'),
    'Navigation must document the super-admin special case'
  );
});
