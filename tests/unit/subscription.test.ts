import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanFeatures, hasValidTrial } from '../../src/lib/subscription';

test('parsePlanFeatures: null/undefined/empty -> []', () => {
  assert.deepEqual(parsePlanFeatures(null), []);
  assert.deepEqual(parsePlanFeatures(undefined), []);
  assert.deepEqual(parsePlanFeatures(''), []);
});

test('parsePlanFeatures: array passthrough (string coercion)', () => {
  assert.deepEqual(parsePlanFeatures(['a', 'b', 3]), ['a', 'b', '3']);
});

test('parsePlanFeatures: JSON string array parsed', () => {
  assert.deepEqual(parsePlanFeatures('["a","b"]'), ['a', 'b']);
});

test('parsePlanFeatures: non-array / malformed JSON -> []', () => {
  assert.deepEqual(parsePlanFeatures('{"a":1}'), []);
  assert.deepEqual(parsePlanFeatures('not json'), []);
  assert.deepEqual(parsePlanFeatures(42), []);
});

test('hasValidTrial: null trialEndsAt -> false', () => {
  assert.equal(hasValidTrial({ trialEndsAt: null }), false);
});

test('hasValidTrial: future date -> true', () => {
  const future = new Date(Date.now() + 60_000);
  assert.equal(hasValidTrial({ trialEndsAt: future }), true);
});

test('hasValidTrial: past/expired date -> false', () => {
  const past = new Date(Date.now() - 60_000);
  assert.equal(hasValidTrial({ trialEndsAt: past }), false);
});
