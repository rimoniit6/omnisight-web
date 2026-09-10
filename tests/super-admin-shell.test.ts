/**
 * Super Admin Shell — Role-Aware UI Regression Tests
 *
 * Proves the shell respects the platform rule: the Super Admin is a
 * control-plane operator, never a tenant operator.
 *
 *   - Header: no NotificationBell, no "Open Live Monitor" shortcut, no tenant
 *     Settings item for super_admin (tenant users keep all three)
 *   - Command palette: hidden tenant pages are NOT discoverable via Ctrl+K —
 *     the palette reuses the single authoritative canAccessPage gate
 *   - Sidebar: exactly the 4 Control Center items (regression from prior suite)
 *   - Server-side: notifications API scopes by session org; org-less SA gets
 *     an empty payload (no tenant leakage even if a client were modified)
 *
 * Run: npx tsx --test tests/super-admin-shell.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function src(rel: string): string {
  return readFileSync(resolve(__dirname, '../src', rel), 'utf8');
}

describe('SA-SHELL header role-awareness', () => {
  const header = src('components/layout/app-header.tsx');

  test('SA-SHELL-01: NotificationBell hidden for super_admin, kept for tenants', () => {
    assert.ok(header.includes('{!isSuperAdmin && ('), 'role guard present');
    assert.ok(/!\s*isSuperAdmin && \(\s*<div data-tour-target="notifications">/.test(header), 'bell gated');
    assert.ok(header.includes('<NotificationBell />'), 'bell component still used for tenants');
  });

  test('SA-SHELL-02: "Open Live Monitor" shortcut hidden for super_admin', () => {
    assert.ok(header.includes("Open Live Monitor"), 'tenant shortcut exists');
    assert.ok(
      /!\s*isSuperAdmin && \(\s*<div className="px-4 py-2 border-t">/.test(header),
      'live-monitor shortcut gated behind !isSuperAdmin'
    );
  });

  test('SA-SHELL-03: tenant Settings item hidden from SA user menu', () => {
    assert.ok(
      /!\s*isSuperAdmin && \(\s*<DropdownMenuItem onClick=\{\(\) => setCurrentPage\('settings'\)\}/.test(header),
      'Settings menu item gated'
    );
  });

  test('SA-SHELL-04: Change Password + Logout remain for SA (account-level actions)', () => {
    assert.ok(header.includes('Change Password'), 'change password present');
    assert.ok(header.includes('Logout'), 'logout present');
  });

  test('SA-SHELL-05: OrgSwitcher still excluded for super_admin (regression)', () => {
    const switcher = src('components/layout/org-switcher.tsx');
    assert.ok(/if \(!token \|\| isSuperAdmin/.test(switcher), 'OrgSwitcher SA guard intact');
  });

  test('SA-SHELL-06: SA breadcrumb stays clean (no Home crumb) — regression', () => {
    assert.ok(
      header.includes("authUser?.role !== 'super_admin'") && header.includes('<span>Home</span>'),
      'Home crumb gated to non-SA'
    );
  });
});

describe('SA-SHELL command palette', () => {
  const palette = src('components/layout/command-palette.tsx');

  test('SA-SHELL-07: palette filters pages through the authoritative canAccessPage gate', () => {
    assert.ok(palette.includes("import { canAccessPage } from '@/lib/navigation'"), 'central gate imported');
    assert.ok(palette.includes('visiblePages'), 'filtered list used');
    assert.ok(!/pages\.map\(\(p\) =>/.test(palette), 'unfiltered pages.map no longer rendered');
  });

  test('SA-SHELL-08: org-less SA cannot navigate into tenant pages via palette', () => {
    assert.ok(palette.includes("p.key.startsWith('sa-')"), 'org-context guard present');
  });

  test('SA-SHELL-09: tenant search remains intact for org users', () => {
    assert.ok(palette.includes('/api/search'), 'employee/department/device search preserved');
  });
});

describe('SA-SHELL server-side safety (not just UI hiding)', () => {
  test('SA-SHELL-10: notifications API is organization-scoped; org-less SA gets empty payload', async () => {
    const api = src('app/api/notifications/route.ts');
    assert.ok(api.includes('requireSessionOrg'), 'session-derived org scope');
    assert.ok(api.includes('organizationId: orgId'), 'query scoped to session org');
    assert.ok(api.includes('data: [], total: 0'), 'org-less global scope returns empty payload');
  });

  test('SA-SHELL-11: tenant page APIs require an active session org (direct-URL protection)', () => {
    // requireActiveSessionOrg rejects org-less callers unless allowGlobal —
    // tenant operational APIs do not pass allowGlobal.
    const apiLib = src('lib/api.ts');
    assert.ok(apiLib.includes('opts.allowGlobal && auth.role'), 'allowGlobal is opt-in');
    assert.ok(
      !src('app/api/notifications/route.ts').match(/PUT[\s\S]*allowGlobal/),
      'notification mutations are not globally accessible'
    );
  });

  test('SA-SHELL-12: sidebar contract regression — exactly 5 Control Center items', () => {
    const nav = src('lib/sidebar-nav.ts');
    const groupMatch = nav.match(/id: 'control-center',[\s\S]*?items: \[([\s\S]*?)\n    \]/);
    assert.ok(groupMatch, 'control-center group found');
    const pages = [...groupMatch[1].matchAll(/page: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(pages, ['sa-overview', 'super-admin-organizations', 'sa-packages', 'sa-infra-requests', 'sa-landing']);
  });
});
