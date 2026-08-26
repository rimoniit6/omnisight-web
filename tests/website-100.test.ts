// WEBSITE-100 — Website / Domain Tracking final-certification regression suite.
//
// Scope note: this file covers the NEW activity-ping payload contract (pure
// module) plus cheap source-invariant guards for the privacy/security
// invariants that are not DB-testable. Server-side policy cases (tracking
// toggle, consent, forged ids, atomic batches, tenant isolation) are covered
// by tests/website-tracking.test.ts (WT-P2-1-01…10); agent-side collection by
// the desktop-agent website-collector / native-messaging-host / activity-queue
// / at-rest-encryption suites; extension normalization by
// browser-extension/tests/domain.test.mjs.

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

type ActivityRowLike = import('../mini-services/live-updates/activity-events').ActivityRowLike;
type ActivityEmployeeLike = import('../mini-services/live-updates/activity-events').ActivityEmployeeLike;
let buildActivityPing: typeof import('../mini-services/live-updates/activity-events').buildActivityPing;
let isBareDomain: typeof import('../mini-services/live-updates/activity-events').isBareDomain;

const root = path.join(__dirname, '..');

// The `omnisight-agent` component lives in a separate repository. The test that
// derives the extension id from its install script must skip when the agent is
// not checked out, so the suite stays portable. (Item 14)
const AGENT_PRESENT = existsSync(path.join(root, 'omnisight-agent'));
const agentTest = AGENT_PRESENT ? test : test.skip;

test('load pure activity-events module', async () => {
  const mod = await import('../mini-services/live-updates/activity-events');
  buildActivityPing = mod.buildActivityPing;
  isBareDomain = mod.isBareDomain;
});

function row(overrides: Partial<ActivityRowLike> = {}): ActivityRowLike {
  return {
    id: 'act-1',
    type: 'website',
    title: 'Example — Home',
    applicationName: null,
    url: 'example.com',
    category: 'neutral',
    duration: 42,
    createdAt: new Date('2026-08-13T12:00:00Z'),
    ...overrides,
  };
}

const emp: ActivityEmployeeLike = { id: 'e-1', firstName: 'Rimon', lastName: 'Rana', departmentId: 'd-1' };

// ─── WEBSITE-100-01…04 / 10 — domain-only payload contract ──────────────────

test('WEBSITE-100-01: full URL with query secret → only the normalized domain reaches Live Monitor', () => {
  // A legacy/rogue row whose stored url is a full URL is dropped entirely —
  // the raw URL can never reach the WebSocket layer.
  const p = buildActivityPing(row({ url: 'https://example.com/page?token=SUPER_SECRET_123' }), emp, 'Eng');
  assert.equal(p.activityUrl, null, 'full URL must be dropped, never emitted');
  assert.ok(!JSON.stringify(p).includes('SUPER_SECRET_123'), 'secret must not survive anywhere in the payload');
  assert.ok(!JSON.stringify(p).includes('https://'), 'no scheme may appear in the payload');
  // The persisted value the server stores is already domain-only — that path:
  const clean = buildActivityPing(row({ url: 'example.com' }), emp, 'Eng');
  assert.equal(clean.activityUrl, 'example.com');
});

test('WEBSITE-100-02: fragment URLs never reach the payload', () => {
  const p = buildActivityPing(row({ url: 'https://example.com/page#frag' }), emp, 'Eng');
  assert.ok(!p.activityUrl || !p.activityUrl.includes('#'), 'fragment must not be exposed');
});

test('WEBSITE-100-03: basic-auth credentials never reach the payload', () => {
  const p = buildActivityPing(row({ url: 'https://user:pass@mail.google.com/inbox' }), emp, 'Eng');
  assert.ok(!p.activityUrl || !p.activityUrl.includes('user') || !p.activityUrl.includes('@'), 'credentials must not be exposed');
  assert.ok(!p.activityUrl || !p.activityUrl.includes('@'), 'userinfo must never appear');
});

test('WEBSITE-100-04: www/uppercase persisted domains are lowered to bare domains', () => {
  assert.equal(isBareDomain('www.example.com'), true);
  assert.equal(isBareDomain('example.com'), true);
  assert.equal(isBareDomain('Example.COM'), false, 'uppercase must be handled by lowering before the check');
  const p = buildActivityPing(row({ url: 'Example.COM' }), emp, 'Eng');
  assert.equal(p.activityUrl, 'example.com', 'lowercased bare domain is emitted');
});

