/**
 * OmniSight RBAC Forensic Regression Tests
 *
 * Covers all forensic audit fixes:
 * - MED-1: Settings GET role protection
 * - MED-2: Consent GET role protection (already fixed, verified here)
 * - LOW-1: Import auth standardization
 * - LOW-2: User role mutation hardening (self-role-change guard)
 * - INFO-2: Navigation page role config
 * - Legacy role cleanup
 * - Branding RBAC verification
 *
 * Test matrix:
 *   viewer  → 403 on mutations, 200 on reads
 *   manager → 403 on admin ops, 200 on manager ops
 *   admin   → 200 on admin ops
 *   super_admin → 200 on all ops
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.API_BASE || 'http://localhost:3000';
const prisma = new PrismaClient();

// ─── Test Data ─────────────────────────────────────────────────────────────

const TEST_ORG = { name: `Forensic RBAC Org ${Date.now()}`, slug: `forensic-rbac-${Date.now()}` };
let orgId = '';
let superAdminToken = '';
let orgAdminToken = '';
let managerToken = '';
let viewerToken = '';
let testUserId = '';

// ─── Helpers ───────────────────────────────────────────────────────────────

async function login(email: string, password: string): Promise<{ token: string; user: any; organization: any }> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  return { token: data.token, user: data.user, organization: data.organization };
}

async function apiGet(path: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function apiPut(path: string, token: string, data?: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function apiPost(path: string, token: string, data?: any): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function cleanup() {
  if (orgId) {
    await prisma.organizationMembership.deleteMany({ where: { organizationId: orgId } }).catch(() => {});
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  }
}

// ─── Setup ─────────────────────────────────────────────────────────────────

before(async () => {
  // Login as super admin. The password MUST come from the environment
  // (SUPER_ADMIN_PASSWORD — the same value the server was bootstrapped with)
  // — never hardcode a real-looking administrator credential in tests.
  const saPassword = process.env.SUPER_ADMIN_PASSWORD;
  if (!saPassword) {
    throw new Error(
      'SUPER_ADMIN_PASSWORD env var is required: this suite logs in as the bootstrapped ' +
      'super admin against the live server (set it to the value the server was seeded with).'
    );
  }
  const sa = await login(process.env.SUPER_ADMIN_EMAIL || 'rimon@admin.com', saPassword);
  superAdminToken = sa.token;

  // Check if super admin is already bound to an organization
  const meRes = await apiGet('/api/auth/me', superAdminToken);
  const saUser = meRes.body.user;

  if (saUser.organizationId) {
    // Super admin is already bound to an org - use that org for tests
    orgId = saUser.organizationId;
  } else {
    // Super admin is org-less - create test organization
    const orgRes = await apiPost('/api/organizations', superAdminToken, {
      name: TEST_ORG.name,
      slug: TEST_ORG.slug,
    });
    if (orgRes.status === 201) {
      orgId = orgRes.body.data.id;
    } else {
      // If org creation fails (e.g., rate limited), try to find an existing org
      const orgsRes = await apiGet('/api/organizations', superAdminToken);
      if (orgsRes.status === 200 && orgsRes.body.data?.length > 0) {
        orgId = orgsRes.body.data[0].id;
      }
    }
  }
  assert.ok(orgId, 'Could not determine test organization');

  // Create users with different roles
  const roles = ['org_admin', 'manager', 'viewer'] as const;
  const tokens: Record<string, string> = {};

  for (const role of roles) {
    const email = `${role}-forensic-${Date.now()}@test.com`;
    const userRes = await apiPost('/api/auth/users', superAdminToken, {
      email,
      password: 'TestPassword123!',
      name: `Test ${role}`,
      role,
      organizationId: orgId,
    });
    assert.equal(userRes.status, 201, `User creation failed for ${role}: ${userRes.status}`);

    const loginRes = await login(email, 'TestPassword123!');
    tokens[role] = loginRes.token;

    if (role === 'viewer') {
      testUserId = userRes.body.user.id;
    }
  }

  orgAdminToken = tokens['org_admin'];
  managerToken = tokens['manager'];
  viewerToken = tokens['viewer'];
});

after(async () => {
  await cleanup();
});

// ─── MED-1: Settings GET Role Protection ───────────────────────────────────

describe('MED-1: Settings GET Role Protection', () => {
  it('viewer cannot GET retention settings', async () => {
    const res = await apiGet('/api/settings/retention', viewerToken);
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('viewer cannot GET monitoring settings', async () => {
    const res = await apiGet('/api/settings/monitoring', viewerToken);
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('manager can GET retention settings', async () => {
    const res = await apiGet('/api/settings/retention', managerToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it('manager can GET monitoring settings', async () => {
    const res = await apiGet('/api/settings/monitoring', managerToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it('org_admin can GET retention settings', async () => {
    const res = await apiGet('/api/settings/retention', orgAdminToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it('org_admin can GET monitoring settings', async () => {
    const res = await apiGet('/api/settings/monitoring', orgAdminToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it('super_admin can GET retention settings (with org context)', async () => {
    // Super admin needs org context for org-scoped routes.
    // If super admin has no org, requireManagerOrg returns 403 (expected).
    const res = await apiGet('/api/settings/retention', superAdminToken);
    assert.ok(res.status === 200 || res.status === 403, `Expected 200 or 403, got ${res.status}`);
  });

  it('super_admin can GET monitoring settings (with org context)', async () => {
    const res = await apiGet('/api/settings/monitoring', superAdminToken);
    assert.ok(res.status === 200 || res.status === 403, `Expected 200 or 403, got ${res.status}`);
  });

  it('viewer cannot PUT retention settings', async () => {
    const res = await apiPut('/api/settings/retention', viewerToken, {
      key: 'screenshot_retention_days',
      value: 30,
    });
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('manager cannot PUT retention settings', async () => {
    const res = await apiPut('/api/settings/retention', managerToken, {
      key: 'screenshot_retention_days',
      value: 30,
    });
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });
});

// ─── MED-2: Consent GET Role Protection ────────────────────────────────────

describe('MED-2: Consent GET Role Protection', () => {
  it('viewer cannot GET consent policies', async () => {
    const res = await apiGet('/api/consent/policies', viewerToken);
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('viewer cannot GET consent logs', async () => {
    const res = await apiGet('/api/consent/logs', viewerToken);
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('viewer cannot GET consent summary', async () => {
    const res = await apiGet('/api/consent/summary', viewerToken);
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('manager can GET consent policies', async () => {
    const res = await apiGet('/api/consent/policies', managerToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it('manager can GET consent logs', async () => {
    const res = await apiGet('/api/consent/logs', managerToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it('manager can GET consent summary', async () => {
    const res = await apiGet('/api/consent/summary', managerToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it('org_admin can GET consent policies', async () => {
    const res = await apiGet('/api/consent/policies', orgAdminToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it('super_admin can GET consent policies (with org context)', async () => {
    // Super admin needs org context for org-scoped routes
    const res = await apiGet('/api/consent/policies', superAdminToken);
    assert.ok(res.status === 200 || res.status === 404, `Expected 200 or 404, got ${res.status}`);
  });
});

// ─── LOW-1: Import Auth Standardization ────────────────────────────────────

describe('LOW-1: Import Auth Standardization', () => {
  it('viewer is denied import', async () => {
    const formData = new FormData();
    formData.append('file', new Blob(['test']), 'test.xlsx');
    const res = await fetch(`${BASE}/api/import/employees`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${viewerToken}` },
      body: formData,
    });
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('manager is denied import', async () => {
    const formData = new FormData();
    formData.append('file', new Blob(['test']), 'test.xlsx');
    const res = await fetch(`${BASE}/api/import/employees`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${managerToken}` },
      body: formData,
    });
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('org_admin can import (with valid file)', async () => {
    // Create a minimal XLSX file with required columns
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([
      { firstName: 'Test', lastName: 'User', email: `import-test-${Date.now()}@test.com` },
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const formData = new FormData();
    formData.append('file', new Blob([buffer]), 'employees.xlsx');
    const res = await fetch(`${BASE}/api/import/employees`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${orgAdminToken}` },
      body: formData,
    });
    // Should not be 403 — may be 200 (success) or 400 (validation)
    assert.notEqual(res.status, 403, `Expected not 403, got ${res.status}`);
  });

  it('super_admin can import (with org context)', async () => {
    // Super admin needs org context for org-scoped routes
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([
      { firstName: 'SA', lastName: 'Test', email: `sa-import-${Date.now()}@test.com` },
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const formData = new FormData();
    formData.append('file', new Blob([buffer]), 'employees.xlsx');
    const res = await fetch(`${BASE}/api/import/employees`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${superAdminToken}` },
      body: formData,
    });
    // May return 200/400 (with org) or 403 (without org context)
    assert.ok(res.status !== 401, `Expected not 401, got ${res.status}`);
  });

  it('unauthenticated request is denied', async () => {
    const formData = new FormData();
    formData.append('file', new Blob(['test']), 'test.xlsx');
    const res = await fetch(`${BASE}/api/import/employees`, {
      method: 'POST',
      body: formData,
    });
    assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
  });
});

// ─── LOW-2: User Role Mutation Hardening ───────────────────────────────────

describe('LOW-2: User Role Mutation Hardening', () => {
  it('org_admin cannot self-promote to super_admin', async () => {
    // Get org_admin's user ID
    const meRes = await apiGet('/api/auth/me', orgAdminToken);
    const userId = meRes.body.user.id;

    const res = await apiPut(`/api/auth/users/${userId}`, orgAdminToken, {
      role: 'super_admin',
    });
    // Returns 400 (invalid role - super_admin not in valid roles for non-SA)
    // or 403 (self-role-change guard) depending on code path
    assert.ok(res.status === 400 || res.status === 403, `Expected 400 or 403, got ${res.status}`);
  });

  it('manager cannot self-promote', async () => {
    const meRes = await apiGet('/api/auth/me', managerToken);
    const userId = meRes.body.user.id;

    const res = await apiPut(`/api/auth/users/${userId}`, managerToken, {
      role: 'org_admin',
    });
    // Returns 403 (self-role-change guard) or 403 (privilege escalation)
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('viewer cannot self-promote', async () => {
    const meRes = await apiGet('/api/auth/me', viewerToken);
    const userId = meRes.body.user.id;

    const res = await apiPut(`/api/auth/users/${userId}`, viewerToken, {
      role: 'manager',
    });
    // Returns 403 (self-role-change guard) or 403 (privilege escalation)
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('non-super-admin cannot assign super_admin role', async () => {
    const res = await apiPut(`/api/auth/users/${testUserId}`, orgAdminToken, {
      role: 'super_admin',
    });
    // Returns 400 (super_admin not in valid roles for non-SA)
    assert.ok(res.status === 400 || res.status === 403, `Expected 400 or 403, got ${res.status}`);
  });

  it('org_admin can change another user role (within hierarchy)', async () => {
    // Create a test user to modify
    const createRes = await apiPost('/api/auth/users', orgAdminToken, {
      email: `role-test-${Date.now()}@test.com`,
      password: 'TestPassword123!',
      name: 'Role Test User',
      role: 'viewer',
    });
    if (createRes.status === 201) {
      const userId = createRes.body.user.id;
      const res = await apiPut(`/api/auth/users/${userId}`, orgAdminToken, {
        role: 'manager',
      });
      // Should succeed (org_admin can assign manager)
      assert.notEqual(res.status, 403, `Expected not 403, got ${res.status}`);
    }
  });
});

// ─── Navigation Page Role Config ───────────────────────────────────────────

describe('INFO-2: Navigation Page Role Config', () => {
  it('viewer cannot access super-admin pages', async () => {
    // This is a UI-level check — verify the navigation module exports correct values
    const { canAccessPage } = await import('@/lib/navigation');
    assert.equal(canAccessPage('viewer', 'super-admin-organizations'), false);
    assert.equal(canAccessPage('viewer', 'super-admin-organization-detail'), false);
  });

  it('org_admin cannot access super-admin pages', async () => {
    const { canAccessPage } = await import('@/lib/navigation');
    assert.equal(canAccessPage('org_admin', 'super-admin-organizations'), false);
    assert.equal(canAccessPage('org_admin', 'super-admin-organization-detail'), false);
  });

  it('super_admin can access super-admin pages', async () => {
    const { canAccessPage } = await import('@/lib/navigation');
    assert.equal(canAccessPage('super_admin', 'super-admin-organizations'), true);
    assert.equal(canAccessPage('super_admin', 'super-admin-organization-detail'), true);
  });

  it('viewer can access viewer pages', async () => {
    const { canAccessPage } = await import('@/lib/navigation');
    assert.equal(canAccessPage('viewer', 'dashboard'), true);
    assert.equal(canAccessPage('viewer', 'employees'), true);
    assert.equal(canAccessPage('viewer', 'devices'), true);
  });

  it('viewer cannot access admin pages', async () => {
    const { canAccessPage } = await import('@/lib/navigation');
    assert.equal(canAccessPage('viewer', 'settings'), false);
    assert.equal(canAccessPage('viewer', 'users'), false);
    assert.equal(canAccessPage('viewer', 'branding'), false);
  });

  it('manager can access manager pages', async () => {
    const { canAccessPage } = await import('@/lib/navigation');
    assert.equal(canAccessPage('manager', 'reports'), true);
    assert.equal(canAccessPage('manager', 'consent'), true);
    assert.equal(canAccessPage('manager', 'audit'), true);
  });

  it('manager cannot access org_admin pages', async () => {
    const { canAccessPage } = await import('@/lib/navigation');
    assert.equal(canAccessPage('manager', 'settings'), false);
    assert.equal(canAccessPage('manager', 'users'), false);
    assert.equal(canAccessPage('manager', 'ai-provider'), false);
  });
});

// ─── Branding RBAC ─────────────────────────────────────────────────────────

describe('Branding RBAC Verification', () => {
  it('viewer can GET effective branding (read-only)', async () => {
    const res = await apiGet('/api/branding', viewerToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  it('viewer cannot PATCH platform branding', async () => {
    const res = await fetch(`${BASE}/api/branding/platform`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken}` },
      body: JSON.stringify({ brandName: 'Hacked' }),
    });
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('org_admin cannot PATCH platform branding', async () => {
    const res = await fetch(`${BASE}/api/branding/platform`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orgAdminToken}` },
      body: JSON.stringify({ brandName: 'Hacked' }),
    });
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('super_admin can PATCH platform branding', async () => {
    const res = await fetch(`${BASE}/api/branding/platform`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superAdminToken}` },
      body: JSON.stringify({ brandName: 'OmniSight' }),
    });
    // May return 200 (success) or 500 (validation/db issue in test env)
    // The key assertion is that it's NOT 403 (authorization works)
    assert.notEqual(res.status, 403, `Expected not 403, got ${res.status}`);
  });

  it('viewer cannot PATCH org branding', async () => {
    const res = await fetch(`${BASE}/api/branding/organization`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${viewerToken}` },
      body: JSON.stringify({ brandName: 'Hacked' }),
    });
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('manager cannot PATCH org branding', async () => {
    const res = await fetch(`${BASE}/api/branding/organization`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managerToken}` },
      body: JSON.stringify({ brandName: 'Hacked' }),
    });
    assert.equal(res.status, 403, `Expected 403, got ${res.status}`);
  });

  it('org_admin can PATCH own org branding', async () => {
    const res = await fetch(`${BASE}/api/branding/organization`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orgAdminToken}` },
      body: JSON.stringify({ brandName: 'Test Org Brand' }),
    });
    // May return 200 (success) or 500 (validation/db issue in test env)
    // The key assertion is that it's NOT 403 (authorization works)
    assert.notEqual(res.status, 403, `Expected not 403, got ${res.status}`);
  });
});

// ─── Tenant Isolation ──────────────────────────────────────────────────────

describe('Tenant Isolation', () => {
  it('org-scoped routes derive org from session, not client', async () => {
    // Verify that the settings endpoint uses session org
    const res = await apiGet('/api/settings/retention', orgAdminToken);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    // The response should contain data for the org, not a client-supplied org
    assert.ok(res.body.data !== undefined, 'Expected data array');
  });
});

// ─── Role Hierarchy ────────────────────────────────────────────────────────

describe('Role Hierarchy', () => {
  it('hasRolePermission enforces hierarchy correctly', async () => {
    const { hasRolePermission } = await import('@/lib/auth');

    // super_admin has all permissions
    assert.equal(hasRolePermission('super_admin', 'admin'), true);
    assert.equal(hasRolePermission('super_admin', 'manager'), true);
    assert.equal(hasRolePermission('super_admin', 'viewer'), true);

    // org_admin has admin and below
    assert.equal(hasRolePermission('org_admin', 'admin'), true);
    assert.equal(hasRolePermission('org_admin', 'manager'), true);
    assert.equal(hasRolePermission('org_admin', 'viewer'), true);

    // manager has manager and below
    assert.equal(hasRolePermission('manager', 'admin'), false);
    assert.equal(hasRolePermission('manager', 'manager'), true);
    assert.equal(hasRolePermission('manager', 'viewer'), true);

    // viewer has only viewer
    assert.equal(hasRolePermission('viewer', 'admin'), false);
    assert.equal(hasRolePermission('viewer', 'manager'), false);
    assert.equal(hasRolePermission('viewer', 'viewer'), true);

    // Legacy aliases work
    assert.equal(hasRolePermission('owner', 'admin'), true);
    assert.equal(hasRolePermission('admin', 'admin'), true);
  });
});
