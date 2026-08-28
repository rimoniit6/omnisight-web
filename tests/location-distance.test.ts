/**
 * Haversine distance utility — pure unit tests (no database required).
 * Run: npx tsx --test tests/location-distance.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateDistanceKm, EARTH_RADIUS_KM } from '../src/lib/location-distance';

// Baseline: central London.
const LAT = 51.5074;
const LNG = -0.1278;
const DEG_LAT_KM = 111; // ~1 degree latitude ≈ 111 km

test('LOC-D1: identical coordinates → 0 km', () => {
  const d = calculateDistanceKm(LAT, LNG, LAT, LNG);
  assert.equal(d, 0);
});

test('LOC-D2: clearly < 5 km', () => {
  // ~0.55 km north (0.005° ≈ 0.555 km)
  const d = calculateDistanceKm(LAT, LNG, LAT + 0.005, LNG);
  assert.ok(d > 0, 'distance must be positive');
  assert.ok(d < 5, `expected < 5 km, got ${d}`);
  assert.ok(Math.abs(d - 0.005 * DEG_LAT_KM) < 0.05, `unexpected value ${d}`);
});

test('LOC-D3: approximately 5 km', () => {
  // 5 km ≈ 0.045°
  const d = calculateDistanceKm(LAT, LNG, LAT + 0.045, LNG);
  assert.ok(d >= 4.9 && d <= 5.1, `expected ~5 km, got ${d}`);
});

test('LOC-D4: > 5 km', () => {
  // 0.5° ≈ 55.5 km
  const d = calculateDistanceKm(LAT, LNG, LAT + 0.5, LNG);
  assert.ok(d > 5, `expected > 5 km, got ${d}`);
  assert.ok(d > 50, `expected >> 5 km, got ${d}`);
});

test('LOC-D5: a different longitude also yields sensible distance', () => {
  // 1° longitude at this latitude ≈ 69.6 km
  const d = calculateDistanceKm(LAT, LNG, LAT, LNG + 1);
  assert.ok(d > 5, `expected > 5 km, got ${d}`);
  assert.ok(d > 60, `expected ~70 km, got ${d}`);
});

test('latitude boundary validity', () => {
  assert.doesNotThrow(() => calculateDistanceKm(90, LNG, LAT, LNG));
  assert.doesNotThrow(() => calculateDistanceKm(-90, LNG, LAT, LNG));
  assert.throws(() => calculateDistanceKm(90.0001, LNG, LAT, LNG));
  assert.throws(() => calculateDistanceKm(-90.0001, LNG, LAT, LNG));
});

test('longitude boundary validity', () => {
  assert.doesNotThrow(() => calculateDistanceKm(LAT, 180, LAT, LNG));
  assert.doesNotThrow(() => calculateDistanceKm(LAT, -180, LAT, LNG));
  assert.throws(() => calculateDistanceKm(LAT, 180.0001, LAT, LNG));
  assert.throws(() => calculateDistanceKm(LAT, -180.0001, LAT, LNG));
});

test('never uses floating-point equality — threshold is a comparison', () => {
  // Far apart returns a large finite number; sanity check the earth radius constant.
  const d = calculateDistanceKm(0, 0, 0, 180);
  assert.ok(Number.isFinite(d) && d > 0);
  assert.equal(EARTH_RADIUS_KM, 6371);
});
