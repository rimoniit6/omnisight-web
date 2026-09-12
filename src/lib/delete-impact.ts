import { db } from '@/lib/db';
import type { PrismaClient } from '@prisma/client';

// ─── Dependency-Aware Delete Impact Engine ───────────────────────────────────
// Single source of truth for "what will this delete touch?".
//
// Every delete route in the app consults these BEFORE mutating so the API can:
//   - block deletions that would silently destroy important historical data
//     (e.g. a Device whose activities/screenshots would cascade away), or
//   - perform a SAFE soft transition (archive / cancel / retire / deactivate)
//     that preserves history, matching the project's established pattern for
//     employees, projects and users.
//
// The engine is read-only — it never mutates the database. Routes use the
// disposition to decide, then enforce server-side within their transaction.

export type DeleteEntity =
  | 'organization'
  | 'device'
  | 'employee'
  | 'project'
  | 'department'
  | 'membership';

export type DeleteDisposition = 'direct' | 'soft' | 'cascade' | 'blocked';

export interface ImpactRow {
  /** Machine-readable model name (matches the Prisma delegate). */
  model: string;
  /** Human-friendly label for preview UI / audit descriptions. */
  label: string;
  /** Count of rows that would be removed or transitioned. */
  count: number;
}

export interface DeleteImpact {
  entity: DeleteEntity;
  entityId: string;
  /** Org the entity belongs to (undefined only for global entities). */
  organizationId?: string;
  disposition: DeleteDisposition;
  /** When disposition === 'blocked', why. */
  blockReason?: string;
  /** When disposition === 'soft', which transition (preserves data). */
  softAction?: 'archive' | 'cancel' | 'retire' | 'deactivate';
  /** Rows that will be removed/transitioned, grouped by model. */
  rows: ImpactRow[];
  totalImpacted: number;
  /**
   * Rows intentionally PRESERVED by the operation (survive the delete).
   * Informational only — included so UIs can answer "what stays?"
   */
  preserved?: ImpactRow[];
  /** Hard removals (direct/cascade) require an explicit confirmation token. */
  confirmRequired: boolean;
}

const countWhere = (client: PrismaClient, model: string, where: Record<string, unknown>): Promise<number> =>
  (client as unknown as Record<string, { count: (args: { where: Record<string, unknown> }) => Promise<number> }>)[model].count({ where });

// ─── Organization (super-admin only; cascade with mandatory confirmation) ────

const ORGANIZATION_ROWS: { model: string; label: string }[] = [
  { model: 'employee', label: 'Employees' },
  { model: 'device', label: 'Devices' },
  { model: 'deviceClaim', label: 'Device claims' },
  { model: 'screenshot', label: 'Screenshots (DB rows)' },
  { model: 'activity', label: 'Activity records' },
  { model: 'activityBatchReceipt', label: 'Activity batch receipts' },
  { model: 'anomaly', label: 'Anomalies' },
  { model: 'consent', label: 'Consents' },
  { model: 'consentPolicy', label: 'Consent policies' },
  { model: 'consentLog', label: 'Consent logs' },
  { model: 'project', label: 'Projects' },
  { model: 'projectMember', label: 'Project memberships' },
  { model: 'timeEntry', label: 'Time entries' },
  { model: 'projectTimeSync', label: 'Project time sync buckets' },
  { model: 'sentimentRecord', label: 'Sentiment records' },
  { model: 'keyboardActivity', label: 'Keyboard events' },
  { model: 'locationEvent', label: 'Location events' },
  { model: 'agentCommand', label: 'Agent commands' },
  { model: 'webcamSession', label: 'Webcam sessions' },
  { model: 'breakSession', label: 'Break sessions' },
  { model: 'audioRecording', label: 'Audio recordings' },
  { model: 'audioTranscription', label: 'Audio transcriptions' },
  { model: 'appListEntry', label: 'App list entries' },
  { model: 'usbEvent', label: 'USB events' },
  { model: 'policyViolation', label: 'Policy violations' },
  { model: 'categoryRule', label: 'Category rules' },
  { model: 'alertRule', label: 'Alert rules' },
  { model: 'alertRuleFiring', label: 'Alert rule firings' },
  { model: 'workDaySummary', label: 'Work-day summaries' },
  { model: 'notification', label: 'Notifications' },
  { model: 'notificationPreference', label: 'Notification preferences' },
  { model: 'alert', label: 'Alerts' },
  { model: 'report', label: 'Reports' },
  { model: 'aiInsight', label: 'AI insights' },
  { model: 'aiUsage', label: 'AI usage' },
  { model: 'organizationMembership', label: 'Organization memberships' },
  { model: 'userSession', label: 'User sessions' },
  { model: 'agentToken', label: 'Agent tokens' },
  { model: 'organizationSetting', label: 'Org settings (legacy)' },
  { model: 'organizationSettings', label: 'Org settings' },
  { model: 'organizationBranding', label: 'Org branding' },
  { model: 'subscription', label: 'Subscriptions' },
  { model: 'invoice', label: 'Invoices' },
];

