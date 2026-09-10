/**
 * Super Admin Control Center — Final UI Regression Tests
 *
 * Proves the final information architecture:
 *   - Sidebar: exactly 4 primary Control Center items (Overview,
 *     Organizations, Packages, Landing Page) — nothing else
 *   - No duplicate "Home / Control Center — Overview" breadcrumb for SA
 *   - Audit Logs reachable from Overview (sa-audit page key), NOT a sidebar item
 *   - Overview uses real APIs (metrics + audit), no fake data
 *   - Landing Page editor has a real "View Landing Page" action (public route)
 *   - Landing defaults exist (no empty landing page on fresh installs)
 *
 * Run: npx tsx --test tests/sa-final-ui.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolve } from 'path';

function src(rel: string): string {
  return readFileSync(resolve(__dirname, '../src', rel), 'utf8');
}

describe('SA-UI sidebar contract', () => {
  const nav = src('lib/sidebar-nav.ts');

  test('SA-UI-01: Control Center group has exactly the 4 primary items', () => {
    const groupMatch = nav.match(/id: 'control-center',[\s\S]*?items: \[([\s\S]*?)\n    \]/);
    assert.ok(groupMatch, 'control-center group found');
    const pages = [...groupMatch[1].matchAll(/page: '([^']+)'/g)].map((m) => m[1]);
    assert.deepEqual(pages, ['sa-overview', 'super-admin-organizations', 'sa-packages', 'sa-landing']);
  });

  test('SA-UI-02: no standalone Subscriptions/Payments/Licenses/Agents/Storage/AI/Health/Leads nav items', () => {
    for (const forbidden of ['sa-subscriptions', 'sa-payments', 'sa-licenses', 'sa-agents', 'sa-storage', 'sa-ai-usage', 'sa-health', 'sa-leads']) {
      assert.ok(!nav.includes(`page: '${forbidden}'`), `no ${forbidden} sidebar item`);
    }
  });

  test('SA-UI-03: sa-audit is NOT a sidebar item (reachable from Overview only)', () => {
    assert.ok(!nav.includes("page: 'sa-audit'"), 'Audit must not be a primary sidebar item');
  });
});

describe('SA-UI header/breadcrumb contract', () => {
  const header = src('components/layout/app-header.tsx');

  test('SA-UI-04: SA header shows clean page labels (no "Control Center — X" duplication)', () => {
    assert.ok(!header.includes("'Control Center — Overview'"), 'no duplicated Control Center label');
    assert.ok(header.includes("'sa-overview': 'Overview'"), 'clean Overview label');
  });

  test('SA-UI-05: Home breadcrumb suppressed for super_admin', () => {
    assert.ok(
      header.includes("authUser?.role !== 'super_admin'") && header.includes("<span>Home</span>"),
      'Home crumb must be gated to non-SA users'
    );
  });

  test('SA-UI-06: tenant users keep the breadcrumb', () => {
    // The breadcrumb nav element still exists
    assert.ok(header.includes('aria-label="Breadcrumb"'));
  });
});

describe('SA-UI Overview contract', () => {
  const overview = src('components/super-admin/sa-overview-page.tsx');

  test('SA-UI-07: Overview KPIs come from the real metrics API', () => {
    assert.ok(overview.includes("'/api/super-admin/metrics'"), 'real metrics API');
    assert.ok(!overview.includes('Math.random'), 'no fake/random data');
  });

  test('SA-UI-08: Overview has Quick Actions into all 4 primary surfaces', () => {
    for (const target of ['sa-create-organization', 'super-admin-organizations', 'sa-packages', 'sa-landing']) {
      assert.ok(overview.includes(`setCurrentPage('${target}')`), `quick action to ${target}`);
    }
  });

  test('SA-UI-09: Recent Activity uses the real audit API with empty state', () => {
    assert.ok(overview.includes("'/api/super-admin/audit"), 'real audit API');
    assert.ok(overview.includes('No control-plane activity yet.'), 'useful empty state');
    assert.ok(overview.includes("'sa-audit'"), 'View Audit Logs shortcut');
  });

  test('SA-UI-10: Overview has no tenant operational calls', () => {
    for (const forbidden of ['/api/employees', '/api/devices', '/api/screenshots', '/api/activities']) {
      assert.ok(!overview.includes(forbidden), `no ${forbidden}`);
    }
  });
});

describe('SA-UI audit page contract', () => {
  const auditPage = src('components/super-admin/sa-audit-page.tsx');
  const auditApi = src('app/api/super-admin/audit/route.ts');

  test('SA-UI-11: audit page uses the SA-gated audit API with pagination', () => {
    assert.ok(auditPage.includes('/api/super-admin/audit'), 'uses the SA audit endpoint');
    assert.ok(auditPage.includes('pageSize'), 'paginated request');
  });

  test('SA-UI-12: audit API is Super Admin-gated', () => {
    assert.ok(auditApi.includes('requireSuperAdmin'), 'server-side SA authorization');
  });

  test('SA-UI-13: sa-audit registered in shell but SA-gated in navigation', () => {
    assert.ok(src('app/page.tsx').includes("'sa-audit': SuperAdminAuditPage"), 'shell registry');
    assert.ok(src('lib/navigation.ts').includes("'sa-audit': 'super_admin'"), 'SA-only permission');
  });
});

describe('SA-UI landing page contract', () => {
  const editor = src('components/super-admin/sa-landing-page.tsx');

  test('SA-UI-14: editor has a real View Landing Page action to the public route', () => {
    assert.ok(editor.includes('View Landing Page'), 'View button present');
    assert.ok(/href="\/"\s+target="_blank"/.test(editor), 'opens the actual public landing page');
  });

  test('SA-UI-15: public landing renders defaults when no saved content exists', () => {
    const hero = src('components/landing/HeroSection.tsx');
    // Defaults are used when the override is absent (no empty landing page)
    assert.ok(hero.includes('h.title && h.title.length > 0 ? h.title : HEADING_LINES'), 'hero falls back to built-in copy');
    assert.ok(hero.includes('Understand How Work Happens.'), 'demo content present');
  });

  test('SA-UI-16: landing editor keeps Save + Restore defaults', () => {
    assert.ok(editor.includes('Save changes'), 'save present');
    assert.ok(editor.includes('Restore defaults'), 'reset present');
  });
});
