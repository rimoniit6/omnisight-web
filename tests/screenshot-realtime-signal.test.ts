/**
 * CUSTOMER_DB realtime screenshot delivery signal
 * (src/lib/screenshots/realtime-signal.ts).
 *
 * Regression contract (CUSTOMER_DB realtime gap):
 *   - For a MANAGED org (orgData === db) NO signal is written — the
 *     live-updates poller reads the Screenshot row directly, so writing a
 *     signal too would double-notify (the exact duplicate the contract forbids).
 *   - For a CUSTOMER_DB org (orgData !== db) exactly ONE platform-side signal
 *     is written carrying the fields live-updates needs to emit the same
 *     'new-screenshot' event a MANAGED org receives (employeeId / employeeName
 *     / appWindow / capturedAt).
 *   - A signal write failure must never fail the upload (returns false, not
 *     throws) — the screenshot row + object are already durably stored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signalScreenshotRealtime } from '../src/lib/screenshots/realtime-signal';

const PAYLOAD = {
  organizationId: 'org-customer-1',
  employeeId: 'emp-customer-1',
  employeeName: 'Ada Lovelace',
  appWindow: 'Code - Insiders',
  capturedAt: new Date('2026-09-12T12:00:00.000Z'),
};

function makeDb(createFn?: (data: { data: unknown }) => Promise<unknown>) {
  return {
    realtimeScreenshotEvent: {
      create: createFn ?? (async () => ({ id: 'sig-1' })),
    },
  } as unknown as never;
}

test('MANAGED org (orgData === db): no signal is written, poller reads Screenshot directly', async () => {
  let createCalls = 0;
  const db = makeDb(async () => {
    createCalls += 1;
    return { id: 'sig-1' };
  });

  const result = await signalScreenshotRealtime(db, db, PAYLOAD);

  assert.equal(result, false, 'MANAGED org must skip the signal path');
  assert.equal(createCalls, 0, 'no platform signal for a MANAGED org (Screenshot row is polled)');
});

test('CUSTOMER_DB org: exactly one platform signal written with the full realtime payload', async () => {
  let createCalls = 0;
  let written: unknown = null;
  const db = makeDb(async ({ data }) => {
    createCalls += 1;
    written = data;
    return { id: 'sig-1' };
  });
  // Distinct object = org-owned Prisma client (orgData !== db).
  const orgData = { screenshot: { create: async () => ({}) } } as never;

  const result = await signalScreenshotRealtime(db, orgData, PAYLOAD);

  assert.equal(result, true);
  assert.equal(createCalls, 1, 'exactly one signal per upload');
  assert.deepEqual(written, PAYLOAD, 'signal carries everything live-updates needs to emit new-screenshot');
});

test('payload parity: emitted fields match the MANAGED new-screenshot contract', () => {
  // The live-updates broadcast uses id/employeeId/employeeName/appWindow/timestamp.
  // The signal row is the source of those fields for CUSTOMER_DB orgs.
  const signalRow = {
    id: 'sig-1',
    organizationId: PAYLOAD.organizationId,
    employeeId: PAYLOAD.employeeId,
    employeeName: PAYLOAD.employeeName,
    appWindow: PAYLOAD.appWindow,
    capturedAt: PAYLOAD.capturedAt,
  };
  assert.equal(signalRow.employeeId, PAYLOAD.employeeId);
  assert.equal(signalRow.employeeName, PAYLOAD.employeeName);
  assert.equal(signalRow.appWindow, PAYLOAD.appWindow);
  // timestamp in the event is capturedAt.toISOString() — same as Screenshot path.
  assert.equal(signalRow.capturedAt.toISOString(), '2026-09-12T12:00:00.000Z');
});

test('signal write failure returns false — realtime is best-effort, the upload never fails', async () => {
  const db = makeDb(async () => {
    throw new Error('platform db down');
  });
  const orgData = {} as never;

  const result = await signalScreenshotRealtime(db, orgData, PAYLOAD);

  assert.equal(result, false, 'a signal failure must not propagate to the upload response');
});

test('null-ish display fields are carried as-is (null appWindow/name tolerated)', async () => {
  let written: unknown = null;
  const db = makeDb(async ({ data }) => {
    written = data;
    return { id: 'sig-1' };
  });
  const orgData = {} as never;

  await signalScreenshotRealtime(db, orgData, {
    ...PAYLOAD,
    employeeName: null,
    appWindow: null,
  });

  assert.deepEqual(written, { ...PAYLOAD, employeeName: null, appWindow: null });
});