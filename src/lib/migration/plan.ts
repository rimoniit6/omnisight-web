// OmniSight — Organization-scoped data-migration table plan.
//
// Classifies org-owned analytics tables for the APPROVED infrastructure data
// migration (Super Admin approval → real data copy → verify → activate).
//
// Rules:
//   • Organization-owned: copied (WHERE organizationId = approved org).
//   • Shared/platform tables (Organization, AppUser, subscriptions, plans,
//     licenses, invoices, settings, sessions, jobs, rate limits, infrastructure
//     requests/migrations themselves) are NEVER copied — the platform database
//     stays authoritative for identity/control plane.
//   • Derived analytics (WorkDaySummary) are copied too: they are org-owned
//     history. Rebuildable, but copying keeps the destination self-consistent
//     immediately after activation.
//
// COVERAGE RULE: every Prisma model carrying an `organizationId` whose data is
// served to the organization at runtime must appear here. Platform/control-
// plane org-SCOPED models are deliberately EXCLUDED (they stay authoritative
// in the platform database — the destination gets the identity anchor only):
//   AppUser, OrganizationMembership, UserSession (auth/identity), AgentToken,
//   AgentSession (agent credentials — secrets stay platform-side),
//   LicenseKey, Subscription, Invoice (SaaS billing), OrganizationSetting (key-
//   value control plane), InfrastructureChangeRequest/InfrastructureMigration
//   (the migration record itself), OrganizationSettings (activation state).
//
// The order below is FK-safe for copy: each table's employeeId/deviceId/
// projectId/departmentId/consentId/policyId references appear EARLIER in the
// list (or are nullable with SetNull semantics — copied as NULL only when the
// referenced row itself belongs to the org; cross-org references cannot exist
// because every FK below is org-internal by construction).
//
// SECURITY: every copy/verify query is built with an explicit organizationId
// equality (asserted in db-migrate.ts before execution) — no bare-id or
// whole-table operations ever happen.

export interface MigrationTable {
  /** Prisma delegate name on the source/destination clients. */
  model: string;
  /** Physical table name (information_schema / raw SQL). */
  table: string;
  /** Fields selected/copied — the full row (id included) for fidelity. */
  /** nullable FK columns that may reference rows OUTSIDE the org (SetNull semantics). */
  nullableFks: string[];
}

/**
 * FK-safe copy order. `nullableFks` lists FK columns whose referenced row can
 * live outside the organization (they are nulled in the copy when the target
 * row is not part of this org's copy set — mirroring the production SetNull
 * behavior). All other FK targets are org-internal and copied earlier.
 */
export const MIGRATION_TABLES: MigrationTable[] = [
  // Org-data tables with no intra-org FKs (copy first).
  { model: 'consentPolicy', table: 'ConsentPolicy', nullableFks: [] },
  { model: 'categoryRule', table: 'CategoryRule', nullableFks: [] },
  { model: 'notificationPreference', table: 'NotificationPreference', nullableFks: [] },
  { model: 'aiUsage', table: 'AiUsage', nullableFks: [] },
  // AuditLog.organizationId is nullable (platform-level rows have NULL) —
  // org rows are copied; the cross-tenant probe ignores NULLs by design.
  { model: 'auditLog', table: 'AuditLog', nullableFks: [] },
  { model: 'organizationBranding', table: 'OrganizationBranding', nullableFks: [] },
  { model: 'department', table: 'Department', nullableFks: ['managerId'] },
  { model: 'project', table: 'Project', nullableFks: ['departmentId'] },
  { model: 'employee', table: 'Employee', nullableFks: ['departmentId', 'activeTrackingProjectId'] },
  { model: 'device', table: 'Device', nullableFks: ['employeeId'] },
  { model: 'deviceClaim', table: 'DeviceClaim', nullableFks: ['employeeId'] },
  { model: 'agentCommand', table: 'AgentCommand', nullableFks: [] },
  { model: 'projectMember', table: 'ProjectMember', nullableFks: [] },
  { model: 'timeEntry', table: 'TimeEntry', nullableFks: [] },
  { model: 'activity', table: 'Activity', nullableFks: ['deviceId'] },
  { model: 'activityBatchReceipt', table: 'ActivityBatchReceipt', nullableFks: [] },
  { model: 'keyboardActivity', table: 'KeyboardActivity', nullableFks: ['deviceId'] },
  { model: 'locationEvent', table: 'LocationEvent', nullableFks: ['deviceId'] },
  { model: 'screenshot', table: 'Screenshot', nullableFks: ['deviceId'] },
  { model: 'workDaySummary', table: 'WorkDaySummary', nullableFks: [] },
  { model: 'breakSession', table: 'BreakSession', nullableFks: ['deviceId'] },
  { model: 'webcamSession', table: 'WebcamSession', nullableFks: [] },
  { model: 'audioRecording', table: 'AudioRecording', nullableFks: ['employeeId', 'deviceId'] },
  { model: 'audioTranscription', table: 'AudioTranscription', nullableFks: [] },
  { model: 'usbEvent', table: 'UsbEvent', nullableFks: ['employeeId', 'deviceId'] },
  { model: 'appListEntry', table: 'AppListEntry', nullableFks: [] },
  { model: 'policyViolation', table: 'PolicyViolation', nullableFks: ['employeeId', 'deviceId'] },
  { model: 'consent', table: 'Consent', nullableFks: ['policyId'] },
  { model: 'consentLog', table: 'ConsentLog', nullableFks: [] },
  { model: 'alert', table: 'Alert', nullableFks: [] },
  { model: 'alertRule', table: 'AlertRule', nullableFks: [] },
  { model: 'alertRuleFiring', table: 'AlertRuleFiring', nullableFks: ['alertId'] },
  { model: 'anomaly', table: 'Anomaly', nullableFks: ['employeeId', 'deviceId'] },
  { model: 'sentimentRecord', table: 'SentimentRecord', nullableFks: ['projectId'] },
  { model: 'notification', table: 'Notification', nullableFks: [] },
  { model: 'report', table: 'Report', nullableFks: [] },
  { model: 'aiInsight', table: 'AiInsight', nullableFks: [] },
  { model: 'projectTimeSync', table: 'ProjectTimeSync', nullableFks: [] },
];

/** Table progress snapshot shape persisted on InfrastructureMigration.tableProgress. */
export type TableProgressMap = Record<string, { done: number; total: number }>;
