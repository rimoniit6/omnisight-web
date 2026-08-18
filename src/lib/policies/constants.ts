// OmniSight — Policy Management canonical constants.
//
// Single source of truth for the app whitelist/blacklist + USB monitoring
// domain. The admin API, the agent config payload, the agent collectors, the
// realtime mapping and the tests all derive from these values — string
// literals must never be scattered across the application.

// ─── App list types ─────────────────────────────────────────────────────────

export const APP_LIST_TYPES = ['whitelist', 'blacklist'] as const;
export type AppListType = (typeof APP_LIST_TYPES)[number];

export function isValidAppListType(value: unknown): value is AppListType {
  return typeof value === 'string' && (APP_LIST_TYPES as readonly string[]).includes(value);
}

// ─── Policy resolution semantics ────────────────────────────────────────────
// Deterministic precedence (documented in resolver.ts):
//   1. Explicit blacklist match  → BLOCK
//   2. Explicit whitelist match  → ALLOW
//   3. No matching policy        → default (none)
// This is an org-wide policy contract — there is no employee/device targeting
// in the current schema, so scope is always organization-wide.

export const POLICY_ACTIONS = ['allow', 'block', 'none'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

// ─── Enforcement ────────────────────────────────────────────────────────────
// The agent NEVER blocks its own process, Windows critical processes, or the
// protected system allowlist. Mirrored agent-side in the PolicyEnforcer
// (omnisight-agent/src/collectors/policy-enforcer.ts) — keep both lists in sync.
export const PROTECTED_PROCESS_NAMES: readonly string[] = [
  // OmniSight agent binaries (self-protection) — legacy names kept during
  // the brand transition.
  'omnisight-agent.exe',
  'omnisight.exe',
  'worklensai-agent.exe',
  'worklensai.exe',
  'electron.exe', // packaged agent host (matches its own main process)
  // Windows critical system processes — never terminable.
  'system',
  'registry',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'services.exe',
  'lsass.exe',
  'lsaiso.exe',
  'winlogon.exe',
  'fontdrvhost.exe',
  'dwm.exe',
  'svchost.exe',
  'wininit.exe',
];

/** Violation severity classes reported by the agent (validated server-side). */
export const VIOLATION_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type ViolationSeverity = (typeof VIOLATION_SEVERITIES)[number];

export function isValidViolationSeverity(value: unknown): value is ViolationSeverity {
  return typeof value === 'string' && (VIOLATION_SEVERITIES as readonly string[]).includes(value);
}

// ─── USB events ─────────────────────────────────────────────────────────────

export const USB_EVENT_TYPES = ['usb_insert', 'usb_remove', 'usb_blocked'] as const;
export type UsbEventType = (typeof USB_EVENT_TYPES)[number];

export function isValidUsbEventType(value: unknown): value is UsbEventType {
  return typeof value === 'string' && (USB_EVENT_TYPES as readonly string[]).includes(value);
}

// ─── Limits (bounded payloads at every write boundary) ──────────────────────

export const MAX_APP_NAME_LENGTH = 120;
export const MAX_EXECUTABLE_NAME_LENGTH = 260; // MAX_PATH
export const MAX_PROCESS_PATH_LENGTH = 1024;
export const MAX_PUBLISHER_LENGTH = 120;
export const MAX_SHA256_LENGTH = 64;
export const MAX_POLICY_REASON_LENGTH = 500;
export const MAX_POLICY_CATEGORY_LENGTH = 50;

export const MAX_USB_DEVICE_NAME_LENGTH = 120;
export const MAX_USB_VENDOR_NAME_LENGTH = 120;
export const MAX_USB_SERIAL_LENGTH = 100;
export const MAX_USB_FILE_PATH_LENGTH = 1024;
export const MAX_USB_VID_PID_LENGTH = 8; // hex id, e.g. "VID_1234" / "1234"
export const MAX_USB_DEVICE_CLASS_LENGTH = 50;
export const MAX_USB_DRIVE_LETTER_LENGTH = 8;

export const MAX_VIOLATION_EXECUTABLE_LENGTH = 260;
export const MAX_VIOLATION_METADATA_BYTES = 2048;

/** Max number of active policy entries shipped to an agent in one config sync. */
export const MAX_POLICY_PAYLOAD_ENTRIES = 2000;

/** Dedupe window for repeated USB insert events of the same device (ms). */
export const USB_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/** Dedupe window for repeated identical policy violations (ms). */
export const VIOLATION_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

// ─── OrganizationSetting keys (policy versioning) ───────────────────────────

/**
 * Monotonically increasing org policy version, stored in OrganizationSetting.
 * Bumped inside the same transaction as every policy write; the agent config
 * payload exposes it so agents can detect unchanged/stale policy without
 * comparing full lists.
 */
export const APP_POLICY_VERSION_SETTING_KEY = 'app_policy_version';

export const DEFAULT_POLICY_VERSION = '0';
