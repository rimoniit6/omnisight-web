/**
 * Super Admin Organization Detail — Members-only regression tests.
 *
 * Confirms the architectural contract introduced by the "Super Admin
 * Organization Detail → Members-only" refactor:
 *
 *   - The Organization Detail surface is intentionally a MEMBERS-ONLY
 *     administration page (list / add / create user / role change /
 *     suspend & reactivate / remove membership).
 *   - The EMPLOYEES / DEVICES / PROJECTS / AUDIT LOGS tabs were REMOVED
 *     from this page (they remain available after switching into the
 *     organization via the Organization Switcher → operational dashboard).
 *   - The underlying Member CRUD API endpoints are PRESERVED (not deleted).
 *   - The sub-resource APIs that were previously surfaced as super-admin
 *     detail tabs (employees/devices/projects/audit-logs) remain intact
 *     for any legitimate consumer.
 *
 * These are structural/static assertions (no DOM test harness exists in
 * this repository) — they lock the page contract so the removed tabs
 * cannot silently return and the Members surface cannot be deleted.
 *
 * Run: npx tsx --test tests/super-admin-detail-members-only.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const DETAIL_SRC = resolve(ROOT, 'src/components/super-admin/super-admin-organization-detail-page.tsx');
const MEMBERS_ROUTE = resolve(ROOT, 'src/app/api/organizations/[id]/members/route.ts');
const MEMBER_ID_ROUTE = resolve(ROOT, 'src/app/api/organizations/[id]/members/[memberId]/route.ts');
const EMPLOYEES_API = resolve(ROOT, 'src/app/api/super-admin/organizations/[id]/employees/route.ts');
const DEVICES_API = resolve(ROOT, 'src/app/api/super-admin/organizations/[id]/devices/route.ts');
const PROJECTS_API = resolve(ROOT, 'src/app/api/super-admin/organizations/[id]/projects/route.ts');
const AUDIT_LOGS_API = resolve(ROOT, 'src/app/api/super-admin/organizations/[id]/audit-logs/route.ts');
const MEMBERSHIPS_API = resolve(ROOT, 'src/app/api/super-admin/organizations/[id]/memberships/route.ts');

let detailSrc: string;

before(() => {
  assert.ok(existsSync(DETAIL_SRC), `detail page source missing: ${DETAIL_SRC}`);
  detailSrc = readFileSync(DETAIL_SRC, 'utf8');
});

after(() => {});

test('SAMD-1: organization detail page still has a Members surface with Add/Role/Suspend/Remove operations', () => {
  assert.ok(/Members/.test(detailSrc), 'page must render a Members section');
  assert.ok(/Add Member/.test(detailSrc), 'page must support adding a member');
  assert.ok(/Create New User/.test(detailSrc), 'page must support creating a user');
  assert.ok(/edit|Edit Organization Role|Save Changes/i.test(detailSrc), 'page must support role change');
  assert.ok(/[Ss]uspend/.test(detailSrc), 'page must support suspending a member');
  assert.ok(/[Rr]eactivate/.test(detailSrc), 'page must support reactivating a member');
  assert.ok(/Remove/.test(detailSrc), 'page must support removing a member');
});

test('SAMD-2: page is MEMBERS-ONLY — no Employees/Devices/Projects/Audit Logs tab triggers', () => {
  // The removed tabs must not reappear as tab triggers, sections, or queries.
  const forbidden = [
    /TabsTrigger value="employees"/i,
    /TabsTrigger value="devices"/i,
    /TabsTrigger value="projects"/i,
    /TabsTrigger value="audit"/i,
    /<TabsContent value="employees"/i,
    /<TabsContent value="devices"/i,
    /<TabsContent value="projects"/i,
    /<TabsContent value="audit"/i,
    /super-admin-org-employees/i,
    /super-admin-org-devices/i,
    /super-admin-org-projects/i,
    /super-admin-org-audit/i,
  ];
  for (const re of forbidden) {
    assert.ok(!re.test(detailSrc), `forbidden stub for removed tab found: ${re}`);
  }
  // No Tabs UI should wrap the surface anymore at all.
  assert.ok(!/<Tabs /.test(detailSrc), 'Tabs wrapper should be removed from the members-only page');
});

test('SAMD-3: page does NOT eagerly fetch employees/devices/projects/audit-logs data', () => {
  assert.ok(
    !detailSrc.includes(`/api/super-admin/organizations/${'${orgId}'}/employees`),
    'must not fetch employees on this page'
  );
  assert.ok(
    !detailSrc.includes(`/api/super-admin/organizations/${'${orgId}'}/devices`),
    'must not fetch devices on this page'
  );
  assert.ok(
    !detailSrc.includes(`/api/super-admin/organizations/${'${orgId}'}/projects`),
    'must not fetch projects on this page'
  );
  assert.ok(
    !detailSrc.includes(`/api/super-admin/organizations/${'${orgId}'}/audit-logs`),
    'must not fetch audit-logs on this page'
  );
});

test('SAMD-4: page still fetches an organization detail (metadata/member count) + members only', () => {
  assert.ok(
    detailSrc.includes('/api/super-admin/organizations/') ||
      detailSrc.includes(`/api/super-admin/organizations/${'${orgId}'}`),
    'organization metadata query retained'
  );
  assert.ok(
    detailSrc.includes(`/api/organizations/${'${orgId}'}/members`),
    'members query retained'
  );
});

test('SAMD-5: page keeps the operational access path — Switch to Organization', () => {
  assert.ok(/Switch to Organization/.test(detailSrc), 'page must offer Switch to Organization');
  assert.ok(
    detailSrc.includes('/api/me/organization/switch'),
    'Switch to Organization must call the org-switch endpoint'
  );
});

test('SAMD-6: member CRUD API routes are PRESERVED (not deleted)', () => {
  assert.ok(existsSync(MEMBERS_ROUTE), 'members GET/POST route must still exist');
  assert.ok(existsSync(MEMBER_ID_ROUTE), 'member PATCH/DELETE route must still exist');
});

test('SAMD-7: previously-tabbed sub-resource APIs remain intact for legitimate consumers', () => {
  for (const [name, p] of [['employees', EMPLOYEES_API], ['devices', DEVICES_API], ['projects', PROJECTS_API], ['audit-logs', AUDIT_LOGS_API], ['memberships', MEMBERSHIPS_API]] as const) {
    assert.ok(existsSync(p), `${name} super-admin API route must remain (not deleted): ${p}`);
  }
});
