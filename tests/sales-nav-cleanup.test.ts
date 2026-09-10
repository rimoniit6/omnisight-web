/**
 * OmniSight — Sales / Organization navigation cleanup.
 *
 * Static contract tests (no DB, no server) proving the product decision:
 *   • Sales Leads and Payment Verification workflows are REMOVED from the
 *     navigation, page tree and their exclusive APIs.
 *   • The navigation exposes exactly ONE authoritative Organizations entry
 *     (tenant "Organization" settings stays org-scoped; the Control Center
 *     owns the platform Organizations surface).
 *   • The manual sales lifecycle (Packages / Subscriptions / Payments /
 *     Licenses + provisioning) stays intact and super_admin-gated.
 *   • Desktop and mobile shells consume one shared navigation model.
 *
 * Run: npx tsx --test tests/sales-nav-cleanup.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { navGroups, canAccessShellItem, visibleGroupsFor } from '../src/lib/sidebar-nav';
import { canAccessPage, PAGE_MIN_ROLE } from '../src/lib/navigation';
import type { PageType } from '../src/lib/store';

const ROOT = resolve(__dirname, '..');
const ALL_ITEMS = navGroups.flatMap((g) => g.items);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const navData: any[] = ALL_ITEMS;

const ORG_FAMILY: PageType[] = [
  'organization', // tenant org settings (Admin group)
  'super-admin-organizations', // Control Center Organizations
  'super-admin-organization-detail', // CC org detail (not in sidebar — reached from list)
  'sa-create-organization', // full provisioning flow (not in sidebar — reached from list)
];

test('CLEANUP-1: Sales Leads and Payment Verification are absent from the navigation model', () => {
  const removedLabels = ['Sales Leads', 'Payment Verification'];
  for (const item of ALL_ITEMS) {
    for (const label of removedLabels) {
      assert.notEqual(item.label, label, `nav item must not be "${label}"`);
    }
    assert.notEqual(item.page as string, 'leads', 'no leads page key');
    assert.notEqual(item.page as string, 'payments', 'no payments page key');
    if (item.href) {
      assert.ok(!item.href.startsWith('/admin/leads'), 'no /admin/leads href');
      assert.ok(!item.href.startsWith('/admin/payments'), 'no /admin/payments href');
    }
  }
  // The gating registry must not contain the removed page keys either.
  assert.ok(!('leads' in PAGE_MIN_ROLE), 'PAGE_MIN_ROLE has no leads key');
  assert.ok(!('payments' in PAGE_MIN_ROLE), 'PAGE_MIN_ROLE has no payments key');
});

test('CLEANUP-2: exactly one Organizations entry per role surface', () => {
  // An org-less super admin sees only the Control Center group.
  const saItems = visibleGroupsFor('super_admin', false).flatMap((g) => g.items);
  const saVisible = saItems.filter((i) => ORG_FAMILY.includes(i.page));
  assert.equal(saVisible.length, 1, 'super_admin sees exactly one org nav entry');
  assert.equal(saVisible[0].page, 'super-admin-organizations', '…and it is the Control Center Organizations entry');

  const orgVisible = ALL_ITEMS.filter((i) => ORG_FAMILY.includes(i.page) && canAccessShellItem('org_admin', i.page));
  assert.equal(orgVisible.length, 1, 'org_admin sees exactly one org nav entry');
  assert.equal(orgVisible[0].page, 'organization', '…and it is the tenant Organization settings page');

  // The supersession is shell-visibility only — API gating is unchanged.
  assert.equal(canAccessPage('org_admin', 'organization'), true, 'org_admin permission gate unchanged');
  assert.equal(canAccessPage('super_admin', 'organization'), true, 'super_admin permission gate unchanged');
  assert.equal(canAccessPage('org_admin', 'super-admin-organizations'), false, 'org_admin never reaches CC Organizations');
});

test('CLEANUP-8: Platform-ops pages are gone from the SA product; Landing Page is present', () => {
  const navData = readFileSync(resolve(ROOT, 'src/lib/sidebar-nav.ts'), 'utf8');
  const store = readFileSync(resolve(ROOT, 'src/lib/store.ts'), 'utf8');
  const navReg = readFileSync(resolve(ROOT, 'src/lib/navigation.ts'), 'utf8');
  const header = readFileSync(resolve(ROOT, 'src/components/layout/app-header.tsx'), 'utf8');
  const shell = readFileSync(resolve(ROOT, 'src/app/page.tsx'), 'utf8');

  // Removed platform-ops pages: no nav item, no PageType, no gate, no label.
  for (const p of ['sa-agents', 'sa-storage', 'sa-ai-usage', 'sa-health']) {
    assert.ok(!navData.includes(`page: '${p}'`), `${p} not in sidebar data`);
    assert.ok(!navData.includes(`id: 'platform'`), 'Platform section removed from sidebar data');
    assert.ok(!store.includes(`| '${p}'`), `${p} not a PageType`);
    assert.ok(!navReg.includes(`'${p}':`), `${p} has no navigation gate`);
    assert.ok(!header.includes(`'${p}':`), `${p} has no header label`);
    assert.ok(!shell.includes(`'${p}':`), `${p} not registered in the SPA shell`);
  }
  // Not present as standalone menu labels either.
  for (const label of ['Agents', 'Storage', 'AI Usage', 'System Health']) {
    assert.ok(!navData.includes(`label: '${label}'`), `no "${label}" nav label`);
  }

  // New Landing Page content-management surface.
  assert.ok(navData.includes("page: 'sa-landing'"), 'Landing Page nav item present');
  assert.ok(navData.includes("label: 'Landing Page'"), 'Landing Page label present');
  assert.ok(store.includes("| 'sa-landing'"), 'sa-landing is a PageType');
  assert.ok(navReg.includes("'sa-landing': 'super_admin'"), 'sa-landing is super_admin-gated');
  assert.ok(header.includes("'sa-landing':"), 'sa-landing has a header label');
  assert.ok(shell.includes("'sa-landing':"), 'sa-landing registered in the SPA shell');
  assert.equal(canAccessPage('super_admin', 'sa-landing'), true, 'super_admin can open Landing Page');
  assert.equal(canAccessPage('org_admin', 'sa-landing'), false, 'org_admin denied Landing Page');
});

test('CLEANUP-3: org-less SA sidebar is exactly Overview / Organizations / Packages / Landing Page', () => {
  // Packages stays a standalone configuration menu; the other manual-sales
  // surfaces (Subscriptions / Payments / Licenses) are NOT standalone menus —
  // they are managed from the Organization (org detail). Their backend APIs
  // and gating registries remain intact.
  const standalone = ['sa-overview', 'super-admin-organizations', 'sa-packages', 'sa-landing'];
  const saVisible = visibleGroupsFor('super_admin', false).flatMap((g) => g.items);
  assert.deepEqual(
    saVisible.map((i) => i.page),
    standalone,
    'org-less super_admin sidebar contains exactly the four Control Center entries in order',
  );
  // Once the SA has an active organization context (e.g. switched into a
  // MANAGED org), tenant operational groups reappear alongside Control Center.
  const saWithOrg = visibleGroupsFor('super_admin', true).flatMap((g) => g.items);
  assert.ok(saWithOrg.length > standalone.length, 'SA with an org context gains tenant operational groups');
  assert.ok(saWithOrg.some((i) => i.page === 'employees'), 'SA with org context sees tenant operational pages');
  assert.ok(saWithOrg.some((i) => i.page === 'super-admin-organizations'), 'Control Center stays visible with org context');
  assert.ok(!saWithOrg.some((i) => i.page === 'organization'), 'tenant Organization settings stays superseded for SA');
  for (const p of standalone as PageType[]) {
    assert.equal(PAGE_MIN_ROLE[p], 'super_admin', `${p} is super_admin-gated`);
    assert.ok(!canAccessShellItem('org_admin', p), `org_admin cannot navigate to ${p}`);
  }
  // No standalone menus for org-scoped commercial surfaces or ops dashboards.
  for (const p of ['sa-subscriptions', 'sa-payments', 'sa-licenses', 'sa-audit', 'sa-agents', 'sa-storage', 'sa-ai-usage', 'sa-health']) {
    assert.ok(!ALL_ITEMS.some((i) => i.page === p), `${p} is NOT a sidebar item`);
  }
  const navSrc = readFileSync(resolve(ROOT, 'src/lib/sidebar-nav.ts'), 'utf8');
  assert.ok(!navSrc.includes("section: 'Sales & Billing'"), 'Sales & Billing section removed');
  assert.ok(!navSrc.includes("id: 'security'"), 'standalone SA Security group removed');
  assert.ok(!navSrc.includes("id: 'content'"), 'Content group folded into Control Center');
});

test('CLEANUP-3b: subscription / payment / license management lives in the Organization detail', () => {
  const detail = readFileSync(resolve(ROOT, 'src/components/super-admin/super-admin-organization-detail-page.tsx'), 'utf8');
  // The org detail is the central management screen for the org's commercial
  // state — manual payment editing + subscription activation both live there.
  assert.ok(detail.includes('Manual Payment'), 'org detail has a Manual Payment section');
  assert.ok(detail.includes('Activate Subscription'), 'org detail can activate a PENDING subscription');
  assert.ok(detail.includes("/api/admin/invoices/"), 'org detail edits the manual payment record');
  assert.ok(detail.includes('licenseKey'), 'org detail shows the license state');

  // The standalone orgs list exposes the full commercial state per row.
  const orgsList = readFileSync(resolve(ROOT, 'src/app/api/super-admin/organizations/route.ts'), 'utf8');
  assert.ok(orgsList.includes('invoices:'), 'org list API carries the manual-payment ledger');
  const orgsPage = readFileSync(resolve(ROOT, 'src/components/super-admin/super-admin-organizations-page.tsx'), 'utf8');
  for (const col of ['Subscription', 'Payment', 'License']) {
    assert.ok(orgsPage.includes(`<TableHead>${col}</TableHead>`), `orgs list shows the ${col} column`);
  }
});

test('CLEANUP-4: full provisioning flow stays reachable from the CC orgs list (not a sidebar item)', () => {
  assert.equal(canAccessPage('super_admin', 'sa-create-organization'), true, 'provisioning page reachable by super_admin');
  assert.equal(canAccessPage('org_admin', 'sa-create-organization'), false, 'provisioning page denied to org_admin');
  assert.ok(!ALL_ITEMS.some((i) => i.page === 'sa-create-organization'), 'provisioning is not a top-level nav item');
  const orgsPage = readFileSync(resolve(ROOT, 'src/components/super-admin/super-admin-organizations-page.tsx'), 'utf8');
  assert.ok(orgsPage.includes('sa-create-organization'), 'orgs list links into the provisioning flow');
});

test('CLEANUP-5: obsolete pages and exclusive APIs are deleted from the app tree', () => {
  const removed = [
    'src/app/admin/leads',
    'src/app/admin/payments',
    'src/app/api/admin/leads',
    'src/app/api/admin/invoices/[invoiceId]/[action]',
    'src/app/api/invoices/[invoiceId]/submit-payment',
  ];
  for (const rel of removed) {
    assert.ok(!existsSync(resolve(ROOT, rel)), `${rel} must be deleted`);
  }
  // The PageType union no longer contains the removed standalone pages.
  const storeSrc = readFileSync(resolve(ROOT, 'src/lib/store.ts'), 'utf8');
  assert.ok(!/^\s*\|\s*'(leads|payments)'\s*$/m.test(storeSrc), 'store PageType has no leads/payments members');
});

test('CLEANUP-6: desktop and mobile shells only consume the shared nav model (no stale copy)', () => {
  for (const rel of ['src/components/layout/app-sidebar.tsx', 'src/components/layout/mobile-sidebar.tsx']) {
    const src = readFileSync(resolve(ROOT, rel), 'utf8');
    assert.ok(src.includes("from '@/lib/sidebar-nav'"), `${rel} imports the shared nav model`);
    assert.ok(!/Payment Verification|Sales Leads/.test(src), `${rel} has no removed workflow labels`);
    assert.ok(!src.includes('const navGroups'), `${rel} does not redefine nav data`);
  }
  const navData = readFileSync(resolve(ROOT, 'src/lib/sidebar-nav.ts'), 'utf8');
  // Icon tokens of removed entries must be gone from the data module (labels
  // are asserted structurally in CLEANUP-1 — doc comments may reference the
  // product history).
  assert.ok(!/Inbox|UserPlus/.test(navData), 'shared nav data imports no removed-entry icons');
});

test('CLEANUP-7: nav groups have unique ids and every item maps to a permission gate', () => {
  const ids = navGroups.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, 'group ids are unique');
  for (const g of navGroups) {
    assert.ok(g.items.length > 0, `group ${g.id} has items`);
    for (const item of g.items) {
      assert.ok(item.page in PAGE_MIN_ROLE, `nav item ${item.page} has a gate in PAGE_MIN_ROLE`);
      assert.ok(canAccessPage('super_admin', item.page), `super_admin clears every nav gate (${item.page})`);
    }
  }
});

// ─── §4/§5/§6: Super Admin has NO organization-switching UX ────────────────

test('CLEANUP-9: Super Admin never renders the OrgSwitcher (UI only — switch API stays)', async () => {
  const { existsSync, readFileSync: rf } = await import('node:fs');
  const switcherPath = resolve(ROOT, 'src/components/layout/org-switcher.tsx');
  assert.ok(existsSync(switcherPath), 'org-switcher.tsx remains (normal multi-membership users need it)');
  const src = rf(switcherPath, 'utf8');
  // The early-return guard must exclude super_admin.
  assert.ok(
    /if \(!token \|\| isSuperAdmin/.test(src),
    'OrgSwitcher early-return must exclude super_admin'
  );
  // The SA quick-create path is gone (one creation flow: the Control Center).
  assert.ok(!src.includes('Create Organization'), 'no quick-create dialog in OrgSwitcher');
  assert.ok(!src.includes("'/api/super-admin/organizations'"), 'no SA org-create API call in OrgSwitcher');
  // The switch API itself is NOT deleted.
  assert.ok(existsSync(resolve(ROOT, 'src/app/api/me/organization/switch/route.ts')), 'switch API preserved');
});

test('CLEANUP-10: Organization detail has no Switch to Organization action', () => {
  const detail = readFileSync(resolve(ROOT, 'src/components/super-admin/super-admin-organization-detail-page.tsx'), 'utf8');
  assert.ok(!/Switch to Organization/.test(detail), 'no switch button in org detail');
  assert.ok(!detail.includes('/api/me/organization/switch'), 'org detail must not call the switch API');
});

test('CLEANUP-11: orphan legacy admin pages are removed (APIs preserved)', async () => {
  const { existsSync: ex } = await import('node:fs');
  for (const rel of [
    'src/app/admin/packages',
    'src/app/admin/organizations/create',
    'src/app/admin/licenses',
  ]) {
    assert.ok(!ex(resolve(ROOT, rel)), `${rel} orphan page removed`);
  }
  // Underlying APIs stay: packages CRUD feeds the canonical Control Center UI.
  for (const rel of [
    'src/app/api/super-admin/packages/route.ts',
    'src/app/api/super-admin/packages/[id]/route.ts',
    'src/app/api/admin/licenses/route.ts',
    'src/app/api/admin/organizations/create/route.ts',
  ]) {
    assert.ok(ex(resolve(ROOT, rel)), `${rel} API preserved`);
  }
});

test('CLEANUP-12: exactly one canonical Packages UI with full CRUD', async () => {
  const { existsSync: ex } = await import('node:fs');
  assert.ok(!ex(resolve(ROOT, 'src/app/admin/packages')), 'no second Packages page');
  const canonical = readFileSync(resolve(ROOT, 'src/components/super-admin/sa-billing-pages.tsx'), 'utf8');
  assert.ok(canonical.includes("'/api/super-admin/packages'"), 'canonical page reads the package API');
  assert.ok(/method: editing \? 'PATCH' : 'POST'/.test(canonical), 'canonical page supports create/edit (POST/PATCH)');
  assert.ok(/method: 'DELETE'/.test(canonical), 'canonical page supports delete (DELETE)');
  assert.ok(/isActive: !p\.isActive/.test(canonical), 'canonical page supports activate/deactivate');
});

test('CLEANUP-13: tenant self-checkout is hidden from the shells (page/API kept)', async () => {
  const { existsSync: ex } = await import('node:fs');
  assert.ok(!navData.some((i) => i.page === 'billing'), 'no billing sidebar item');
  // Page and API remain available by URL — navigation cleanup only.
  assert.ok(ex(resolve(ROOT, 'src/app/dashboard/billing/page.tsx')), 'billing page kept');
  assert.ok(ex(resolve(ROOT, 'src/app/checkout/page.tsx')), 'checkout page kept');
});

test('CLEANUP-14: Overview is a lightweight landing — no duplicated analytics', () => {
  const overview = readFileSync(resolve(ROOT, 'src/components/super-admin/sa-overview-page.tsx'), 'utf8');
  assert.ok(/Manage Organizations/.test(overview), 'Overview links into the Organizations hub');
  // No subscription/license/invoice aggregates or analytics panels.
  for (const token of ['subscriptions', 'licenses', 'pendingInvoices', 'Panel title=', 'Deployment mode distribution']) {
    assert.ok(!overview.includes(token), `Overview must not duplicate ${token}`);
  }
});

test('CLEANUP-15: Super Admin has exactly one Organization creation path', () => {
  const orgsList = readFileSync(resolve(ROOT, 'src/components/super-admin/super-admin-organizations-page.tsx'), 'utf8');
  assert.ok(orgsList.includes('sa-create-organization'), 'orgs list links into the canonical provisioning flow');
  // The full provisioning flow (with Service Type + Package + admin) is intact.
  const flow = readFileSync(resolve(ROOT, 'src/components/super-admin/organization-provision-flow.tsx'), 'utf8');
  assert.ok(flow.includes("value: 'MANAGED'") && flow.includes("value: 'CUSTOMER_DB'") && flow.includes("value: 'PRIVATE'"), 'provisioning flow keeps Service Type selection');
  assert.ok(flow.includes("'/api/admin/organizations/create'"), 'provisioning flow calls the canonical create API');
});