const ORGANIZATION_CONTROL_PLANE_ROWS = new Set([
  'organizationMembership',
  'userSession',
  'agentToken',
  'organizationSetting',
  'organizationSettings',
  'subscription',
  'invoice',
]);

export async function getOrganizationDeleteImpact(organizationId: string, data: PrismaClient = db): Promise<DeleteImpact> {
  const rows: ImpactRow[] = [];
  for (const def of ORGANIZATION_ROWS) {
    const client = ORGANIZATION_CONTROL_PLANE_ROWS.has(def.model) ? db : data;
    const count = await countWhere(client, def.model, { organizationId });
    if (count > 0) rows.push({ model: def.model, label: def.label, count });
  }
  const totalImpacted = rows.reduce((sum, r) => sum + r.count, 0);

  // AppUsers and audit logs are intentionally preserved: user accounts are
  // de-pinned from the org (memberships cascade) and audit history survives
  // via SetNull for compliance.
  const preserved: ImpactRow[] = [];
  const appUserCount = await db.organizationMembership.count({ where: { organizationId } });
  const auditCount = await data.auditLog.count({ where: { organizationId } });
  if (appUserCount > 0) preserved.push({ model: 'appUser', label: 'User accounts (kept, membership removed)', count: appUserCount });
  if (auditCount > 0) preserved.push({ model: 'auditLog', label: 'Audit log entries (kept for compliance)', count: auditCount });

  return {
    entity: 'organization',
    entityId: organizationId,
    organizationId,
    disposition: 'cascade',
    rows,
    totalImpacted,
    preserved,
    confirmRequired: true,
  };
}

// ─── Device ───────────────────────────────────────────────────────────────────
// A Device hard-delete cascades its entire monitoring history (activities,
// screenshots, locations, webcams, breaks, audio, USB, policy violations).
// That is the project's single most dangerous silent cascade, so a device with
// history is NEVER hard-deleted by the API: it is retired (status 'retired'),
// preserving every record. An empty device can still be hard-deleted.

const DEVICE_DEPENDENT_ROWS: { model: string; label: string }[] = [
  { model: 'activity', label: 'Activity records' },
  { model: 'screenshot', label: 'Screenshots (DB rows)' },
  { model: 'anomaly', label: 'Anomalies' },
  { model: 'keyboardActivity', label: 'Keyboard events' },
  { model: 'locationEvent', label: 'Location events' },
  { model: 'agentCommand', label: 'Agent commands' },
  { model: 'webcamSession', label: 'Webcam sessions' },
  { model: 'breakSession', label: 'Break sessions' },
  { model: 'audioRecording', label: 'Audio recordings' },
  { model: 'usbEvent', label: 'USB events' },
  { model: 'policyViolation', label: 'Policy violations' },
  { model: 'deviceClaim', label: 'Device claims' },
];

export async function getDeviceDeleteImpact(deviceId: string, organizationId: string, data: PrismaClient = db): Promise<DeleteImpact> {
  const rows: ImpactRow[] = [];
  for (const def of DEVICE_DEPENDENT_ROWS) {
    const count = await countWhere(data, def.model, { deviceId });
    if (count > 0) rows.push({ model: def.model, label: def.label, count });
  }
  const totalImpacted = rows.reduce((sum, r) => sum + r.count, 0);

  return {
    entity: 'device',
    entityId: deviceId,
    organizationId,
    // A device with history is preserved via soft retirement; an empty device
    // can be physically removed (a "direct" safe delete, still confirmed).
    disposition: totalImpacted > 0 ? 'soft' : 'direct',
    softAction: totalImpacted > 0 ? 'retire' : undefined,
    rows,
    totalImpacted,
    confirmRequired: totalImpacted === 0,
  };
}

// ─── Employee (soft archive — informational preview) ──────────────────────────

const EMPLOYEE_DEPENDENT_ROWS: { model: string; label: string }[] = [
  { model: 'device', label: 'Devices (kept, unassigned)' },
  { model: 'activity', label: 'Activity records' },
  { model: 'screenshot', label: 'Screenshots (DB rows)' },
  { model: 'anomaly', label: 'Anomalies' },
  { model: 'projectMember', label: 'Project memberships' },
  { model: 'timeEntry', label: 'Time entries' },
  { model: 'sentimentRecord', label: 'Sentiment records' },
  { model: 'keyboardActivity', label: 'Keyboard events' },
  { model: 'locationEvent', label: 'Location events' },
  { model: 'webcamSession', label: 'Webcam sessions' },
  { model: 'breakSession', label: 'Break sessions' },
  { model: 'audioRecording', label: 'Audio recordings' },
  { model: 'workDaySummary', label: 'Work-day summaries' },
];

