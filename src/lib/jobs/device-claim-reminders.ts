// OmniSight — device-claim approval reminders (hardening area 4).
//
// A pending device claim that has been waiting past
// DEVICE_CLAIM_REMINDER_AFTER_MS is re-surfaced to the org admins so an
// approval is never silently stuck in a queue. Runs on the hourly cadence:
//
//   - finds ONLY pending claims that passed the "awaiting approval" threshold
//   - enforces a per-claim cooldown (DEVICE_CLAIM_REMINDER_COOLDOWN_MS) via
//     DeviceClaim.reminderSentAt so the org is not pinged every hour
//   - creates ONE org-scoped `device_approval_reminder` notification per
//     eligible claim (validated through the canonical notification service —
//     org preference honored, bounded payload)
//   - marks reminderSentAt inside the same transaction as the notification,
//     so a crash can never re-notify an in-flight claim
//   - per-claim failures are isolated: one broken row never blocks the rest
//
// Lease-guarded (`device_claim_reminders`, same JobRun crash-safe pattern);
// an overlapping run is impossible.

import { db } from '@/lib/db';
import { log } from '@/lib/logger';
import { createOrgNotification } from '@/lib/notifications/service';
import {
  DEVICE_CLAIM_REMINDER_AFTER_MS,
  DEVICE_CLAIM_REMINDER_COOLDOWN_MS,
} from '@/config/constants';

export interface DeviceClaimReminderJobResult {
  pendingScanned: number;
  remindersSent: number;
  skippedCooldown: number;
  errors: string[];
}

export async function runDeviceClaimRemindersJob(): Promise<DeviceClaimReminderJobResult> {
  const result: DeviceClaimReminderJobResult = { pendingScanned: 0, remindersSent: 0, skippedCooldown: 0, errors: [] };
  const now = Date.now();
  const awaitingSince = new Date(now - DEVICE_CLAIM_REMINDER_AFTER_MS);
  const cooldownCutoff = new Date(now - DEVICE_CLAIM_REMINDER_COOLDOWN_MS);

  const claims = await db.deviceClaim.findMany({
    where: {
      status: 'pending',
      createdAt: { lte: awaitingSince },
    },
    select: {
      id: true,
      deviceId: true,
      organizationId: true,
      employeeId: true,
      device: { select: { name: true } },
      reminderSentAt: true,
    },
  });
  result.pendingScanned = claims.length;

  for (const claim of claims) {
    // Cooldown: skip claims we reminded recently (or never-reached threshold).
    if (claim.reminderSentAt && new Date(claim.reminderSentAt).getTime() > cooldownCutoff.getTime()) {
      result.skippedCooldown += 1;
      continue;
    }
    try {
      const deviceLabel = claim.device?.name ?? claim.deviceId;
      const created = await db.$transaction(async (tx) => {
        const notif = await createOrgNotification(tx, {
          title: 'Device Approval Reminder',
          message: `A device ("${deviceLabel}") has been waiting for approval for over 2 hours. Review the claim to keep tracking active.`,
          type: 'device_approval_reminder',
          priority: 'medium',
          status: 'unread',
          actionUrl: '/agent-approvals',
          entityType: 'device',
          entityId: claim.deviceId,
          employeeId: claim.employeeId ?? undefined,
          deviceId: claim.deviceId,
          organizationId: claim.organizationId,
        });
        // Mark reminded in the SAME transaction as the notification — a crash
        // between the two would otherwise re-notify on the next run.
        await tx.deviceClaim.update({ where: { id: claim.id }, data: { reminderSentAt: new Date(now) } });
        return notif !== null;
      });
      if (created) result.remindersSent += 1;
    } catch (error) {
      result.errors.push(`claim ${claim.id}: ${String(error)}`);
      log.error('jobs.device_claim_reminders.claim_failed', { claimId: claim.id, error: String((error as Error)?.message ?? error) });
    }
  }

  return result;
}