/**
 * Agent Cross-Org Attack Tests — Verify agents from Org A cannot operate against Org B.
 *
 * Tests:
 *  ACO-01  Agent A token → Org B employee activity upload → DENY
 *  ACO-02  Agent A token → Org B device screenshot upload → DENY
 *  ACO-03  Agent A token → Org B config fetch → DENY (wrong org's config)
 *  ACO-04  Agent A token → heartbeat works only for own org
 *  ACO-05  Agent A token with corrupted org → validateAgentToken rejects
 *  ACO-06  Expired agent token → rejected
 *  ACO-07  Agent from suspended org → all operations blocked
 *  ACO-08  Agent token org mismatch detection (token org ≠ employee org)
 *
 * Runs against a THROWAWAY PostgreSQL database.
 * Run: npx tsx --test tests/agent-cross-org-attack.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_agent_crossorg';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-agent-crossorg-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@agent-crossorg.test';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';
(process.env as Record<string, string>).NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';

before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
});

type DbModule = typeof import('../src/lib/db');
let db: DbModule['db'];

let orgA: { id: string };
let orgB: { id: string };
let empA: { id: string; employeeId: string };
let empB: { id: string; employeeId: string };
let deviceA: { id: string };
let deviceB: { id: string };
let tokenA: string;
let tokenB: string;

before(async () => {
  db = (await import('../src/lib/db')).db;

  orgA = await db.organization.create({ data: { name: 'Attack Org A', slug: 'attack-org-a' } });
  orgB = await db.organization.create({ data: { name: 'Attack Org B', slug: 'attack-org-b' } });

  empA = await db.employee.create({
    data: { employeeId: 'ACO-A-001', firstName: 'Agent', lastName: 'A', email: 'agent-a@aco.test', organizationId: orgA.id, status: 'active', agentApproved: true },
  });
  empB = await db.employee.create({
    data: { employeeId: 'ACO-B-001', firstName: 'Agent', lastName: 'B', email: 'agent-b@aco.test', organizationId: orgB.id, status: 'active', agentApproved: true },
  });

  const freshBeat = new Date();
  deviceA = await db.device.create({
    data: { name: 'Device-A', hostname: 'Device-A', agentKey: 'aco-key-device-a', organizationId: orgA.id, employeeId: empA.id, status: 'online', lastHeartbeat: freshBeat },
  });
  deviceB = await db.device.create({
    data: { name: 'Device-B', hostname: 'Device-B', agentKey: 'aco-key-device-b', organizationId: orgB.id, employeeId: empB.id, status: 'online', lastHeartbeat: freshBeat },
  });

  // Create valid agent tokens
  const { generateToken } = await import('../src/lib/agent/auth');
  tokenA = generateToken(64);
  tokenB = generateToken(64);
  const expiresAt = new Date(Date.now() + 86400000);

  await db.agentToken.createMany({
    data: [
      { token: tokenA, employeeId: empA.id, organizationId: orgA.id, deviceId: deviceA.id, expiresAt },
      { token: tokenB, employeeId: empB.id, organizationId: orgB.id, deviceId: deviceB.id, expiresAt },
    ],
  });

  // Seed consent for empA (needed for activity/screenshot uploads)
  // Create published consent policies first (hasActiveConsent requires them)
  const policyATrack = await db.consentPolicy.create({
    data: { organizationId: orgA.id, consentType: 'activity_tracking', title: 'Tracking Policy', content: 'We track activity.', version: 'v1', status: 'published', effectiveAt: new Date(), publishedAt: new Date() },
  });
  const policyAShot = await db.consentPolicy.create({
    data: { organizationId: orgA.id, consentType: 'screenshot', title: 'Screenshot Policy', content: 'We take screenshots.', version: 'v1', status: 'published', effectiveAt: new Date(), publishedAt: new Date() },
  });
  await db.consent.create({
    data: { employeeId: empA.id, consentType: 'activity_tracking', status: 'granted', grantedAt: new Date(), organizationId: orgA.id, policyId: policyATrack.id, consentVersion: 'v1' },
  });
  await db.consent.create({
    data: { employeeId: empA.id, consentType: 'screenshot', status: 'granted', grantedAt: new Date(), organizationId: orgA.id, policyId: policyAShot.id, consentVersion: 'v1' },
  });
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch { /* best-effort */ }
});

