// OmniSight — single source of truth for cross-cutting configuration
// constants (hardening area 5).
//
// Every non-local magic number that is shared between modules — or that a
// reviewer would reasonably expect to tune without hunting the code — lives
// here. Module-local constants that are private to one function and never
// shared stay where they are; anything imported by two or more modules MUST
// live here so the value can never drift between layers.

// ─── Cross-tenant device lookup (hardening area 1) ─────────────────────────
// Cap for the RARE bounded scan that backfills the global device routing
// index. With the index warm this path never runs; when it does (cold start,
// crash between device write and index upsert) it is capped for latency AND
// to bound the cross-tenant existence oracle.
export const DEVICE_ROUTING_SCAN_LIMIT = 25;
// How long an in-memory DeviceRouting resolution stays hot before re-reading
// the platform index. Misses are never cached (a miss is instantly re-scanned
// and write-through upserts immediately).
export const DEVICE_ROUTING_TTL_MS = 60_000;
// Page size for the daily index backfill (integrity job).
export const DEVICE_ROUTING_BACKFILL_BATCH = 500;
// Bounded per-org analytics-client cache (org-db.ts) / storage-driver cache.
export const ORG_CLIENT_CACHE_LIMIT = 100;

// ─── Device claims ──────────────────────────────────────────────────────────
// Claim lifecycle TTL issued at discovery (30 days) — must match the creation
// sites in src/app/api/agent/discover/route.ts.
export const DEVICE_CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Approval-reminder trigger: a pending claim older than this gets a reminder
// to the org admins (src/lib/jobs/device-claim-reminders.ts).
export const DEVICE_CLAIM_REMINDER_AFTER_MS = 2 * 60 * 60 * 1000;
// Reminder cooldown: never re-remind the same claim more than once per 24h.
export const DEVICE_CLAIM_REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ─── Anomaly detection (hardening area 4) ───────────────────────────────────
// Engine rule thresholds (reused by src/lib/anomalies/detect.ts).
export const ANOMALY_PRODUCTIVITY_DROP_THRESHOLD_PCT = 30;
export const ANOMALY_MIN_BASELINE_DAYS = 5;
export const ANOMALY_EXCESSIVE_IDLE_THRESHOLD_MINUTES = 120;
export const ANOMALY_OFF_HOURS_MIN_COUNT = 5;
export const ANOMALY_OFF_HOURS_MIN_RATIO = 0.5;
export const ANOMALY_LOW_ACTIVITY_MIN_AVG = 20;
export const ANOMALY_LOW_ACTIVITY_RATIO = 0.3;
export const ANOMALY_LOW_ACTIVITY_MAX_TODAY = 10;
// Observation + baseline windows (src/lib/anomalies/service.ts).
export const ANOMALY_RECENT_DAYS = 7;
export const ANOMALY_BASELINE_WINDOW_DAYS = 30;
// Rolling-baseline refresh cadence: the persisted EmployeeBaseline store is
// rebuilt from the trailing 30-day window, configured here so the compute,
// the alert copy and the UI can never disagree.
export const ANOMALY_BASELINE_WINDOW_DAYS_PERSISTED = 30;
// Grace period: employees whose joinDate falls inside this window are never
// anomaly-scored (the exposed equivalent of "baseline not ready yet", F-17).
export const ANOMALY_GRACE_PERIOD_DAYS = 14;

// ─── Data integrity / storage hygiene (hardening area 3) ──────────────────
// The daily integrity job reconciles screenshot artifacts created within this
// lookback (bounded on purpose — pre-retention full scans can be enormous).
export const STORAGE_INTEGRITY_LOOKBACK_DAYS = 14;
// FK-integrity scan for activity rows newer than this window.
export const ACTIVITY_FK_LOOKBACK_DAYS = 1;