export async function getEmployeeDeleteImpact(employeeId: string, organizationId: string, data: PrismaClient = db): Promise<DeleteImpact> {
  const rows: ImpactRow[] = [];
  for (const def of EMPLOYEE_DEPENDENT_ROWS) {
    const count = await countWhere(data, def.model, { employeeId });
    if (count > 0) rows.push({ model: def.model, label: def.label, count });
  }

  const agentAccount = await db.agentAccount.count({ where: { employeeId } });
  const preserved: ImpactRow[] = [];
  if (agentAccount > 0) preserved.push({ model: 'agentAccount', label: 'Agent login (DISABLED on archive, row kept)', count: agentAccount });

  return {
    entity: 'employee',
    entityId: employeeId,
    organizationId,
    disposition: 'soft',
    softAction: 'archive',
    rows,
    totalImpacted: rows.reduce((sum, r) => sum + r.count, 0),
    preserved,
    confirmRequired: false,
  };
}

// ─── Project (soft cancel — informational preview) ────────────────────────────

const PROJECT_DEPENDENT_ROWS: { model: string; label: string }[] = [
  { model: 'projectMember', label: 'Project memberships' },
  { model: 'timeEntry', label: 'Time entries' },
  { model: 'projectTimeSync', label: 'Project time sync buckets' },
  { model: 'sentimentRecord', label: 'Sentiment records' },
];

export async function getProjectDeleteImpact(projectId: string, organizationId: string, data: PrismaClient = db): Promise<DeleteImpact> {
  const rows: ImpactRow[] = [];
  for (const def of PROJECT_DEPENDENT_ROWS) {
    const count = await countWhere(data, def.model, { projectId });
    if (count > 0) rows.push({ model: def.model, label: def.label, count });
  }

  const activeTracking = await data.employee.count({ where: { activeTrackingProjectId: projectId } });
  const preserved: ImpactRow[] = [];
  if (activeTracking > 0) preserved.push({ model: 'employee', label: 'Employees (active-tracking pointer cleared, rows kept)', count: activeTracking });

  return {
    entity: 'project',
    entityId: projectId,
    organizationId,
    disposition: 'soft',
    softAction: 'cancel',
    rows,
    totalImpacted: rows.reduce((sum, r) => sum + r.count, 0),
    preserved,
    confirmRequired: false,
  };
}

// ─── Department (direct — data preserved via SetNull) ─────────────────────────

export async function getDepartmentDeleteImpact(departmentId: string, organizationId: string, data: PrismaClient = db): Promise<DeleteImpact> {
  const [employees, projects] = await Promise.all([
    data.employee.count({ where: { departmentId } }),
    data.project.count({ where: { departmentId } }),
  ]);

  const rows: ImpactRow[] = [];
  if (employees > 0) rows.push({ model: 'employee', label: 'Employees (kept, department unassigned)', count: employees });
  if (projects > 0) rows.push({ model: 'project', label: 'Projects (kept, department unassigned)', count: projects });

  return {
    entity: 'department',
    entityId: departmentId,
    organizationId,
    disposition: 'direct',
    rows,
    totalImpacted: employees + projects,
    confirmRequired: true,
  };
}

// ─── Organization membership (with last-admin guard) ─────────────────────────

const ADMIN_LEVEL_ROLES = ['org_admin', 'owner', 'admin'];

/**
 * Would removing `userId` from `organizationId` leave the organization without
 * any remaining ACTIVE administrator-level user? Returns true when so.
 */
export async function isLastOrgAdministrator(organizationId: string, userId: string): Promise<boolean> {
  const target = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { role: true, status: true },
  });
  if (!target || !ADMIN_LEVEL_ROLES.includes(target.role) || target.status !== 'ACTIVE') return false;

  const remainingAdmins = await db.organizationMembership.count({
    where: {
      organizationId,
      userId: { not: userId },
      role: { in: ADMIN_LEVEL_ROLES },
      status: 'ACTIVE',
    },
  });
  return remainingAdmins === 0 && ADMIN_LEVEL_ROLES.includes(target.role);
}

export async function getMembershipDeleteImpact(
  organizationId: string,
  memberId: string,
  actorIsSuperAdmin: boolean
): Promise<DeleteImpact> {
  const lastAdmin = await isLastOrgAdministrator(organizationId, memberId);
  const blocked = lastAdmin && !actorIsSuperAdmin;

  return {
    entity: 'membership',
    entityId: memberId,
    organizationId,
    disposition: blocked ? 'blocked' : 'direct',
    blockReason: blocked
      ? 'This membership is the last ACTIVE administrator of the organization. Reassign another org_admin before removing it (or have a Super Admin perform the removal).'
      : undefined,
    rows: [],
    totalImpacted: 1,
    confirmRequired: true,
  };
}