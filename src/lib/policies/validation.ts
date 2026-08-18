// OmniSight — Shared policy/USB input validation.
//
// Used by the admin API routes AND the agent endpoints so the web boundary
// and the agent boundary can never drift. All validation is strict: malformed
// values are rejected with a 4xx (422 convention), never silently coerced.

import {
  MAX_APP_NAME_LENGTH,
  MAX_EXECUTABLE_NAME_LENGTH,
  MAX_POLICY_CATEGORY_LENGTH,
  MAX_POLICY_REASON_LENGTH,
  MAX_PROCESS_PATH_LENGTH,
  MAX_PUBLISHER_LENGTH,
  MAX_SHA256_LENGTH,
  MAX_USB_DEVICE_CLASS_LENGTH,
  MAX_USB_DEVICE_NAME_LENGTH,
  MAX_USB_DRIVE_LETTER_LENGTH,
  MAX_USB_FILE_PATH_LENGTH,
  MAX_USB_SERIAL_LENGTH,
  MAX_USB_VENDOR_NAME_LENGTH,
  MAX_USB_VID_PID_LENGTH,
  MAX_VIOLATION_EXECUTABLE_LENGTH,
  MAX_VIOLATION_METADATA_BYTES,
  isValidAppListType,
  isValidUsbEventType,
  isValidViolationSeverity,
} from './constants';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function optionalString(
  raw: unknown,
  field: string,
  maxLength: number
): ValidationResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return fail(`${field} must be a string`);
  const v = raw.trim();
  if (v.length > maxLength) return fail(`${field} must be at most ${maxLength} characters`);
  return { ok: true, value: v.length === 0 ? null : v };
}

// ─── App list entry (POST /api/app-list) ────────────────────────────────────

export interface AppListInput {
  appName: string;
  executableName: string | null;
  category: string | null;
  listType: 'whitelist' | 'blacklist';
  reason: string | null;
  publisher: string | null;
  sha256: string | null;
  path: string | null;
}

export function validateAppListInput(raw: Record<string, unknown>): ValidationResult<AppListInput> {
  const appName = raw.appName;
  if (typeof appName !== 'string' || appName.trim().length === 0) {
    return fail('appName is required');
  }
  if (appName.trim().length > MAX_APP_NAME_LENGTH) {
    return fail(`appName must be at most ${MAX_APP_NAME_LENGTH} characters`);
  }

  if (!isValidAppListType(raw.listType)) {
    return fail(`listType must be one of: whitelist, blacklist`);
  }

  const executable = optionalString(raw.executableName, 'executableName', MAX_EXECUTABLE_NAME_LENGTH);
  if (!executable.ok) return executable;
  const category = optionalString(raw.category, 'category', MAX_POLICY_CATEGORY_LENGTH);
  if (!category.ok) return category;
  const reason = optionalString(raw.reason, 'reason', MAX_POLICY_REASON_LENGTH);
  if (!reason.ok) return reason;
  const publisher = optionalString(raw.publisher, 'publisher', MAX_PUBLISHER_LENGTH);
  if (!publisher.ok) return publisher;
  const path = optionalString(raw.path, 'path', MAX_PROCESS_PATH_LENGTH);
  if (!path.ok) return path;

  let sha256: string | null = null;
  if (raw.sha256 !== undefined && raw.sha256 !== null) {
    const v = optionalString(raw.sha256, 'sha256', MAX_SHA256_LENGTH);
    if (!v.ok) return v;
    if (v.value !== null && !/^[0-9a-f]{64}$/i.test(v.value)) {
      return fail('sha256 must be a 64-character hex string');
    }
    sha256 = v.value ? v.value.toLowerCase() : null;
  }

  return {
    ok: true,
    value: {
      appName: appName.trim(),
      executableName: executable.value,
      category: category.value,
      listType: raw.listType as 'whitelist' | 'blacklist',
      reason: reason.value,
      publisher: publisher.value,
      sha256,
      path: path.value,
    },
  };
}

