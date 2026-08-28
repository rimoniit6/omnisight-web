# LOCATION TEST CONTRACT FIX — 2026-08-28

## Current Failures (Before Fix)

Three agent tests failed after introducing explicit `source` metadata and correcting IP fallback accuracy semantics:

| Test | Root Cause | Expected | Actual |
|------|-----------|----------|--------|
| LOC-5 | `source` field added to upload payload | `['accuracy', 'latitude', 'longitude', 'timestamp']` | `['accuracy', 'latitude', 'longitude', 'source', 'timestamp']` |
| LOC-FB3 | IP fallback accuracy corrected to `null` | `accuracy === 10_000` | `accuracy === null` |
| LOC-FB1 | IP fallback accuracy no longer numeric | `result.accuracy > 0` | `result.accuracy === null` (false for `null > 0`) |

## Root Cause of Each Failure

### LOC-5

The `LocationCollector.upload()` method creates a `LocationUploadRecord` that now includes the `source` field. The mock native sample was missing `source`, but after the production code added `source` to the upload record, the test's `Object.keys(rec).sort()` assertion broke because the record now contains 5 fields instead of 4.

**Fix**: Added `source: 'native'` to the default mock sample. Updated the key assertion to `['accuracy', 'latitude', 'longitude', 'source', 'timestamp']`. Added explicit `source === 'native'` verification.

### LOC-FB3

The `ipLocationFallback()` method was updated to return `accuracy: null` instead of the fabricated `10_000` value. The test still expected the old `10_000`.

**Fix**: Updated the assertion to `result.accuracy === null`. Added `result.source === 'ip'` verification. Added coordinate range validation.

### LOC-FB1

When the native addon returns `unavailable` and the IP fallback succeeds, `result.accuracy` is now `null`. The test asserted `result.accuracy > 0` which fails for `null`. The test was trying to verify "successful location" but used the wrong assertion for the fallback case.

**Fix**: Restructured the test to distinguish native vs IP fallback paths. Native path asserts `accuracy >= 0`. IP fallback path asserts `accuracy === null`. Added source-aware assertions.

## Production Code Changes

**NONE.** No production code was modified. All changes are test-only.

## Test Changes

### LOC-5 (location-collector.test.ts)

```diff
- test('LOC-5: tick uploads a valid fix (coordinates + accuracy + timestamp only)')
+ test('LOC-5: tick uploads a valid fix (coordinates + accuracy + timestamp + source)')
  ...
+ assert.equal(rec.source, 'native', 'native fix must carry source=native');
- assert.deepEqual(Object.keys(rec).sort(), ['accuracy', 'latitude', 'longitude', 'timestamp']);
+ assert.deepEqual(Object.keys(rec).sort(), ['accuracy', 'latitude', 'longitude', 'source', 'timestamp']);
```

Default mock sample updated:
```diff
  return overrides.sample ?? {
    ok: true, latitude: 23.8103, longitude: 90.4125, accuracy: 25, timestamp: now,
+   source: 'native' as const,
    error: 'none',
  };
```

### LOC-FB3 (location-collector.test.ts)

```diff
- assert.equal(result.accuracy, 10_000); // IP-level
+ assert.equal(result.source, 'ip', 'IP fallback must carry source=ip');
+ assert.equal(result.accuracy, null, 'IP fallback accuracy must be null — no fabricated precision');
+ assert.ok(typeof result.latitude === 'number' && result.latitude >= -90 && result.latitude <= 90, `latitude valid: ${result.latitude}`);
+ assert.ok(typeof result.longitude === 'number' && result.longitude >= -180 && result.longitude <= 180, `longitude valid: ${result.longitude}`);
+ assert.ok(typeof result.timestamp === 'number' && result.timestamp > 0, 'timestamp must be positive epoch ms');
```

### LOC-FB1 (location-collector.test.ts)

```diff
  if (result.ok) {
    assert.ok(typeof result.latitude === 'number', 'latitude must be a number');
    assert.ok(typeof result.longitude === 'number', 'longitude must be a number');
-   assert.ok(result.accuracy > 0);
+   if (result.source === 'ip') {
+     assert.equal(result.accuracy, null, 'IP fallback accuracy must be null');
+     assert.ok(result.latitude >= -90 && result.latitude <= 90, 'IP latitude valid');
+     assert.ok(result.longitude >= -180 && result.longitude <= 180, 'IP longitude valid');
+   } else if (result.source === 'native') {
+     assert.ok(typeof result.accuracy === 'number' && result.accuracy >= 0, 'native accuracy must be numeric');
+   }
  }
```

### New Regression Tests

Five new tests added to prevent source confusion:

| Test | Purpose |
|------|---------|
| LOC-SRC-1 | Native success → `source=native`, IP fallback NOT used |
| LOC-SRC-2 | IP fallback → `source=ip`, `accuracy=null` |
| LOC-SRC-3 | Native failure + IP failure → no fabricated coordinates |
| LOC-SRC-4 | Source is never "GPS" or "native" when IP fallback was used |
| LOC-SRC-5 | Upload payload includes `source` for both native and IP |

## Location Contract

```
native (Windows device location):
  latitude  = numeric (GPS/WiFi accuracy)
  longitude = numeric
  accuracy  = numeric (meters) when provider supplies it
  source    = "native"
  timestamp = ISO/epoch ms

ip (IP geolocation fallback):
  latitude  = numeric (approximate city-level)
  longitude = numeric
  accuracy  = null (no trustworthy meter-level value)
  source    = "ip"
  timestamp = ISO/epoch ms
```

Key principle: **Coordinate ≠ Accuracy ≠ Source**. An IP coordinate is valid. Its accuracy is unknown (null). Its source is "ip". No fabricated precision.

## Verification

```
Agent tests:       648/648 pass
Agent typecheck:   PASS (tsc --noEmit)
Agent build:       PASS (npm run build)
Web tests:         22/22 location tests pass
Web typecheck:     PASS (tsc --noEmit)
```

## Final Verdict

```
TEST CONTRACT CORRECTED — PASS
```

All 648 agent tests pass. Three tests updated to reflect the corrected location contract (source metadata + null accuracy for IP fallback). Five new regression tests added to prevent source confusion. No production code modified.
