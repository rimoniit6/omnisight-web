import { test } from 'node:test';
import assert from 'node:assert/strict';

// Pure state-machine helpers only — no DB queries run at import (the client is
// lazy), so this unit test stays hermetic.
import { isVerifiedComplete, canTransitionMigration } from '../../src/lib/migration/runner';

test('isVerifiedComplete: verified only when done genuinely reaches the snapshot total', () => {
  // The exact stale state this audit fixes: ready with under-counted progress.
  assert.equal(isVerifiedComplete(1481, 1491), false, 'pre-fix 1481/1491 is NOT verified complete');
  assert.equal(isVerifiedComplete(1491, 1491), true, 'done === total is verified complete');
  assert.equal(isVerifiedComplete(1502, 1491), true, 'present may exceed the snapshot — capped done === total is still complete');
  assert.equal(isVerifiedComplete(0, 1491), false, 'zero done is not complete');
  assert.equal(isVerifiedComplete(1490, 1491), false, 'one short is still incomplete');
  assert.equal(isVerifiedComplete(0, 0), false, 'no snapshot denominator yet — never claim verified');
});

test('ready_to_activate is a terminal-success state: activation is the ONLY forward transition', () => {
  assert.equal(canTransitionMigration('ready_to_activate', 'activated'), true);
  // A normal flow can never re-queue or fail a ready migration (reconciliation
  // revoking to failed is a guarded, audited backfill — not a flow transition).
  assert.equal(canTransitionMigration('ready_to_activate', 'queued'), false);
  assert.equal(canTransitionMigration('ready_to_activate', 'failed'), false);
});