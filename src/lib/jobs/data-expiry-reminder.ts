// Data-expiry reminder job for manual archival.
//
// Every day the job evaluates each organization's retention window and emails
// the responsible users (org admins + super admins) as the window closes:
//   - 7 days before expiry  → "expiring in 7 days" warning
//   - on the expiry day      → "ACTION REQUIRED: expired today" final notice
//
// The job ONLY reminds — it NEVER deletes or purges data. Deletion remains the
// job of the retention_cleanup processor (which enforces the active plan's
// retention window via resolveRetentionDays).
//
// Dedup: Organization.lastDataExpiryReminderAt records when a reminder was last
// sent so the near-daily pass cannot spam the same org. A warning is sent once
// per cycle; the final notice once (per day).
//
// Licensed as a lease-guarded job ('data_expiry_reminder') from run.ts.

import { db } from '@/lib/db';
import { sendDataExpiryReminder } from '@/lib/email';

export const DAY_MS = 24 * 60 * 60 * 1000;

export interface DataExpiryReminderResult {
  evaluatedOrgs: number;
  remindersSent: number;
  warningsSent: number;
  finalsSent: number;
  errors: string[];
}

interface EligibleOrg {
  id: string;
  name: string;
  retentionDays: number;
  lastDataExpiryReminderAt: Date | null;
}

function appExportLink(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:3000';
  return `${base.replace(/\/$/, '')}/reports`;
}

/**
 * Earliest data timestamp for an organization across the org-scoped telemetry
 * tables. Returns null when the org currently has no rows anywhere (nothing to
 * expire yet). Uses the row createdAt as the retention anchor.
 *
 * Shared by the reminder job and the super-admin data-retention report so both
 * compute the same retention window.
 */
export async function earliestDataAt(orgId: string): Promise<Date | null> {
  const [screenshot, location, audio, aiInsight, sentiment, activity] = await Promise.all([
    db.screenshot.aggregate({ where: { organizationId: orgId }, _min: { createdAt: true } }),
    db.locationEvent.aggregate({ where: { organizationId: orgId }, _min: { createdAt: true } }),
    db.audioRecording.aggregate({ where: { organizationId: orgId }, _min: { createdAt: true } }),
    db.aiInsight.aggregate({ where: { organizationId: orgId }, _min: { createdAt: true } }),
    db.sentimentRecord.aggregate({ where: { organizationId: orgId }, _min: { createdAt: true } }),
    // Activity is scoped through Employee (no direct organizationId column).
    db.activity.aggregate({
      where: { employee: { organizationId: orgId } },
      _min: { createdAt: true },
    }),
  ]);

  const candidates = [
    screenshot._min.createdAt,
    location._min.createdAt,
    audio._min.createdAt,
    aiInsight._min.createdAt,
    sentiment._min.createdAt,
    activity._min.createdAt,
  ].filter((d): d is Date => d instanceof Date);

  if (candidates.length === 0) return null;
  // Earliest = minimum timestamp.
  return candidates.reduce((a, b) => (b < a ? b : a));
}

/**
 * Resolve the orgs that are subject to a data-expiry reminder this cycle:
 * those with an ACTIVE subscription whose plan defines a retention window
 * (retentionDays > 0). A Free-plan org (no subscription) uses its plan
 * retentionDays when it has one; otherwise it is skipped (no defined window).
 */
async function loadEligibleOrgs(now: Date): Promise<EligibleOrg[]> {
  const subscriptions = await db.subscription.findMany({
    where: {
      status: 'ACTIVE',
      OR: [{ endDate: null }, { endDate: { gt: now } }],
    },
    select: { organizationId: true, plan: { select: { retentionDays: true, features: true } } },
  });

  const orgIds = [...new Set(subscriptions.map((s) => s.organizationId))];
  if (orgIds.length === 0) return [];

  const orgs = await db.organization.findMany({
    where: { id: { in: orgIds } },
    select: { id: true, name: true, lastDataExpiryReminderAt: true },
  });
  const orgMap = new Map(orgs.map((o) => [o.id, o]));

  const eligible: EligibleOrg[] = [];
  for (const sub of subscriptions) {
    const org = orgMap.get(sub.organizationId);
    if (!org) continue;
    // Only orgs whose plan defines a positive retention window get reminders.
    if (!sub.plan || sub.plan.retentionDays <= 0) continue;
    eligible.push({
      id: org.id,
      name: org.name,
      retentionDays: sub.plan.retentionDays,
      lastDataExpiryReminderAt: org.lastDataExpiryReminderAt,
    });
  }
  return eligible;
}

/** All org admins (org_admin + legacy owner/admin memberships) + super admins. */
async function loadRecipients(orgId: string): Promise<string[]> {
  const [memberships, superAdmins] = await Promise.all([
    db.organizationMembership.findMany({
      where: {
        organizationId: orgId,
        status: 'ACTIVE',
        role: { in: ['org_admin', 'owner', 'admin'] },
      },
      select: { user: { select: { email: true } } },
    }),
    db.appUser.findMany({
      where: { role: 'super_admin', isActive: true },
      select: { email: true },
    }),
  ]);

  return [
    ...memberships.map((m) => m.user.email),
    ...superAdmins.map((u) => u.email),
  ];
}

/**
 * Run the daily data-expiry reminder pass.
 * @param now injection point for tests / scheduler runs.
 */
export async function runDataExpiryReminder(now = new Date()): Promise<DataExpiryReminderResult> {
  const result: DataExpiryReminderResult = { evaluatedOrgs: 0, remindersSent: 0, warningsSent: 0, finalsSent: 0, errors: [] };

  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const eligible = await loadEligibleOrgs(now);
  result.evaluatedOrgs = eligible.length;

  for (const org of eligible) {
    try {
      const earliest = await earliestDataAt(org.id);
      if (!earliest) continue; // nothing to expire yet

      const expiryDate = new Date(earliest.getTime() + org.retentionDays * DAY_MS);
      const daysUntil = Math.floor((expiryDate.getTime() - startOfDay.getTime()) / DAY_MS);

      // Already past (or exactly this cycle consumed). Stop once expired.
      if (daysUntil < 0) continue;

      const lastReminded = org.lastDataExpiryReminderAt;
      let sendDays: number | null = null;

      if (daysUntil === 0) {
        // Final notice — once on the expiry day (never twice in a day).
        const remindedToday = lastReminded !== null && lastReminded >= startOfDay;
        if (!remindedToday) sendDays = 0;
      } else if (daysUntil <= 7) {
        // 7-day warning — once per cycle. Only send when never reminded in this
        // cycle yet (a prior final from an old cycle is impossible here since
        // the window re-anchors to a fresh earliest date after purge).
        if (lastReminded === null) sendDays = daysUntil;
      }

      if (sendDays === null) continue;

      const recipients = await loadRecipients(org.id);
      await sendDataExpiryReminder(recipients, org.name, sendDays!, appExportLink());

      await db.organization.update({
        where: { id: org.id },
        data: { lastDataExpiryReminderAt: now },
      });

      result.remindersSent += 1;
      if (sendDays === 0) result.finalsSent += 1;
      else result.warningsSent += 1;
    } catch (error) {
      result.errors.push(`${org.name} (${org.id}): ${String(error)}`);
    }
  }

  return result;
}
