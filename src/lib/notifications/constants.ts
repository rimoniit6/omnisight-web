// OmniSight — canonical Notification + Alert domain definitions.
//
// Single source of truth for notification types/priorities/statuses and alert
// severities/statuses. Every API boundary and producer validates against these
// sets — arbitrary strings from clients or agents are never persisted.
//
// Type registry: `active` reflects whether the repository has a REAL producer
// today. Types without a producer are advertised as planned so the UI never
// claims functionality that does not exist (F-11 / N-6).

export const NOTIFICATION_TYPES = [
  'security',
  'anomaly_detected',
  'policy_violation',
  'device_offline',
  'new_employee',
  'high_inactivity',
  'license_expiration',
  'ai_recommendation',
  'consent_update',
  'project_deadline',
  'overtime_alert',
  // Preserved legacy type: already produced/consumed in the repository
  // (e.g. live-monitor event stats seed 'system' notifications).
  'system',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const NOTIFICATION_STATUSES = ['unread', 'read', 'archived'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ['pending', 'acknowledged', 'resolved', 'archived'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** Notification types with a REAL producer wired in this repository. */
export const ACTIVE_NOTIFICATION_TYPES: readonly NotificationType[] = [
  'security',
  'anomaly_detected',
  'policy_violation',
  'new_employee',
];

export interface NotificationTypeMeta {
  value: NotificationType;
  label: string;
  icon: string;
  color: string;
  /** true = a real producer exists; false = planned, not currently produced. */
  active: boolean;
}

export const NOTIFICATION_TYPE_REGISTRY: NotificationTypeMeta[] = [
  { value: 'device_offline', label: 'Device Offline', icon: 'Monitor', color: 'rose', active: false },
  { value: 'new_employee', label: 'New Employee', icon: 'UserPlus', color: 'emerald', active: true },
  { value: 'policy_violation', label: 'Policy Violation', icon: 'Shield', color: 'amber', active: true },
  { value: 'high_inactivity', label: 'High Inactivity', icon: 'Clock', color: 'slate', active: false },
  { value: 'license_expiration', label: 'License Expiration', icon: 'AlertTriangle', color: 'rose', active: false },
  { value: 'ai_recommendation', label: 'AI Recommendation', icon: 'Sparkles', color: 'teal', active: false },
  { value: 'security', label: 'Security Alert', icon: 'Shield', color: 'rose', active: true },
  { value: 'system', label: 'System', icon: 'Cpu', color: 'cyan', active: false },
  { value: 'anomaly_detected', label: 'Anomaly Detected', icon: 'Brain', color: 'violet', active: true },
  { value: 'consent_update', label: 'Consent Update', icon: 'FileCheck', color: 'blue', active: false },
  { value: 'project_deadline', label: 'Project Deadline', icon: 'FolderKanban', color: 'orange', active: false },
  { value: 'overtime_alert', label: 'Overtime Alert', icon: 'Clock', color: 'amber', active: false },
];

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export function isNotificationPriority(value: unknown): value is NotificationPriority {
  return typeof value === 'string' && (NOTIFICATION_PRIORITIES as readonly string[]).includes(value);
}

export function isNotificationStatus(value: unknown): value is NotificationStatus {
  return typeof value === 'string' && (NOTIFICATION_STATUSES as readonly string[]).includes(value);
}

export function isAlertSeverity(value: unknown): value is AlertSeverity {
  return typeof value === 'string' && (ALERT_SEVERITIES as readonly string[]).includes(value);
}

export function isAlertStatus(value: unknown): value is AlertStatus {
  return typeof value === 'string' && (ALERT_STATUSES as readonly string[]).includes(value);
}

/**
 * Priority derived from an anomaly/alert severity (used by producers so the
 * notification priority and the alert severity can never disagree).
 */
export function priorityFromSeverity(severity: string): NotificationPriority {
  if (severity === 'critical') return 'critical';
  if (severity === 'high' || severity === 'error') return 'high';
  if (severity === 'warning') return 'medium';
  return 'low';
}
