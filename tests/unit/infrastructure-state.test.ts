// Test-evidence state machine unit tests (Phases 2/3 — verified fixes RC-1, F-2).
//
// Proves the pure rules every consumer (transfer gate, UI, requests views)
// share from src/lib/infrastructure-state.ts:
//   EV-01  Freshness: null/unparsable timestamps are never fresh.
//   EV-02  Freshness: inside the TTL → fresh; beyond it → stale.
//   EV-03  Evidence building: success/failed map to persisted status + a
//          SERVER-computed fingerprint of the tested config.
//   EV-04  deriveConnectionState: untested / test_failed.
//   EV-05  deriveConnectionState: verified when fingerprint matches and fresh.
//   EV-06  deriveConnectionState: config_changed on fingerprint mismatch.
//   EV-07  deriveConnectionState: test_expired when stale.
//   EV-08  deriveConnectionState: legacy evidence without a fingerprint.
//   EV-09  The TTL is exactly 7 days and exported from ONE place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INFRA_TEST_EVIDENCE_TTL_MS,
  INFRA_TEST_EVIDENCE_TTL_DAYS,
  isTestEvidenceFresh,
  buildRequestTestEvidence,
  deriveConnectionState,
} from '../../src/lib/infrastructure-state';
import { configFingerprint, dbConfigFingerprintInput, storageConfigFingerprintInput } from '../../src/lib/infrastructure';

const CONFIG = { kind: 'DATABASE' as const, host: 'db.example.com', port: 5432, name: 'analytics', user: 'postgres', ssl: true, useOwnDb: true };
const HOURS = (n: number) => n * 3600 * 1000;

test('EV-01: null and unparsable timestamps are never fresh', () => {
  assert.equal(isTestEvidenceFresh(null), false);
  assert.equal(isTestEvidenceFresh(undefined), false);
  assert.equal(isTestEvidenceFresh('not-a-date'), false);
});

test('EV-02: evidence inside the TTL is fresh; beyond it is stale', () => {
  const now = new Date('2026-09-17T12:00:00Z');
  assert.equal(isTestEvidenceFresh(new Date(now.getTime() - HOURS(6)), now), true, '6h old → fresh');
  assert.equal(isTestEvidenceFresh(new Date(now.getTime() - 24 * HOURS(6)), now), true, '6d old → fresh');
  assert.equal(isTestEvidenceFresh(new Date(now.getTime() - (INFRA_TEST_EVIDENCE_TTL_MS + 1)), now), false, 'TTL+1ms → stale');
  // FUTURE timestamps (clock skew) are not fresh — evidence cannot predate its check.
  assert.equal(isTestEvidenceFresh(new Date(now.getTime() + HOURS(2)), now), false);
});

test('EV-03: buildRequestTestEvidence maps results to persisted evidence with a server-computed fingerprint', async () => {
  const ok = await buildRequestTestEvidence({ ok: true, message: 'Database connection successful' }, CONFIG);
  assert.equal(ok.lastTestStatus, 'success');
  assert.equal(ok.lastTestMessage, 'Database connection successful');
  assert.ok(ok.lastTestedAt instanceof Date);
  const expectedFp = await configFingerprint(dbConfigFingerprintInput(CONFIG));
  assert.equal(ok.lastTestConfigFingerprint, expectedFp, 'fingerprint is recomputed SERVER-side from the tested config');

  const fail = await buildRequestTestEvidence({ ok: false, message: 'nope' }, CONFIG);
  assert.equal(fail.lastTestStatus, 'failed');

  // STORAGE variant fingerprints the storage input shape.
  const st = await buildRequestTestEvidence({ ok: true, message: 'ok' }, { kind: 'STORAGE', driver: 'supabase', url: 'https://x.supabase.co' });
  assert.equal(st.lastTestConfigFingerprint, await configFingerprint(storageConfigFingerprintInput({ driver: 'supabase', url: 'https://x.supabase.co' })));
});

test('EV-04: no success evidence → untested; a failed test → test_failed', () => {
  assert.equal(deriveConnectionState({ lastTestStatus: null, lastTestedAt: null, lastTestConfigFingerprint: null }, null), 'untested');
  assert.equal(deriveConnectionState({ lastTestStatus: 'failed', lastTestedAt: new Date(), lastTestConfigFingerprint: 'x' }, 'x'), 'test_failed');
});

test('EV-05: matching fingerprint + fresh timestamp → verified', async () => {
  const fp = await configFingerprint(dbConfigFingerprintInput(CONFIG));
  const state = deriveConnectionState(
    { lastTestStatus: 'success', lastTestedAt: new Date(Date.now() - HOURS(1)), lastTestConfigFingerprint: fp },
    fp
  );
  assert.equal(state, 'verified');
});

test('EV-06: fingerprint mismatch → config_changed (even when fresh)', async () => {
  const tested = await configFingerprint(dbConfigFingerprintInput(CONFIG));
  const submitted = await configFingerprint(dbConfigFingerprintInput({ ...CONFIG, port: 6543 }));
  assert.notEqual(tested, submitted);
  const state = deriveConnectionState(
    { lastTestStatus: 'success', lastTestedAt: new Date(), lastTestConfigFingerprint: tested },
    submitted
  );
  assert.equal(state, 'config_changed');
});

test('EV-07: success but stale → test_expired', () => {
  const state = deriveConnectionState(
    { lastTestStatus: 'success', lastTestedAt: new Date(Date.now() - (INFRA_TEST_EVIDENCE_TTL_MS + HOURS(1))), lastTestConfigFingerprint: 'abc' },
    'abc'
  );
  assert.equal(state, 'test_expired');
});

test('EV-08: legacy success evidence without a fingerprint degrades to freshness only', () => {
  const fresh = deriveConnectionState({ lastTestStatus: 'success', lastTestedAt: new Date(), lastTestConfigFingerprint: null }, null);
  assert.equal(fresh, 'verified', 'legacy rows: trust the status, binding unknown');
  const stale = deriveConnectionState({ lastTestStatus: 'success', lastTestedAt: new Date(Date.now() - INFRA_TEST_EVIDENCE_TTL_MS - 1), lastTestConfigFingerprint: null }, null);
  assert.equal(stale, 'test_expired');
  // A legacy row compared against a KNOWN config fingerprint is not verifiable
  // as a match — it stays on the freshness-only path (the gate separately
  // requires the fingerprint for the transfer to proceed).
  const legacyVsKnown = deriveConnectionState({ lastTestStatus: 'success', lastTestedAt: new Date(), lastTestConfigFingerprint: null }, 'known-fp');
  assert.equal(legacyVsKnown, 'verified');
});

test('EV-09: the TTL is 7 days, defined once', () => {
  assert.equal(INFRA_TEST_EVIDENCE_TTL_DAYS, 7);
  assert.equal(INFRA_TEST_EVIDENCE_TTL_MS, 7 * 24 * 3600 * 1000);
});
