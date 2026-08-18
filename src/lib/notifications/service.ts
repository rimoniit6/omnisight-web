// OmniSight — shared Notification + Alert creation service.
//
// Every producer (agent routes, anomaly engine, manual POST) routes its
// notification/alert rows through these helpers so that:
//   - canonical enums + length/URL/metadata bounds are enforced at one place
//   - organization-level NotificationPreference is honored (a type disabled
//     by the org is skipped — producers never bypass the org's choice)
//   - structured employee/device linkage is populated where available
//   - entity deep-link metadata (entityType/entityId/actionUrl) follows one
//     convention
//
// The helpers are transaction-aware (accept a Prisma transaction client) so
// creation stays atomic with the caller's writes.

import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import {
  validateTitle,
  validateMessage,
  validateNotificationType,
  validateNotificationPriority,
  validateActionUrl,
  validateEntityId,
  validateEntityType,
  validateDescription,
  validateAlertSeverity,
  validateAlertStatus,
} from './validation';
import { isNotificationType } from './constants';

type Tx = Prisma.TransactionClient | typeof db;

export interface CreateNotificationInput {
  title: string;
  message: string;
  type: string;
  priority?: string;
  /** unread | read | archived — default unread. */
  status?: string;
  actionUrl?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Structured linkage (never authorization) — populated by producers. */
  employeeId?: string | null;
  deviceId?: string | null;
  organizationId: string;
}

export interface CreateAlertInput {
  title: string;
  description: string;
  type: string;
  severity: string;
  status?: string;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Structured linkage (never authorization) — populated by producers. */
  employeeId?: string | null;
  deviceId?: string | null;
  organizationId: string;
}

export class NotificationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationValidationError';
  }
}

/**
 * Resolve whether the org has enabled a notification type. Preference rows
 * default to enabled when absent (org-wide notifications are the product
 * default; an admin opting out must be explicit). Preference is organization-
 * scoped — never cross-tenant.
 */
export async function isNotificationTypeEnabled(
  orgId: string,
  type: string,
  tx?: Tx
): Promise<boolean> {
  if (!isNotificationType(type)) return false;
  const client: { notificationPreference: { findUnique: (args: { where: { organizationId_notificationType: { organizationId: string; notificationType: string } } }) => Promise<{ enabled: boolean } | null> } } = tx as never;
  const pref = await client.notificationPreference.findUnique({
    where: { organizationId_notificationType: { organizationId: orgId, notificationType: type } },
  });
  return pref ? pref.enabled : true;
}

/**
 * Create an organization-scoped notification inside the caller's transaction.
 * Returns the created row, or null when the org has disabled this type.
 * Throws NotificationValidationError (map to 4xx) on invalid input.
 */
export async function createOrgNotification(
  tx: Tx,
  input: CreateNotificationInput
): Promise<{ id: string } | null> {
  const titleErr = validateTitle(input.title);
  if (titleErr) throw new NotificationValidationError(titleErr);
  const msgErr = validateMessage(input.message);
  if (msgErr) throw new NotificationValidationError(msgErr);
  const typeErr = validateNotificationType(input.type);
  if (typeErr) throw new NotificationValidationError(typeErr);
  const prioErr = validateNotificationPriority(input.priority);
  if (prioErr) throw new NotificationValidationError(prioErr);
  const urlErr = validateActionUrl(input.actionUrl);
  if (urlErr) throw new NotificationValidationError(urlErr);
  const entIdErr = validateEntityId(input.entityId);
  if (entIdErr) throw new NotificationValidationError(entIdErr);
  const entTypeErr = validateEntityType(input.entityType);
  if (entTypeErr) throw new NotificationValidationError(entTypeErr);

  // Organization preference — disabled type is skipped (fail-safe, never
  // bypassed by producers).
  if (!(await isNotificationTypeEnabled(input.organizationId, input.type, tx))) {
    return null;
  }

  const created = await tx.notification.create({
    data: {
      title: input.title.trim(),
      message: input.message.trim(),
      type: input.type,
      priority: input.priority || 'medium',
      status: input.status || 'unread',
      actionUrl: input.actionUrl || null,
      entityType: input.entityType || null,
      entityId: input.entityId || null,
      employeeId: input.employeeId || null,
      deviceId: input.deviceId || null,
      organizationId: input.organizationId,
    },
  });
  return { id: created.id };
}

/**
 * Create an organization-scoped alert inside the caller's transaction.
 * Validates severity/status against the canonical enums (N-7) — a malformed
 * value is a client/agent error, never persisted.
 */
export async function createOrgAlert(
  tx: Tx,
  input: CreateAlertInput
): Promise<{ id: string }> {
  const titleErr = validateTitle(input.title);
  if (titleErr) throw new NotificationValidationError(titleErr);
  const descErr = validateDescription(input.description);
  if (descErr) throw new NotificationValidationError(descErr);
  const sevErr = validateAlertSeverity(input.severity);
  if (sevErr) throw new NotificationValidationError(sevErr);
  const statusErr = validateAlertStatus(input.status);
  if (statusErr) throw new NotificationValidationError(statusErr);

  const created = await tx.alert.create({
    data: {
      title: input.title.trim(),
      description: input.description.trim(),
      type: input.type,
      severity: input.severity,
      status: input.status || 'pending',
      source: input.source || null,
      metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      employeeId: input.employeeId || null,
      deviceId: input.deviceId || null,
      organizationId: input.organizationId,
    },
  });
  return { id: created.id };
}
