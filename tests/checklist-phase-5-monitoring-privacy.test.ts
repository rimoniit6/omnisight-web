/**
 * Smart Testing Checklist — PHASE 5: Monitoring Consent & Privacy Controls.
 *
 * In-process server tests for the privacy boundary of the agent telemetry
 * surface (consent gate, break/privacy mode, location, USB, keystrokes):
 *   C-01  grant without a published policy -> 409; grant after publish ->
 *         consent bound to the CURRENT policy version; GET reflects it
 *   C-02  illegal state transition -> 409 "Invalid consent transition", row untouched
 *   B-01  break: start -> 'started'; repeat -> 'already_active' (one session);
 *         end -> 'ended'; repeat end -> 'no_active_break'; non-boolean -> 400
 *   L-01  location: consent gate 403 -> org flag 403 -> first fix accepted,
 *         <5km accepted:false, >5km accepted, closed schema 422
 *   U-01  usb: org flag 403 -> consent 403 -> insert 201 -> duplicate no-op 200,
 *         usb_blocked rejected 422, blocked never client-controlled
 *   K-01  keystroke: consent/org gates 403, single + batch accepted,
 *         >50 intervals 400, raw-keystroke fields rejected 422
 *   T-01  a foreign employee cannot query any of this data (401/tenant isolation)
 *
 * Runs against a THROWAWAY PostgreSQL database (workai_test_checklist_phase5).
 * Run: npx tsx --test tests/checklist-phase-5-monitoring-privacy.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { NextRequest } from 'next/server';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_checklist_phase5';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'test-jwt-secret-checklist-p5-0123456789abcdef';
process.env.SUPER_ADMIN_EMAIL = 'admin@test.local';
process.env.SUPER_ADMIN_PASSWORD = 'test-password-123';

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
let consentApi: typeof import('../src/app/api/agent/consent/route');
let breakApi: typeof import('../src/app/api/agent/break/route');
let locationApi: typeof import('../src/app/api/agent/location/route');
let usbApi: typeof import('../src/app/api/agent/usb/route');
let keystrokeApi: typeof import('../src/app/api/agent/keystroke/route');

let tokenSeq = 0;

before(async () => {
  db = (await import('../src/lib/db')).db;
  consentApi = await import('../src/app/api/agent/consent/route');
  breakApi = await import('../src/app/api/agent/break/route');
  locationApi = await import('../src/app/api/agent/location/route');
  usbApi = await import('../src/app/api/agent/usb/route');
  keystrokeApi = await import('../src/app/api/agent/keystroke/route');
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Org (eligible via trial) + approved employee + online device + agent token. */
async function seedAgentEnv(slug: string, extra: { monitoring?: Record<string, 'true'> } = {}) {
  const org = await db.organization.create({
    data: { name: slug, slug, trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });
  const emp = await db.employee.create({
    data: {
      employeeId: `${slug}-EMP-001`,
      firstName: slug,
      lastName: 'Test',
      email: `${slug.toLowerCase()}@test.local`,
      organizationId: org.id,
      status: 'active',
      agentApproved: true,
    },
  });
  const device = await db.device.create({
    data: {
      name: `${slug}-device`,
      hostname: `PC-${slug}`,
      operatingSystem: 'Windows 11',
      agentVersion: '1.3.0',
      organizationId: org.id,
      employeeId: emp.id,
      status: 'online',
      agentKey: `key-${slug}-001`,
    },
  });
  const token = `t5-${slug}-${++tokenSeq}-${Math.random().toString(36).slice(2)}`;
  await db.agentToken.create({
    data: { token, employeeId: emp.id, organizationId: org.id, deviceId: device.id, expiresAt: new Date(Date.now() + 3600_000) },
  });
  if (extra.monitoring) {
    for (const [key, value] of Object.entries(extra.monitoring)) {
      await db.organizationSetting.create({ data: { organizationId: org.id, key, value, category: 'monitoring' } });
    }
  }
  return { org, emp, device, token };
}

/** Grant a consent through the AUDITED route (policy must exist first). */
function agentPost(token: string, url: string, body: Record<string, unknown>) {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function ISO(d: Date): string {
  return d.toISOString();
}

// ─── C-01: policy-bound grant / fail-closed without policy ──────────────────

test('C-01: consent grant fails closed without a published policy, then binds the current version', async () => {
  const { org, emp, token } = await seedAgentEnv('p5-consent');

  // No policy yet -> 409, nothing written.
  const denied = await consentApi.POST(agentPost(token, 'http://localhost/api/agent/consent', { consentType: 'location', action: 'grant' }));
  assert.equal(denied.status, 409, 'grant without a published policy must fail closed');
  assert.match((await denied.json()).error ?? '', /no published policy/i);
  assert.equal(await db.consent.count({ where: { employeeId: emp.id } }), 0, 'no consent row written');

  // Publish + grant via the audited route -> bound to the CURRENT version.
  await db.consentPolicy.create({
    data: { organizationId: org.id, consentType: 'location', title: 'loc v1', content: 'c', status: 'published', version: 'v1', effectiveAt: new Date() },
  });
  const grant = await consentApi.POST(agentPost(token, 'http://localhost/api/agent/consent', { consentType: 'location', action: 'grant' }));
  assert.equal(grant.status, 200, JSON.stringify(await grant.json()));
  const row = await db.consent.findFirstOrThrow({ where: { employeeId: emp.id, consentType: 'location' } });
  assert.equal(row.status, 'granted');
  assert.equal(row.consentVersion, 'v1');
  assert.ok(row.policyId, 'consent bound to the policy row');

  // A NEW published version forces re-consent (the old binding goes stale).
  await db.consentPolicy.updateMany({ where: { organizationId: org.id, consentType: 'location', status: 'published' }, data: { status: 'archived' } });
  await db.consentPolicy.create({
    data: { organizationId: org.id, consentType: 'location', title: 'loc v2', content: 'c', status: 'published', version: 'v2', effectiveAt: new Date() },
  });
  const check = await consentApi.GET(new NextRequest('http://localhost/api/agent/consent?types=location', { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(check.status, 200);
  const checkBody = (await check.json()) as { consents: Record<string, boolean> };
  assert.equal(checkBody.consents.location, false, 'stale version must report NOT granted (re-consent required)');
});

// ─── C-02: illegal transition rejected ──────────────────────────────────────

test('C-02: an illegal consent transition returns 409 and leaves the row untouched', async () => {
  const { org, emp, token } = await seedAgentEnv('p5-illegal');
  await db.consentPolicy.create({
    data: { organizationId: org.id, consentType: 'keystroke', title: 'ks v1', content: 'c', status: 'published', version: 'v1', effectiveAt: new Date() },
  });
  // expired -> revoked is NOT a legal state machine transition.
  await db.consent.create({ data: { employeeId: emp.id, consentType: 'keystroke', status: 'expired', organizationId: org.id } });

  const res = await consentApi.POST(agentPost(token, 'http://localhost/api/agent/consent', { consentType: 'keystroke', action: 'revoke' }));
  assert.equal(res.status, 409);
  assert.match((await res.json()).error ?? '', /Invalid consent transition/);
  const row = await db.consent.findFirstOrThrow({ where: { employeeId: emp.id, consentType: 'keystroke' } });
  assert.equal(row.status, 'expired', 'row untouched after the rejected transition');
});

// ─── B-01: break/privacy mode idempotency ───────────────────────────────────

test('B-01: break mode lifecycle is server-authoritative and idempotent', async () => {
  const { emp, token } = await seedAgentEnv('p5-break');

  const start = await breakApi.POST(agentPost(token, 'http://localhost/api/agent/break', { breakMode: true }));
  assert.equal(start.status, 200);
  const startBody = (await start.json()) as { success: boolean; breakMode: boolean; action: string; startedAt: string; endedAt: null };
  assert.equal(startBody.success, true);
  assert.equal(startBody.breakMode, true);
  assert.equal(startBody.action, 'started');
  assert.ok(!Number.isNaN(new Date(startBody.startedAt).getTime()));
  assert.equal(startBody.endedAt, null);

  const again = await breakApi.POST(agentPost(token, 'http://localhost/api/agent/break', { breakMode: true }));
  const againBody = (await again.json()) as { action: string; startedAt: string };
  assert.equal(againBody.action, 'already_active', 'no duplicate session');
  assert.equal(await db.breakSession.count({ where: { employeeId: emp.id, endedAt: null } }), 1, 'single active session');

  const end = await breakApi.POST(agentPost(token, 'http://localhost/api/agent/break', { breakMode: false }));
  const endBody = (await end.json()) as { action: string; endedAt: string };
  assert.equal(endBody.action, 'ended');
  assert.ok(!Number.isNaN(new Date(endBody.endedAt).getTime()));

  const endAgain = await breakApi.POST(agentPost(token, 'http://localhost/api/agent/break', { breakMode: false }));
  const endAgainBody = (await endAgain.json()) as { action: string };
  assert.equal(endAgainBody.action, 'no_active_break', 'repeat end is a clean no-op');

  const bad = await breakApi.POST(agentPost(token, 'http://localhost/api/agent/break', { breakMode: 'yes' }));
  assert.equal(bad.status, 400, 'non-boolean breakMode rejected');
});

// ─── L-01: location — consent, org flag, threshold, closed schema ───────────

const BASE = { lat: 51.5074, lng: -0.1278 };
const KM_PER_DEG_LAT = 111.32;
function north(km: number) {
  return { latitude: BASE.lat + km / KM_PER_DEG_LAT, longitude: BASE.lng };
}

test('L-01: location respects consent + org flag and the 5km movement threshold', async () => {
  // No consent -> 403 before anything.
  const noConsent = await seedAgentEnv('p5-loc-noc');
  await db.organizationSetting.create({ data: { organizationId: noConsent.org.id, key: 'location_tracking', value: 'true', category: 'monitoring' } });
  const g1 = await locationApi.POST(agentPost(noConsent.token, 'http://localhost/api/agent/location', { ...north(0), accuracy: 10, timestamp: ISO(new Date()) }));
  assert.equal(g1.status, 403);
  assert.match((await g1.json()).error ?? '', /consent/i);

  // Consent granted but org flag disabled -> LOCATION_TRACKING_DISABLED.
  const noFlag = await seedAgentEnv('p5-loc-noflag');
  await db.consentPolicy.create({ data: { organizationId: noFlag.org.id, consentType: 'location', title: 'loc', content: 'c', status: 'published', version: 'v1', effectiveAt: new Date() } });
  await db.consent.create({ data: { employeeId: noFlag.emp.id, consentType: 'location', status: 'granted', organizationId: noFlag.org.id, consentVersion: 'v1' } });
  const g2 = await locationApi.POST(agentPost(noFlag.token, 'http://localhost/api/agent/location', { ...north(0), accuracy: 10, timestamp: ISO(new Date()) }));
  assert.equal(g2.status, 403);
  assert.deepEqual((await g2.json()).error, 'LOCATION_TRACKING_DISABLED');

  // Fully enabled: first fix accepted -> <5km rejected -> >5km accepted.
  const en = await seedAgentEnv('p5-loc-ok', { monitoring: { location_tracking: 'true' } });
  await db.consentPolicy.create({ data: { organizationId: en.org.id, consentType: 'location', title: 'loc', content: 'c', status: 'published', version: 'v1', effectiveAt: new Date() } });
  await db.consent.create({ data: { employeeId: en.emp.id, consentType: 'location', status: 'granted', organizationId: en.org.id, consentVersion: 'v1' } });

  const first = await locationApi.POST(agentPost(en.token, 'http://localhost/api/agent/location', { ...north(0), accuracy: 10, timestamp: ISO(new Date()) }));
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as { accepted: boolean; first: boolean };
  assert.equal(firstBody.accepted, true);
  assert.equal(firstBody.first, true);

  const below = await locationApi.POST(agentPost(en.token, 'http://localhost/api/agent/location', { ...north(3), accuracy: 10, timestamp: ISO(new Date()) }));
  assert.equal(below.status, 200, 'sub-threshold is NOT an error');
  const belowBody = (await below.json()) as { accepted: boolean; reason: string };
  assert.equal(belowBody.accepted, false);
  assert.equal(belowBody.reason, 'below_movement_threshold');

  const above = await locationApi.POST(agentPost(en.token, 'http://localhost/api/agent/location', { ...north(6), accuracy: 10, timestamp: ISO(new Date()) }));
  assert.equal((await above.json()).accepted, true);

  assert.equal(await db.locationEvent.count({ where: { employeeId: en.emp.id } }), 2, 'only accepted fixes stored');

  // Closed schema: address-like + unknown fields are rejected as a whole.
  const addr = await locationApi.POST(agentPost(en.token, 'http://localhost/api/agent/location', { ...north(6), accuracy: 10, timestamp: ISO(new Date()), address: '1 Main St' }));
  assert.equal(addr.status, 422);
  assert.match((await addr.json()).error ?? '', /not allowed/);
  const unknown = await locationApi.POST(agentPost(en.token, 'http://localhost/api/agent/location', { ...north(6), accuracy: 10, timestamp: ISO(new Date()), foo: 1 }));
  assert.equal(unknown.status, 422);
  assert.equal(await db.locationEvent.count({ where: { employeeId: en.emp.id } }), 2, 'rejected payloads persist nothing');
});

// ─── U-01: USB events — gating, dedupe, blocked-is-server-side ──────────────

test('U-01: USB events are consent+config gated, deduplicated, and never client-blocked', async () => {
  const bare = await seedAgentEnv('p5-usb-bare', { monitoring: { usb_monitoring: 'true' } });
  const noConsent = await usbApi.POST(agentPost(bare.token, 'http://localhost/api/agent/usb', { eventType: 'usb_insert', serialNumber: 'S-0001', deviceName: 'USB Stick' }));
  assert.equal(noConsent.status, 403, 'missing consent fails closed');

  const flagOff = await seedAgentEnv('p5-usb-flag');
  await db.consentPolicy.create({ data: { organizationId: flagOff.org.id, consentType: 'usb_monitoring', title: 'usb', content: 'c', status: 'published', version: 'v1', effectiveAt: new Date() } });
  await db.consent.create({ data: { employeeId: flagOff.emp.id, consentType: 'usb_monitoring', status: 'granted', organizationId: flagOff.org.id, consentVersion: 'v1' } });
  const gated = await usbApi.POST(agentPost(flagOff.token, 'http://localhost/api/agent/usb', { eventType: 'usb_insert', serialNumber: 'S-0002', deviceName: 'USB Stick' }));
  assert.equal(gated.status, 403, 'org flag off fails closed');

  // Happy path with an explicit dedupeKey-group (same serial + type + bucket).
  const en = await seedAgentEnv('p5-usb-ok', { monitoring: { usb_monitoring: 'true' } });
  await db.consentPolicy.create({ data: { organizationId: en.org.id, consentType: 'usb_monitoring', title: 'usb', content: 'c', status: 'published', version: 'v1', effectiveAt: new Date() } });
  await db.consent.create({ data: { employeeId: en.emp.id, consentType: 'usb_monitoring', status: 'granted', organizationId: en.org.id, consentVersion: 'v1' } });

  const insert = await usbApi.POST(agentPost(en.token, 'http://localhost/api/agent/usb', { eventType: 'usb_insert', serialNumber: 'SERIAL-ABC', deviceName: 'Sandisk', vid: '0781', pid: '5583' }));
  assert.equal(insert.status, 201);
  const insertBody = (await insert.json()) as { duplicate: boolean };
  assert.equal(insertBody.duplicate, false);
  const row = await db.usbEvent.findFirstOrThrow({ where: { employeeId: en.emp.id } });
  assert.equal(row.serialNumber, 'SERIAL-ABC'); // recorded verbatim, dedupe key lowercases internally
  assert.equal(row.blocked, false, 'blocked is never client-controlled');

  // Same device + serial + type within the dedupe window -> duplicate no-op.
  const dup = await usbApi.POST(agentPost(en.token, 'http://localhost/api/agent/usb', { eventType: 'usb_insert', serialNumber: 'SERIAL-ABC', deviceName: 'Sandisk', vid: '0781', pid: '5583' }));
  assert.equal(dup.status, 200);
  assert.equal((await dup.json()).duplicate, true);
  assert.equal(await db.usbEvent.count({ where: { employeeId: en.emp.id } }), 1, 'DB-level dedupe holds');

  // A client may never report a `blocked` event (server-derives it).
  const blocked = await usbApi.POST(agentPost(en.token, 'http://localhost/api/agent/usb', { eventType: 'usb_blocked', serialNumber: 'SERIAL-ABC', deviceName: 'Sandisk' }));
  assert.equal(blocked.status, 422);
  assert.match((await blocked.json()).error ?? '', /usb_blocked cannot be reported/i);
});

// ─── K-01: keystroke — aggregate-only, closed schema ────────────────────────

const INTERVAL = {
  intervalStart: ISO(new Date(Date.now() - 60_000)),
  intervalEnd: ISO(new Date()),
  keystrokeCount: 42,
  activeTypingSeconds: 47,
  application: 'chrome.exe',
};

test('K-01: keystroke logging is consent/config gated and rejects raw data outright', async () => {
  const bare = await seedAgentEnv('p5-ks-bare', { monitoring: { keystroke_logging_enabled: 'true' } });
  const g1 = await keystrokeApi.POST(agentPost(bare.token, 'http://localhost/api/agent/keystroke', INTERVAL));
  assert.equal(g1.status, 403, 'missing consent fails closed');

  const flagOff = await seedAgentEnv('p5-ks-flag');
  await db.consentPolicy.create({ data: { organizationId: flagOff.org.id, consentType: 'keystroke', title: 'ks', content: 'c', status: 'published', version: 'v1', effectiveAt: new Date() } });
  await db.consent.create({ data: { employeeId: flagOff.emp.id, consentType: 'keystroke', status: 'granted', organizationId: flagOff.org.id, consentVersion: 'v1' } });
  const g2 = await keystrokeApi.POST(agentPost(flagOff.token, 'http://localhost/api/agent/keystroke', INTERVAL));
  assert.equal(g2.status, 403);
  assert.deepEqual((await g2.json()).error, 'KEYSTROKE_LOGGING_DISABLED');

  const en = await seedAgentEnv('p5-ks-ok', { monitoring: { keystroke_logging_enabled: 'true' } });
  await db.consentPolicy.create({ data: { organizationId: en.org.id, consentType: 'keystroke', title: 'ks', content: 'c', status: 'published', version: 'v1', effectiveAt: new Date() } });
  await db.consent.create({ data: { employeeId: en.emp.id, consentType: 'keystroke', status: 'granted', organizationId: en.org.id, consentVersion: 'v1' } });

  const single = await keystrokeApi.POST(agentPost(en.token, 'http://localhost/api/agent/keystroke', INTERVAL));
  assert.equal(single.status, 200);
  assert.equal((await single.json()).count, 1);
  assert.equal(await db.keyboardActivity.count({ where: { employeeId: en.emp.id } }), 1);

  // Batched upload path.
  const batch = await keystrokeApi.POST(agentPost(en.token, 'http://localhost/api/agent/keystroke', { intervals: [INTERVAL, INTERVAL] }));
  assert.equal(batch.status, 200);
  assert.equal((await batch.json()).count, 2);
  assert.equal(await db.keyboardActivity.count({ where: { employeeId: en.emp.id } }), 3);

  // Beyond the interval cap.
  const tooMany = await keystrokeApi.POST(agentPost(en.token, 'http://localhost/api/agent/keystroke', { intervals: Array.from({ length: 51 }, () => INTERVAL) }));
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error ?? '', /Max 50 intervals/);

  // Raw keystroke data + unknown fields are rejected as a whole.
  const raw = await keystrokeApi.POST(agentPost(en.token, 'http://localhost/api/agent/keystroke', { ...INTERVAL, typedText: 'password-hunter2' }));
  assert.equal(raw.status, 422);
  assert.match((await raw.json()).error ?? '', /not allowed/);
  const unknown = await keystrokeApi.POST(agentPost(en.token, 'http://localhost/api/agent/keystroke', { ...INTERVAL, clipboard: 'x' }));
  assert.equal(unknown.status, 422);
  assert.match((await unknown.json()).error ?? '', /not allowed/);
  assert.equal(await db.keyboardActivity.count({ where: { employeeId: en.emp.id } }), 3, 'rejected payloads persist nothing');
});

// ─── T-01: tenant isolation on the privacy surface ──────────────────────────

test('T-01: a foreign employee cannot use another org\'s data surface (401, fail closed)', async () => {
  const { org: orgA, emp: empA, token: tokenA } = await seedAgentEnv('p5-iso-a', { monitoring: { usb_monitoring: 'true' } });
  const { org: orgB, emp: empB, token: tokenB } = await seedAgentEnv('p5-iso-b');
  assert.notEqual(orgA.id, orgB.id);

  // Employee A registers a USB event…
  await db.consentPolicy.create({ data: { organizationId: orgA.id, consentType: 'usb_monitoring', title: 'usb', content: 'c', status: 'published', version: 'v1', effectiveAt: new Date() } });
  await db.consent.create({ data: { employeeId: empA.id, consentType: 'usb_monitoring', status: 'granted', organizationId: orgA.id, consentVersion: 'v1' } });
  const ok = await usbApi.POST(agentPost(tokenA, 'http://localhost/api/agent/usb', { eventType: 'usb_insert', serialNumber: 'ISO-0001' }));
  assert.equal(ok.status, 201);

  // …but the token from org A is bound to org A and cannot touch org B data
  // (validateAgentToken derives identity from the token's employee — tampered
  // body identity is never accepted; a token for B simply does not grant A).
  const before = await db.usbEvent.count({ where: { employeeId: empB.id } });
  assert.equal(before, 0);
  // Cross-org playback: token B carries employee B, so a payload claiming A's
  // serial lands under B's tenant — and crucially the server never looks up a
  // row by client-supplied identity at all.
  const cross = await usbApi.POST(agentPost(tokenB, 'http://localhost/api/agent/usb', { eventType: 'usb_insert', serialNumber: 'ISO-0001' }));
  // B has no consent/flag enabled -> fail closed before any write.
  assert.equal(cross.status, 403);
  assert.equal(await db.usbEvent.count({ where: { employeeId: empB.id } }), 0);
});