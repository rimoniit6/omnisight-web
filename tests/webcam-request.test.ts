/**
 * Webcam start-request timing contract (src/lib/webcam-request.ts).
 *
 * Regression for the Admin webcam "stuck on REQUESTING" defect: after an
 * operator clicks Start, the panel must keep polling the server status and
 * must surface an explicit error when the agent never opens the camera within
 * the command-expiry bound — instead of waiting forever.
 *
 * The pure helper pins that bound (120s server expiry + 30s grace) so the UI
 * and the server can never disagree about when a start request has failed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUEST_TIMEOUT_MS,
  webcamRequestExpired,
} from '../src/lib/webcam-request';

const T0 = 1_750_000_000_000;

test('WR-1: request not expired while within the bound', () => {
  assert.equal(webcamRequestExpired(T0, false, T0 + REQUEST_TIMEOUT_MS), false);
  assert.equal(webcamRequestExpired(T0, false, T0 + 10_000), false);
});

test('WR-2: request expired after the bound without a session', () => {
  assert.equal(webcamRequestExpired(T0, false, T0 + REQUEST_TIMEOUT_MS + 1), true);
  assert.equal(webcamRequestExpired(T0, false, T0 + 200_000), true);
});

test('WR-3: a session that appeared means the request succeeded, never expired', () => {
  // Even long after the bound, a server-registered session is authoritative.
  assert.equal(webcamRequestExpired(T0, true, T0 + 10 * 60_000), false);
});

test('WR-4: invalid/missing deadlines never expire (fail safe to the poll path)', () => {
  assert.equal(webcamRequestExpired(0, false, T0), false);
  assert.equal(webcamRequestExpired(NaN, false, T0), false);
  assert.equal(webcamRequestExpired(-5, false, T0), false);
});

test('WR-5: the bound matches the server command expiry (120s) + grace', () => {
  // The server expires commands after 120s by default; the UI must wait at
  // least that long, plus a small grace for command-poll latency (10s).
  assert.ok(REQUEST_TIMEOUT_MS >= 120_000);
  assert.ok(REQUEST_TIMEOUT_MS <= 180_000);
});
