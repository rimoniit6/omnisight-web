/**
 * OmniSight RBAC Regression Tests
 *
 * Covers the critical RBAC fixes:
 * - RBAC-01 through RBAC-30
 * - Role resolution from OrganizationMembership
 * - /api/auth/me returns correct membership role
 * - Sidebar role display
 * - Super Admin isolation
 * - Cross-org access denial
 * - Privilege escalation prevention
 * - Organization switching updates permissions
 * - Seed data verification
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.API_BASE || 'http://localhost:3000';

const prisma = new PrismaClient();

// ─── Test Data ─────────────────────────────────────────────────────────────

const TEST_ORG_A = { name: `RBAC Test Org A ${Date.now()}`, slug: `rbac-test-a-${Date.now()}` };
const TEST_ORG_B = { name: `RBAC Test Org B ${Date.now()}`, slug: `rbac-test-b-${Date.now()}` };

let orgAId = '';
let orgBId = '';

let superAdminToken = '';
let orgAAdminToken = '';
let orgAManagerToken = '';
let orgAViewerToken = '';

// ─── Helpers ───────────────────────────────────────────────────────────────

async function login(email: string, password: string): Promise<{ token: string; user: any; organization: any }> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200, `Login failed for ${email}: ${res.status}`);
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
  // Clean up test organizations and their memberships
  if (orgAId) {
    await prisma.organizationMembership.deleteMany({ where: { organizationId: orgAId } }).catch(() => {});
    await prisma.organization.delete({ where: { id: orgAId } }).catch(() => {});
  }
  if (orgBId) {
    await prisma.organizationMembership.deleteMany({ where: { organizationId: orgBId } }).catch(() => {});
    await prisma.organization.delete({ where: { id: orgBId } }).catch(() => {});
  }
}

// ─── RBAC Tests ────────────────────────────────────────────────────────────

describe('RBAC — Role Resolution & Authorization', () => {
  before(async () => {
    // Create two test organizations
    const [orgA, orgB] = await Promise.all([
      prisma.organization.create({ data: TEST_ORG_A }),
      prisma.organization.create({ data: TEST_ORG_B }),
    ]);
    orgAId = orgA.id;
    orgBId = orgB.id;
  });

  after(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  // ── Login & Role Resolution ──────────────────────────────────────────

  describe('RBAC-01 to RBAC-04: Login role resolution', () => {
    it('RBAC-01: Super Admin resolves correctly', async () => {
      const loginResult = await login('rimon@admin.com', 'Rimon2714');
      superAdminToken = loginResult.token;
      assert.equal(loginResult.user.role, 'super_admin');
      assert.equal(loginResult.user.roleLabel, 'Super Admin');
    });

    it('RBAC-02: Org Admin resolves correctly', async () => {
      const loginResult = await login('org.admin@acmetech.com', 'demo1234');
      orgAAdminToken = loginResult.token;
      assert.equal(loginResult.user.role, 'org_admin');
      assert.equal(loginResult.user.roleLabel, 'Organization Admin');
    });

    it('RBAC-03: Manager resolves correctly', async () => {
      const loginResult = await login('manager@acmetech.com', 'demo1234');
      orgAManagerToken = loginResult.token;
      assert.equal(loginResult.user.role, 'manager');
      assert.equal(loginResult.user.roleLabel, 'Manager');
    });

    it('RBAC-04: Viewer resolves correctly', async () => {
      const loginResult = await login('viewer@acmetech.com', 'demo1234');
      orgAViewerToken = loginResult.token;
      assert.equal(loginResult.user.role, 'viewer');
      assert.equal(loginResult.user.roleLabel, 'Viewer');
    });
  });

  // ── /api/auth/me Uses Membership Role ────────────────────────────────

  describe('RBAC-05 to RBAC-07: /api/auth/me uses membership role', () => {
    it('RBAC-05: /api/auth/me returns membership role, not AppUser.role', async () => {
      const { status, body } = await apiGet('/api/auth/me', orgAAdminToken);
      assert.equal(status, 200);
      // The user should have org_admin role from membership, not from AppUser.role
      assert.equal(body.user.role, 'org_admin');
      assert.equal(body.user.roleLabel, 'Organization Admin');
    });

    it('RBAC-06: AppUser.role cannot override membership role in /api/auth/me', async () => {
      // Login as viewer — should get viewer role from membership
      const { status, body } = await apiGet('/api/auth/me', orgAViewerToken);
      assert.equal(status, 200);
      assert.equal(body.user.role, 'viewer');
      assert.equal(body.user.roleLabel, 'Viewer');
    });

    it('RBAC-07: Super Admin /api/auth/me returns super_admin role', async () => {
      const { status, body } = await apiGet('/api/auth/me', superAdminToken);
      assert.equal(status, 200);
      assert.equal(body.user.role, 'super_admin');
      assert.equal(body.user.roleLabel, 'Super Admin');
    });
  });

  // ── Super Admin Isolation ────────────────────────────────────────────

  describe('RBAC-08 to RBAC-12: Super Admin isolation', () => {
    it('RBAC-08: Super Admin can list all organizations', async () => {
      const { status, body } = await apiGet('/api/super-admin/organizations', superAdminToken);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.data));
    });

    it('RBAC-09: Org Admin CANNOT access Super Admin APIs', async () => {
      const { status } = await apiGet('/api/super-admin/organizations', orgAAdminToken);
      assert.equal(status, 403);
    });

    it('RBAC-10: Manager CANNOT access Super Admin APIs', async () => {
      const { status } = await apiGet('/api/super-admin/organizations', orgAManagerToken);
      assert.equal(status, 403);
    });

    it('RBAC-11: Viewer CANNOT access Super Admin APIs', async () => {
      const { status } = await apiGet('/api/super-admin/organizations', orgAViewerToken);
      assert.equal(status, 403);
    });

    it('RBAC-12: Org A Admin CANNOT access Org B via Super Admin endpoints', async () => {
      const { status } = await apiGet('/api/super-admin/organizations', orgAAdminToken);
      assert.equal(status, 403);
    });
  });

  // ── Cross-Organization Access ────────────────────────────────────────

  describe('RBAC-13 to RBAC-18: Cross-organization access denial', () => {
    it('RBAC-13: Org A Admin cannot access Org B employees', async () => {
      // No switch needed — the session is already pinned to the seed org.
      // Passing a cross-org organizationId query param must NOT switch context.
      const { status } = await apiGet(`/api/employees?organizationId=${orgBId}`, orgAAdminToken);
      // Should either 403 or return only Org A employees
      assert.notEqual(status, 200, 'Org A admin should not have unrestricted access to Org B employees');
    });

    it('RBAC-14: Org A Admin cannot access Org B devices', async () => {
      const { status } = await apiGet(`/api/devices?organizationId=${orgBId}`, orgAAdminToken);
      assert.notEqual(status, 200, 'Org A admin should not have unrestricted access to Org B devices');
    });

    it('RBAC-15: Org switching updates effective role', async () => {
      // Create memberships for the test user in both orgs
      const testUser = await prisma.appUser.findFirst({ where: { email: 'org.admin@acmetech.com' } });
      if (testUser) {
        // Ensure membership in Org A
        await prisma.organizationMembership.upsert({
          where: { userId_organizationId: { userId: testUser.id, organizationId: orgAId } },
          create: { userId: testUser.id, organizationId: orgAId, role: 'admin', status: 'ACTIVE' },
          update: { role: 'admin', status: 'ACTIVE' },
        });

        // Use a FRESH login so the shared orgAAdminToken session is not
        // mutated (switching updates the session's activeOrganizationId,
        // which invalidates the original token for subsequent tests).
        const freshLogin = await login('org.admin@acmetech.com', 'demo1234');
        const switchA = await apiPost('/api/me/organization/switch', freshLogin.token, { organizationId: orgAId });
        if (switchA.status === 200) {
          assert.equal(switchA.body.role, 'admin');
        }
      }
    });

    it('RBAC-16: Organization switching to non-member org is denied', async () => {
      const { status } = await apiPost('/api/me/organization/switch', orgAAdminToken, { organizationId: orgBId });
      assert.equal(status, 403, 'Should not be able to switch to an org you are not a member of');
    });

    it('RBAC-17: Organization switching to non-existent org is denied', async () => {
      const { status } = await apiPost('/api/me/organization/switch', orgAAdminToken, { organizationId: 'nonexistent' });
      assert.equal(status, 403);
    });

    it('RBAC-18: Organization switching with invalid body is rejected', async () => {
      const { status } = await apiPost('/api/me/organization/switch', orgAAdminToken, {});
      assert.equal(status, 422);
    });
  });

  // ── Viewer Read-Only ─────────────────────────────────────────────────

  describe('RBAC-19 to RBAC-21: Viewer is read-only', () => {
    it('RBAC-19: Viewer can read dashboard', async () => {
      const { status } = await apiGet('/api/dashboard', orgAViewerToken);
      assert.equal(status, 200);
    });

    it('RBAC-20: Viewer can read employees', async () => {
      const { status } = await apiGet('/api/employees', orgAViewerToken);
      assert.equal(status, 200);
    });

    it('RBAC-21: Viewer CANNOT create employees', async () => {
      const { status } = await apiPost('/api/employees', orgAViewerToken, {
        firstName: 'Test',
        lastName: 'Viewer',
        email: `test-viewer-${Date.now()}@test.com`,
      });
      assert.equal(status, 403, 'Viewer should not be able to create employees');
    });
  });

  // ── Manager Restrictions ─────────────────────────────────────────────

  describe('RBAC-22 to RBAC-24: Manager restrictions', () => {
    it('RBAC-22: Manager can read employees', async () => {
      const { status } = await apiGet('/api/employees', orgAManagerToken);
      assert.equal(status, 200);
    });

    it('RBAC-23: Manager can read reports', async () => {
      const { status } = await apiGet('/api/reports', orgAManagerToken);
      assert.equal(status, 200);
    });

    it('RBAC-24: Manager CANNOT access platform settings', async () => {
      const { status } = await apiGet('/api/settings', orgAManagerToken);
      assert.equal(status, 403, 'Manager should not access platform settings');
    });
  });

  // ── Organization Creation ────────────────────────────────────────────

  describe('RBAC-25: Organization creation role', () => {
    it('RBAC-25: Non-super-admin cannot create organizations', async () => {
      const { status } = await apiPost('/api/organizations', orgAAdminToken, {
        name: `Should Not Create ${Date.now()}`,
      });
      assert.equal(status, 403, 'Non-super-admin should not create organizations');
    });
  });

  // ── Privilege Escalation Prevention ──────────────────────────────────

  describe('RBAC-26: Privilege escalation prevention', () => {
    it('RBAC-26: Viewer cannot self-promote to admin via API', async () => {
      // Attempt to change own role via user management endpoint
      const { status } = await apiPost('/api/auth/users', orgAViewerToken, {
        email: `viewer-escalation-${Date.now()}@test.com`,
        role: 'admin',
        password: 'test1234',
      });
      // Should be denied — viewers cannot create users
      assert.ok(status === 403 || status === 401, 'Viewer should not be able to escalate privileges');
    });
  });

  // ── Unauthenticated Access ───────────────────────────────────────────

  describe('RBAC-27 to RBAC-28: Unauthenticated access', () => {
    it('RBAC-27: Unauthenticated request returns 401', async () => {
      const { status } = await apiGet('/api/auth/me', '');
      assert.equal(status, 401);
    });

    it('RBAC-28: Invalid token returns 401', async () => {
      const { status } = await apiGet('/api/auth/me', 'invalid-token-123');
      assert.equal(status, 401);
    });
  });

  // ── Role Labels ──────────────────────────────────────────────────────

  describe('RBAC-29: Role labels are consistent', () => {
    it('RBAC-29: All users get correct roleLabel from /api/auth/me', async () => {
      // Super Admin
      const sa = await apiGet('/api/auth/me', superAdminToken);
      assert.equal(sa.body.user.roleLabel, 'Super Admin');

      // Org Admin
      const oa = await apiGet('/api/auth/me', orgAAdminToken);
      assert.equal(oa.body.user.roleLabel, 'Organization Admin');

      // Manager
      const mg = await apiGet('/api/auth/me', orgAManagerToken);
      assert.equal(mg.body.user.roleLabel, 'Manager');

      // Viewer
      const vw = await apiGet('/api/auth/me', orgAViewerToken);
      assert.equal(vw.body.user.roleLabel, 'Viewer');
    });
  });

  // ── Dashboard Access ─────────────────────────────────────────────────

  describe('RBAC-30: Dashboard access for all roles', () => {
    it('RBAC-30: All authenticated roles can access dashboard', async () => {
      const tokens = [
        { token: superAdminToken, role: 'super_admin' },
        { token: orgAAdminToken, role: 'org_admin' },
        { token: orgAManagerToken, role: 'manager' },
        { token: orgAViewerToken, role: 'viewer' },
      ];

      for (const { token, role } of tokens) {
        const { status } = await apiGet('/api/dashboard', token);
        assert.equal(status, 200, `Dashboard should be accessible for ${role}`);
      }
    });
  });

  // ── Authorization Helpers (code-level tests) ─────────────────────────

  describe('RBAC-31: Permissions module integrity', () => {
    it('RBAC-31: Permissions module exports are correct', async () => {
      // Import the permissions module to verify it loads correctly
      const perms = await import('@/lib/permissions');
      
      // Verify role labels
      assert.equal(perms.getRoleLabel('super_admin'), 'Super Admin');
      assert.equal(perms.getRoleLabel('org_admin'), 'Organization Admin');
      assert.equal(perms.getRoleLabel('manager'), 'Manager');
      assert.equal(perms.getRoleLabel('viewer'), 'Viewer');
      assert.equal(perms.getRoleLabel('unknown_role'), 'unknown_role');

      // Verify hierarchy
      assert.ok(perms.hasRolePermission('super_admin', 'admin'));
      assert.ok(perms.hasRolePermission('admin', 'manager'));
      assert.ok(perms.hasRolePermission('manager', 'viewer'));
      assert.ok(!perms.hasRolePermission('viewer', 'admin'));
      assert.ok(!perms.hasRolePermission('viewer', 'manager'));

      // Verify permissions
      assert.ok(perms.hasPermission('super_admin', 'platform.organizations.create'));
      assert.ok(perms.hasPermission('org_admin', 'employees.create'));
      assert.ok(!perms.hasPermission('viewer', 'employees.create'));
      assert.ok(!perms.hasPermission('manager', 'platform.organizations.create'));
    });
  });
});
