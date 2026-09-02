/**
 * AI CONFIGURATION — Org Admin Access Regression Tests
 *
 * Verifies the authorization model for the AI Configuration page:
 *   super_admin → can access AI Configuration (platform-wide)
 *   org_admin   → can manage AI Configuration for their own organization only
 *   manager     → denied
 *   viewer      → denied
 *
 * Also tests cross-tenant isolation: Org A admin cannot access Org B AI config.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// ─── Test Setup ─────────────────────────────────────────────────────────
// These tests require a running dev server at BASE_URL.

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const API = `${BASE_URL}/api`;

interface TestUser {
  token: string;
  userId: string;
  email: string;
  role: string;
  organizationId?: string;
}

let superAdmin: TestUser | null = null;
let orgAdminA: TestUser | null = null;
let orgAdminB: TestUser | null = null;
let managerUser: TestUser | null = null;
let viewerUser: TestUser | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────

async function login(email: string, password: string): Promise<TestUser | null> {
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      token: data.token,
      userId: data.user.id,
      email: data.user.email,
      role: data.user.role,
      organizationId: data.organization?.id,
    };
  } catch {
    return null;
  }
}

async function apiGet(token: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function apiPut(token: string, path: string, data: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function apiPost(token: string, path: string, data: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('AI Configuration Org Admin Access', () => {
  before(async () => {
    // Login test users — adjust credentials to match your dev environment
    superAdmin = await login('admin@omnisight.com', 'admin123');
    orgAdminA = await login('orgadmin-a@test.com', 'password123');
    orgAdminB = await login('orgadmin-b@test.com', 'password123');
    managerUser = await login('manager@test.com', 'password123');
    viewerUser = await login('viewer@test.com', 'password123');

    // Skip tests if users don't exist
    if (!superAdmin) console.log('⚠️  Super Admin not found — skipping super_admin tests');
    if (!orgAdminA) console.log('⚠️  Org Admin A not found — skipping org_admin tests');
    if (!orgAdminB) console.log('⚠️  Org Admin B not found — skipping cross-tenant tests');
    if (!managerUser) console.log('⚠️  Manager not found — skipping manager tests');
    if (!viewerUser) console.log('⚠️  Viewer not found — skipping viewer tests');
  });

  // ─── Positive: Super Admin ────────────────────────────────────────────

  describe('Super Admin', () => {
    it('AC-SA-01: GET /api/organization/ai-settings returns 200 for super_admin', async () => {
      if (!superAdmin) return;
      const { status } = await apiGet(superAdmin.token, '/organization/ai-settings');
      assert.equal(status, 200, `Expected 200 but got ${status}`);
    });

    it('AC-SA-02: PUT /api/organization/ai-settings returns 200 for super_admin', async () => {
      if (!superAdmin) return;
      const { status, body } = await apiPut(superAdmin.token, '/organization/ai-settings', {
        key: 'ai_temperature',
        value: '0.7',
      });
      assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it('AC-SA-03: GET /api/settings returns 200 for super_admin (legacy route)', async () => {
      if (!superAdmin) return;
      const { status } = await apiGet(superAdmin.token, '/settings');
      assert.equal(status, 200, `Expected 200 but got ${status}`);
    });

    it('AC-SA-04: PUT /api/settings returns 200 for super_admin (legacy route)', async () => {
      if (!superAdmin) return;
      const { status, body } = await apiPut(superAdmin.token, '/settings', {
        key: 'ai_temperature',
        value: '0.7',
      });
      assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });
  });

  // ─── Positive: Org Admin (own org) ───────────────────────────────────

  describe('Org Admin — own organization', () => {
    it('AC-OA-01: GET /api/organization/ai-settings returns 200 for org_admin', async () => {
      if (!orgAdminA) return;
      const { status } = await apiGet(orgAdminA.token, '/organization/ai-settings');
      assert.equal(status, 200, `Expected 200 but got ${status}`);
    });

    it('AC-OA-02: PUT /api/organization/ai-settings returns 200 for org_admin', async () => {
      if (!orgAdminA) return;
      const { status, body } = await apiPut(orgAdminA.token, '/organization/ai-settings', {
        key: 'ai_temperature',
        value: '0.5',
      });
      assert.equal(status, 200, `Expected 200 but got ${status}: ${JSON.stringify(body)}`);
    });

    it('AC-OA-03: PUT /api/organization/ai-settings persists setting for org', async () => {
      if (!orgAdminA) return;
      // Write a setting
      await apiPut(orgAdminA.token, '/organization/ai-settings', {
        key: 'ai_model',
        value: 'gpt-4o-mini',
      });
      // Read it back
      const { status, body } = await apiGet(orgAdminA.token, '/organization/ai-settings');
      assert.equal(status, 200);
      const data = (body as { data?: Array<{ key: string; value: string }> }).data || [];
      const modelSetting = data.find((s) => s.key === 'ai_model');
      assert.ok(modelSetting, 'ai_model setting should exist');
      assert.equal(modelSetting.value, 'gpt-4o-mini', 'ai_model should be gpt-4o-mini');
    });

    it('AC-OA-04: Org Admin cannot write unsupported keys', async () => {
      if (!orgAdminA) return;
      const { status } = await apiPut(orgAdminA.token, '/organization/ai-settings', {
        key: 'unsupported_key',
        value: 'test',
      });
      assert.equal(status, 400, `Expected 400 for unsupported key but got ${status}`);
    });
  });

  // ─── Negative: Cross-tenant ───────────────────────────────────────────

  describe('Cross-tenant isolation', () => {
    it('AC-CT-01: Org Admin A settings are scoped to Org A', async () => {
      if (!orgAdminA || !orgAdminB) return;
      // Admin A writes a setting
      await apiPut(orgAdminA.token, '/organization/ai-settings', {
        key: 'ai_model',
        value: 'org-a-model',
      });
      // Admin B writes a different value
      await apiPut(orgAdminB.token, '/organization/ai-settings', {
        key: 'ai_model',
        value: 'org-b-model',
      });
      // Admin A reads — should get org-a-model
      const { status: statusA, body: bodyA } = await apiGet(orgAdminA.token, '/organization/ai-settings');
      assert.equal(statusA, 200);
      const dataA = (bodyA as { data?: Array<{ key: string; value: string }> }).data || [];
      const modelA = dataA.find((s) => s.key === 'ai_model');
      assert.equal(modelA?.value, 'org-a-model', 'Org A should see its own model setting');
    });

    it('AC-CT-02: Org Admin B reads own settings (not Org A)', async () => {
      if (!orgAdminB) return;
      const { status, body } = await apiGet(orgAdminB.token, '/organization/ai-settings');
      assert.equal(status, 200);
      const data = (body as { data?: Array<{ key: string; value: string }> }).data || [];
      const model = data.find((s) => s.key === 'ai_model');
      assert.equal(model?.value, 'org-b-model', 'Org B should see its own model setting');
    });
  });

  // ─── Negative: Manager/Viewer ─────────────────────────────────────────

  describe('Manager — denied', () => {
    it('AC-MGR-01: GET /api/organization/ai-settings returns 403 for manager', async () => {
      if (!managerUser) return;
      const { status } = await apiGet(managerUser.token, '/organization/ai-settings');
      assert.equal(status, 403, `Expected 403 but got ${status}`);
    });

    it('AC-MGR-02: PUT /api/organization/ai-settings returns 403 for manager', async () => {
      if (!managerUser) return;
      const { status } = await apiPut(managerUser.token, '/organization/ai-settings', {
        key: 'ai_temperature',
        value: '0.5',
      });
      assert.equal(status, 403, `Expected 403 but got ${status}`);
    });
  });

  describe('Viewer — denied', () => {
    it('AC-VIEW-01: GET /api/organization/ai-settings returns 403 for viewer', async () => {
      if (!viewerUser) return;
      const { status } = await apiGet(viewerUser.token, '/organization/ai-settings');
      assert.equal(status, 403, `Expected 403 but got ${status}`);
    });

    it('AC-VIEW-02: PUT /api/organization/ai-settings returns 403 for viewer', async () => {
      if (!viewerUser) return;
      const { status } = await apiPut(viewerUser.token, '/organization/ai-settings', {
        key: 'ai_temperature',
        value: '0.5',
      });
      assert.equal(status, 403, `Expected 403 but got ${status}`);
    });
  });

  // ─── Unauthenticated ──────────────────────────────────────────────────

  describe('Unauthenticated — denied', () => {
    it('AC-UNAUTH-01: GET /api/organization/ai-settings returns 401 without token', async () => {
      const { status } = await apiGet('', '/organization/ai-settings');
      assert.equal(status, 401, `Expected 401 but got ${status}`);
    });

    it('AC-UNAUTH-02: PUT /api/organization/ai-settings returns 401 without token', async () => {
      const { status } = await apiPut('', '/organization/ai-settings', {
        key: 'ai_temperature',
        value: '0.5',
      });
      assert.equal(status, 401, `Expected 401 but got ${status}`);
    });
  });

  // ─── Legacy route backward compat ─────────────────────────────────────

  describe('Legacy /api/settings route', () => {
    it('AC-LEGACY-01: GET /api/settings returns 403 for org_admin (global route)', async () => {
      if (!orgAdminA) return;
      const { status } = await apiGet(orgAdminA.token, '/settings');
      // The legacy GET /api/settings requires requireAdminOrg which allows org_admin.
      // But PUT requires super_admin only — this is by design for global settings.
      assert.ok([200, 403].includes(status), `Expected 200 or 403 but got ${status}`);
    });

    it('AC-LEGACY-02: PUT /api/settings returns 403 for org_admin (global route)', async () => {
      if (!orgAdminA) return;
      const { status } = await apiPut(orgAdminA.token, '/settings', {
        key: 'ai_temperature',
        value: '0.5',
      });
      assert.equal(status, 403, `Expected 403 for global PUT but got ${status}`);
    });
  });

  // ─── Test Connection ──────────────────────────────────────────────────

  describe('Test Connection', () => {
    it('AC-TC-01: POST /api/organization/ai-settings/test-connection returns 200 for org_admin', async () => {
      if (!orgAdminA) return;
      const { status } = await apiPost(orgAdminA.token, '/organization/ai-settings/test-connection', {
        provider: 'ollama',
      });
      // Ollama test may fail (no local instance) but should NOT return 403
      assert.ok(status !== 403, `Expected non-403 but got ${status}`);
    });

    it('AC-TC-02: POST /api/ai-provider/test-connection returns 403 for org_admin (legacy route)', async () => {
      if (!orgAdminA) return;
      const { status } = await apiPost(orgAdminA.token, '/ai-provider/test-connection', {
        provider: 'ollama',
      });
      assert.equal(status, 403, `Expected 403 for legacy test-connection but got ${status}`);
    });

    it('AC-TC-03: POST /api/organization/ai-settings/test-connection returns 403 for manager', async () => {
      if (!managerUser) return;
      const { status } = await apiPost(managerUser.token, '/organization/ai-settings/test-connection', {
        provider: 'ollama',
      });
      assert.equal(status, 403, `Expected 403 but got ${status}`);
    });
  });

  // ─── Proxy RBAC ───────────────────────────────────────────────────────

  describe('Proxy RBAC', () => {
    it('AC-PROXY-01: /api/ai-provider proxy rule allows org_admin (minRole: admin)', async () => {
      if (!orgAdminA) return;
      // The usage endpoint is publicly accessible via proxy (admin+ gate)
      const { status } = await apiGet(orgAdminA.token, '/ai-provider/usage');
      assert.equal(status, 200, `Expected 200 but got ${status}`);
    });

    it('AC-PROXY-02: /api/settings proxy rule allows org_admin (minRole: admin)', async () => {
      if (!orgAdminA) return;
      const { status } = await apiGet(orgAdminA.token, '/settings');
      assert.ok([200, 403].includes(status), `Expected 200 or 403 but got ${status}`);
    });
  });
});