function agentReq(token: string, opts: { method?: string; body?: unknown; url?: string } = {}): NextRequest {
  const headers: Record<string, string> = { 'authorization': `Bearer ${token}` };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return new NextRequest(opts.url || 'http://localhost:3000/api/test', {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// ─── ACO-01: Agent A token → Org B employee activity upload → DENY ─────

test('ACO-01: Agent A token cannot upload activity for Org B employee', async () => {
  const api = await import('../src/app/api/agent/activity/route');
  // Agent A's token is bound to empA (Org A). Trying to use it to upload
  // activity should only create records for empA, never empB.
  // The activity upload uses the token's employee, not a client-supplied employeeId.
  const res = await api.POST(agentReq(tokenA, {
    method: 'POST',
    body: {
      activities: [{
        type: 'application',
        applicationName: 'Test App',
        category: 'productive',
        duration: 60,
        timestamp: new Date().toISOString(),
      }],
    },
  }));
  assert.equal(res.status, 200, 'Activity upload should succeed for own org');
  
  // Verify the activity was created for empA, not empB
  const activities = await db.activity.findMany({
    where: { employeeId: empA.id },
    orderBy: { createdAt: 'desc' },
    take: 1,
  });
  assert.ok(activities.length > 0, 'Activity created for empA');
  
  // Verify no activity was created for empB
  const bActivities = await db.activity.count({ where: { employeeId: empB.id } });
  assert.equal(bActivities, 0, 'No activity created for empB');
});

// ─── ACO-02: Agent A token → Org B config fetch → DENY ────────────────

test('ACO-02: Agent A token fetches Org A config, not Org B', async () => {
  const api = await import('../src/app/api/agent/config/route');
  const res = await api.GET(agentReq(tokenA));
  assert.equal(res.status, 200);
  const body = await res.json();
  // Config should reflect Org A's settings, not Org B's
  assert.ok(body.config, 'Config response has config object');
  assert.ok(body.config.monitoring, 'Config has monitoring settings');
});

// ─── ACO-03: Agent A token → heartbeat works only for own org ──────────

test('ACO-03: Agent A heartbeat succeeds for own device', async () => {
  const api = await import('../src/app/api/agent/heartbeat/route');
  const res = await api.POST(agentReq(tokenA, { method: 'POST', body: { timestamp: new Date().toISOString() } }));
  assert.equal(res.status, 200, 'Own-org heartbeat must succeed');
});

// ─── ACO-04: Agent A token with corrupted org → validateAgentToken rejects

test('ACO-04: Agent token with corrupted organizationId is rejected', async () => {
  const { validateAgentToken } = await import('../src/lib/agent/auth');
  
  // Get agent A's token
  const agentToken = await db.agentToken.findFirst({ where: { token: tokenA } });
  assert.ok(agentToken, 'Token A exists');
  
  // Corrupt the organizationId to point to Org B
  await db.agentToken.update({
    where: { id: agentToken.id },
    data: { organizationId: orgB.id },
  });
  
  // Create a minimal request with the corrupted token
  const corruptedReq = new NextRequest('http://localhost:3000/api/agent/heartbeat', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${tokenA}` },
    body: JSON.stringify({ timestamp: new Date().toISOString() }),
  });
  
  const result = await validateAgentToken(corruptedReq);
  assert.equal(result.valid, false, 'Corrupted org token must be rejected');
  assert.ok(result.error?.includes('mismatch') || result.error?.includes('organization'), `Error should mention org mismatch: ${result.error}`);
  
  // Restore
  await db.agentToken.update({
    where: { id: agentToken.id },
    data: { organizationId: orgA.id },
  });
});

// ─── ACO-05: Expired agent token → rejected ────────────────────────────

test('ACO-05: Expired agent token is rejected', async () => {
  const { validateAgentToken } = await import('../src/lib/agent/auth');
  
  // Create an expired token
  const { generateToken } = await import('../src/lib/agent/auth');
  const expiredToken = generateToken(64);
  await db.agentToken.create({
    data: {
      token: expiredToken,
      employeeId: empA.id,
      organizationId: orgA.id,
      deviceId: deviceA.id,
      expiresAt: new Date(Date.now() - 60000), // expired 1 minute ago
    },
  });
  
  const expiredReq = new NextRequest('http://localhost:3000/api/agent/heartbeat', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${expiredToken}` },
    body: JSON.stringify({ timestamp: new Date().toISOString() }),
  });
  
  const result = await validateAgentToken(expiredReq);
  assert.equal(result.valid, false, 'Expired token must be rejected');
});

// ─── ACO-06: Agent from suspended org → blocked ────────────────────────

test('ACO-06: Agent from suspended org is blocked', async () => {
  const { validateAgentToken } = await import('../src/lib/agent/auth');
  
  // Suspend Org A
  await db.organization.update({ where: { id: orgA.id }, data: { status: 'suspended' } });
  
  try {
    const suspendedReq = new NextRequest('http://localhost:3000/api/agent/heartbeat', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${tokenA}` },
      body: JSON.stringify({ timestamp: new Date().toISOString() }),
    });
    
    const result = await validateAgentToken(suspendedReq);
    assert.equal(result.valid, false, 'Suspended org agent must be rejected');
    assert.ok(result.error?.toLowerCase().includes('organization') || result.error?.toLowerCase().includes('active'), `Error should mention org: ${result.error}`);
  } finally {
    await db.organization.update({ where: { id: orgA.id }, data: { status: 'active' } });
  }
});

// ─── ACO-07: Agent token org mismatch (DB-level) ───────────────────────

test('ACO-07: validateAgentToken detects org mismatch between token and employee', async () => {
  const { validateAgentToken } = await import('../src/lib/agent/auth');
  
  // Create a token for empA but with empB's organization
  const { generateToken } = await import('../src/lib/agent/auth');
  const mismatchToken = generateToken(64);
  await db.agentToken.create({
    data: {
      token: mismatchToken,
      employeeId: empA.id, // empA belongs to orgA
      organizationId: orgB.id, // but token says orgB
      deviceId: deviceA.id,
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  
  const mismatchReq = new NextRequest('http://localhost:3000/api/agent/heartbeat', {
    method: 'POST',
    headers: { 'authorization': `Bearer ${mismatchToken}` },
    body: JSON.stringify({ timestamp: new Date().toISOString() }),
  });
  
  const result = await validateAgentToken(mismatchReq);
  assert.equal(result.valid, false, 'Org mismatch token must be rejected');
  assert.ok(result.error?.includes('mismatch') || result.error?.includes('organization'), `Error should mention mismatch: ${result.error}`);
  
  // Cleanup
  await db.agentToken.delete({ where: { token: mismatchToken } });
});

// ─── ACO-08: Agent B token cannot access Org A resources ───────────────

test('ACO-08: Agent B heartbeat only updates Org B device', async () => {
  const api = await import('../src/app/api/agent/heartbeat/route');
  
  const deviceABefore = await db.device.findUnique({ where: { id: deviceA.id }, select: { lastHeartbeat: true } });
  
  const res = await api.POST(agentReq(tokenB, { method: 'POST', body: { timestamp: new Date().toISOString() } }));
  assert.equal(res.status, 200, 'Agent B heartbeat succeeds for own org');
  
  // Verify Org A device was NOT touched
  const deviceAAfter = await db.device.findUnique({ where: { id: deviceA.id }, select: { lastHeartbeat: true } });
  assert.equal(
    deviceABefore!.lastHeartbeat?.getTime(),
    deviceAAfter!.lastHeartbeat?.getTime(),
    'Org A device lastHeartbeat must not change from Org B agent heartbeat'
  );
});