// ─── USB event (POST /api/agent/usb) ────────────────────────────────────────

export interface UsbEventInput {
  eventType: 'usb_insert' | 'usb_remove';
  deviceName: string | null;
  vendorName: string | null;
  serialNumber: string | null;
  vid: string | null;
  pid: string | null;
  manufacturer: string | null;
  deviceClass: string | null;
  driveLetter: string | null;
  filePath: string | null;
  occurredAt: Date | null;
}

export function validateUsbEventInput(raw: Record<string, unknown>): ValidationResult<UsbEventInput> {
  if (!isValidUsbEventType(raw.eventType)) {
    return fail('eventType must be one of: usb_insert, usb_remove, usb_blocked');
  }
  // The agent reports insert/remove only — blocked is server-derived (never
  // client-controlled), so accept only the two real observation types.
  if (raw.eventType === 'usb_blocked') {
    return fail('usb_blocked cannot be reported by an agent');
  }

  const deviceName = optionalString(raw.deviceName, 'deviceName', MAX_USB_DEVICE_NAME_LENGTH);
  if (!deviceName.ok) return deviceName;
  const vendorName = optionalString(raw.vendorName, 'vendorName', MAX_USB_VENDOR_NAME_LENGTH);
  if (!vendorName.ok) return vendorName;
  const manufacturer = optionalString(raw.manufacturer, 'manufacturer', MAX_USB_VENDOR_NAME_LENGTH);
  if (!manufacturer.ok) return manufacturer;
  const serialNumber = optionalString(raw.serialNumber, 'serialNumber', MAX_USB_SERIAL_LENGTH);
  if (!serialNumber.ok) return serialNumber;
  const deviceClass = optionalString(raw.deviceClass, 'deviceClass', MAX_USB_DEVICE_CLASS_LENGTH);
  if (!deviceClass.ok) return deviceClass;
  const driveLetter = optionalString(raw.driveLetter, 'driveLetter', MAX_USB_DRIVE_LETTER_LENGTH);
  if (!driveLetter.ok) return driveLetter;
  const filePath = optionalString(raw.filePath, 'filePath', MAX_USB_FILE_PATH_LENGTH);
  if (!filePath.ok) return filePath;

  const vid = optionalString(raw.vid, 'vid', MAX_USB_VID_PID_LENGTH);
  if (!vid.ok) return vid;
  const pid = optionalString(raw.pid, 'pid', MAX_USB_VID_PID_LENGTH);
  if (!pid.ok) return pid;
  for (const [field, value] of [['vid', vid.value], ['pid', pid.value]] as const) {
    if (value !== null && !/^[0-9a-fA-F]{1,8}$/.test(value)) {
      return fail(`${field} must be a hex identifier`);
    }
  }

  let occurredAt: Date | null = null;
  if (raw.occurredAt !== undefined && raw.occurredAt !== null) {
    if (typeof raw.occurredAt !== 'string') return fail('occurredAt must be an ISO string');
    const parsed = new Date(raw.occurredAt);
    if (Number.isNaN(parsed.getTime())) return fail('occurredAt is not a valid date');
    if (parsed.getTime() > Date.now() + 5 * 60 * 1000) {
      return fail('occurredAt is in the future');
    }
    occurredAt = parsed;
  }

  return {
    ok: true,
    value: {
      eventType: raw.eventType as 'usb_insert' | 'usb_remove',
      deviceName: deviceName.value,
      vendorName: vendorName.value,
      serialNumber: serialNumber.value,
      vid: vid.value,
      pid: pid.value,
      manufacturer: manufacturer.value,
      deviceClass: deviceClass.value,
      driveLetter: driveLetter.value,
      filePath: filePath.value,
      occurredAt,
    },
  };
}

// ─── Policy violation (POST /api/agent/policy-violations) ───────────────────

export interface PolicyViolationInput {
  policyId: string;
  executableName: string;
  processPath: string | null;
  action: 'blocked';
  severity: 'low' | 'medium' | 'high' | 'critical';
  metadata: Record<string, unknown>;
  occurredAt: Date | null;
}