test('WEBSITE-100-10: website activity-ping contains the normalized domain only', () => {
  const p = buildActivityPing(row({ url: 'github.com', title: 'GitHub' }), emp, 'Eng');
  assert.equal(p.activityUrl, 'github.com');
  assert.equal(p.activityTitle, 'GitHub', 'sanitized title stays available');
  assert.equal(p.activityType, 'website');
  assert.ok(!/\?|#|@|:\/\//.test(JSON.stringify(p)), 'no URL syntax may appear anywhere in the payload');
  // Non-website rows carry NO domain.
  const app = buildActivityPing(
    row({ type: 'application', url: 'whatever-not-a-domain', applicationName: 'Visual Studio Code' }),
    emp,
    'Eng'
  );
  assert.equal(app.activityUrl, null, 'application rows never expose activityUrl');
  // Malformed/unusable stored values are dropped (fail closed), never guessed.
  const bad = buildActivityPing(row({ url: 'not a hostname' }), emp, 'Eng');
  assert.equal(bad.activityUrl, null);
});

// ─── WEBSITE-100-05/06 — server-side website_tracking enforcement ──────────
// Functional cases live in website-tracking.test.ts (WT-P2-1-01…10). This is a
// source-invariant guard so a future refactor cannot silently drop the gate.

test('WEBSITE-100-05/06: server ingestion source still enforces website_tracking (source invariant)', () => {
  const src = readFileSync(path.join(root, 'src/app/api/agent/activity/route.ts'), 'utf8');
  assert.match(src, /WEBSITE_TRACKING_DISABLED/, 'stable machine-readable error code must exist');
  assert.match(src, /resolveOrgMonitoring/, 'org setting must come from the shared resolver');
  assert.match(src, /website_tracking/, 'gate must read the org website_tracking setting');
  assert.ok(
    !/organizationId[^;]*body|body[^;]*organizationId/.test(src),
    'client-supplied organizationId must never drive the gate'
  );
});

// ─── WEBSITE-100-07/08/14 — consent, forged identity, batch atomicity ──────
// Fully covered by tests/website-tracking.test.ts; source-invariant guards:

test('WEBSITE-100-07: consent enforcement stays ahead of the tracking gate (source invariant)', () => {
  const src = readFileSync(path.join(root, 'src/app/api/agent/activity/route.ts'), 'utf8');
  const consentIdx = src.indexOf('hasActiveConsent');
  const gateIdx = src.indexOf('WEBSITE_TRACKING_DISABLED');
  assert.ok(consentIdx !== -1 && gateIdx !== -1 && consentIdx < gateIdx, 'consent check must run before the tracking gate');
});

test('WEBSITE-100-14: batch rejection is atomic (source invariant)', () => {
  const src = readFileSync(path.join(root, 'src/app/api/agent/activity/route.ts'), 'utf8');
  const gateIdx = src.indexOf('WEBSITE_TRACKING_DISABLED');
  const createIdx = src.indexOf('db.activity.createMany');
  assert.ok(gateIdx !== -1 && createIdx !== -1 && gateIdx < createIdx, 'the tracking gate must reject before any write');
  assert.match(src, /filtered\.length === 0/, 'a fully-filtered batch returns without writing');
});

// ─── WEBSITE-100-09 — cross-org WebSocket isolation ────────────────────────

test('WEBSITE-100-09: activity-ping is only ever emitted into org-scoped rooms (source invariant)', () => {
  const src = readFileSync(path.join(root, 'mini-services/live-updates/index.ts'), 'utf8');
  const pingIdx = src.indexOf("'activity-ping'");
  assert.ok(pingIdx !== -1, 'activity-ping event must exist');
  const before = src.slice(Math.max(0, pingIdx - 120), pingIdx);
  assert.match(before, /io\.to\(`org:\$\{[^}]*}\`\)\.emit/, 'must broadcast into an org room');
  assert.ok(!/io\.emit\(['"]activity-ping/.test(src), 'a global broadcast would leak across tenants');
  // The payload itself carries no organization — scoping lives in the room.
  const modSrc = readFileSync(path.join(root, 'mini-services/live-updates/activity-events.ts'), 'utf8');
  assert.ok(!modSrc.includes('organizationId'), 'payload must not embed an organization id');
});

// ─── WEBSITE-100-11/12/13 — pipeline dedup / offline replay invariants ─────
// Agent-side functional coverage exists (collector dedup, encrypted queue
// replay, host domain-only parsing). Cursor-dedup guard for the WS layer:

test('WEBSITE-100-13: poll cursor advances past processed rows after querying (no replay duplicates, source invariant)', () => {
  const src = readFileSync(path.join(root, 'mini-services/live-updates/index.ts'), 'utf8');
  // `now` must be captured BEFORE the queries (no-loss: anything committed
  // after it stays eligible next round) and the cursor must then be RAISED
  // AFTER the queries past the newest processed event row. Advancing before
  // the queries (the pre-fix `cursor = now;`) let a row committed between the
  // capture and the query execution be broadcast TWICE — the duplicate
  // activity-ping that surfaced as duplicate React keys in the Dashboard.
  const sinceIdx = src.indexOf('const since = cursor');
  const captureIdx = src.indexOf('const now = new Date();');
  assert.ok(sinceIdx !== -1 && captureIdx !== -1 && sinceIdx < captureIdx, 'cursor must be captured, then the round queries run');
  const promiseIdx = src.indexOf('await Promise.all');
  const advanceIdx = src.indexOf('cursor = nextPollCursor(now');
  assert.ok(advanceIdx !== -1, 'cursor must be advanced via nextPollCursor');
  assert.ok(promiseIdx !== -1 && promiseIdx < advanceIdx, 'the cursor advance must run AFTER the queries');
  assert.match(src, /createdAt: \{ gt: since \}/, 'activities are polled strictly after the cursor');
});

// ─── WEBSITE-100-15 — incognito is never collected ─────────────────────────

test('WEBSITE-100-15: incognito tabs are excluded at the extension (source invariant)', () => {
  const bg = readFileSync(path.join(root, 'browser-extension/src/background.js'), 'utf8');
  const manifest = readFileSync(path.join(root, 'browser-extension/manifest.json'), 'utf8');
  assert.match(manifest, /"incognito"\s*:\s*"spanning"/, 'manifest must keep spanning (split) incognito');
  assert.ok((bg.match(/tab\.incognito/g) ?? []).length >= 3, 'every report site must guard tab.incognito');
  assert.match(bg, /if \(tab\.incognito\) return;/, 'active-tab handler must skip incognito');
});

// ─── WEBSITE-100-16 — key-pinned extension id is deterministic + allowlisted ─
// P3-1 fix: the extension manifest pins a public key; the id derived from it
// (first 16 bytes of SHA-256 over the DER SubjectPublicKeyInfo, mapped to
// [a-p]) is identical in Chrome and Edge on every machine, and the native
// host manifests must allow-list exactly that id (never a placeholder).

agentTest('WEBSITE-100-16: pinned manifest key derives the allowlisted extension id (source invariant)', async () => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'browser-extension/manifest.json'), 'utf8'));
  assert.equal(typeof manifest.key, 'string', 'manifest must pin a public key for a deterministic id');
  assert.ok(manifest.key.length > 100, 'key must be a real base64 DER SubjectPublicKeyInfo');

  const { deriveExtensionIdFromKey, extensionIdFromManifest } = await import(
    '../omnisight-agent/scripts/install-native-host.mjs'
  );
  const derived = deriveExtensionIdFromKey(manifest.key);
  assert.match(derived ?? '', /^[a-p]{32}$/, 'derived id must be 32 chars in [a-p]');
  assert.equal(extensionIdFromManifest(), derived, 'install script must derive the same id from the manifest');

  for (const file of ['chrome.json', 'edge.json']) {
    const hostManifest = JSON.parse(readFileSync(path.join(root, 'omnisight-agent/native-host-manifests', file), 'utf8'));
    const origins = hostManifest.allowed_origins ?? [];
    assert.equal(origins.length, 1, `${file}: exactly one allowed origin (fail closed)`);
    assert.equal(
      origins[0],
      `chrome-extension://${derived}/`,
      `${file}: allowed_origins must match the id derived from the pinned key`
    );
  }
});