export function validatePolicyViolationInput(raw: Record<string, unknown>): ValidationResult<PolicyViolationInput> {
  if (typeof raw.policyId !== 'string' || raw.policyId.length === 0 || raw.policyId.length > 64) {
    return fail('policyId is required');
  }
  if (typeof raw.executableName !== 'string' || raw.executableName.trim().length === 0) {
    return fail('executableName is required');
  }
  if (raw.executableName.trim().length > MAX_VIOLATION_EXECUTABLE_LENGTH) {
    return fail(`executableName must be at most ${MAX_VIOLATION_EXECUTABLE_LENGTH} characters`);
  }
  if (raw.action !== 'blocked') {
    return fail('action must be "blocked"');
  }
  if (!isValidViolationSeverity(raw.severity)) {
    return fail('severity must be one of: low, medium, high, critical');
  }
  const path = optionalString(raw.processPath, 'processPath', MAX_PROCESS_PATH_LENGTH);
  if (!path.ok) return path;

  let metadata: Record<string, unknown> = {};
  if (raw.metadata !== undefined && raw.metadata !== null) {
    if (typeof raw.metadata !== 'object' || Array.isArray(raw.metadata)) {
      return fail('metadata must be an object');
    }
    try {
      const encoded = JSON.stringify(raw.metadata);
      if (Buffer.byteLength(encoded, 'utf8') > MAX_VIOLATION_METADATA_BYTES) {
        return fail(`metadata must be at most ${MAX_VIOLATION_METADATA_BYTES} bytes`);
      }
      metadata = raw.metadata as Record<string, unknown>;
    } catch {
      return fail('metadata is not serializable');
    }
  }

  let occurredAt: Date | null = null;
  if (raw.occurredAt !== undefined && raw.occurredAt !== null) {
    if (typeof raw.occurredAt !== 'string') return fail('occurredAt must be an ISO string');
    const parsed = new Date(raw.occurredAt);
    if (Number.isNaN(parsed.getTime())) return fail('occurredAt is not a valid date');
    if (parsed.getTime() > Date.now() + 5 * 60 * 1000) {
      return fail('occurredAt is in the future');
    }
    occurredAt = parsed;
  }

  return {
    ok: true,
    value: {
      policyId: raw.policyId,
      executableName: raw.executableName.trim(),
      processPath: path.value,
      action: 'blocked',
      severity: raw.severity as PolicyViolationInput['severity'],
      metadata,
      occurredAt,
    },
  };
}

/**
 * Deterministic dedupe key for a USB event: org + device + serial + type +
 * 5-minute time bucket. NULL identity (no serial) yields null → no unique
 * constraint applies (dedupe is best-effort for anonymous devices).
 */
export function usbDedupeKey(input: {
  organizationId: string;
  deviceId: string | null;
  serialNumber: string | null;
  eventType: string;
  occurredAt: Date;
  windowMs?: number;
}): string | null {
  if (!input.serialNumber) return null;
  const windowMs = input.windowMs ?? 5 * 60 * 1000;
  const bucket = Math.floor(input.occurredAt.getTime() / windowMs);
  return [
    'usb',
    input.organizationId,
    input.deviceId ?? '?',
    input.serialNumber.trim().toLowerCase(),
    input.eventType,
    String(bucket),
  ].join(':');
}

/** Deterministic dedupe key for a policy violation (5-minute bucket). */
export function violationDedupeKey(input: {
  organizationId: string;
  deviceId: string | null;
  policyId: string;
  executableName: string;
  occurredAt: Date;
  windowMs?: number;
}): string {
  const windowMs = input.windowMs ?? 5 * 60 * 1000;
  const bucket = Math.floor(input.occurredAt.getTime() / windowMs);
  return [
    'pv',
    input.organizationId,
    input.deviceId ?? '?',
    input.policyId,
    input.executableName.trim().toLowerCase(),
    String(bucket),
  ].join(':');
}
