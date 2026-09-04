import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { earliestDataAt, DAY_MS } from '@/lib/jobs/data-expiry-reminder';

// GET /api/admin/data-retention — retention-window report for every
// organization with an ACTIVE subscription whose plan defines a retention
// window (retentionDays > 0). For each org it reports the earliest stored data
// anchor, the computed expiry (anchor + retentionDays) and a coarse status so
// super admins can see which orgs are approaching/inside their retention gap.
//
// Shares the exact retention-anchor definition with the reminder job (see
// src/lib/jobs/data-expiry-reminder.ts) so this report and the emails agree.

const DAYS_IN_WINDOW = 7;

export interface DataRetentionRow {
  id: string;
  name: string;
  planName: string;
  retentionDays: number;
  earliestDataAt: string | null;
  expiryAt: string | null;
  daysLeft: number | null;
  status: 'ACTIVE' | 'EXPIRING_SOON' | 'EXPIRED' | 'NO_DATA';
}

export async function GET(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);

    const now = new Date();
    const subscriptions = await db.subscription.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ endDate: null }, { endDate: { gt: now } }],
      },
      select: {
        organization: { select: { id: true, name: true } },
        plan: { select: { name: true, retentionDays: true } },
      },
    });

    const rows: DataRetentionRow[] = [];
    for (const sub of subscriptions) {
      if (!sub.plan || sub.plan.retentionDays <= 0) continue;
      const earliest = await earliestDataAt(sub.organization.id);
      let expiryAt: Date | null = null;
      let daysLeft: number | null = null;
      let status: DataRetentionRow['status'] = 'NO_DATA';

      if (earliest) {
        expiryAt = new Date(earliest.getTime() + sub.plan.retentionDays * DAY_MS);
        daysLeft = Math.floor((expiryAt.getTime() - now.getTime()) / DAY_MS);
        if (daysLeft < 0) status = 'EXPIRED';
        else if (daysLeft <= DAYS_IN_WINDOW) status = 'EXPIRING_SOON';
        else status = 'ACTIVE';
      }

      rows.push({
        id: sub.organization.id,
        name: sub.organization.name,
        planName: sub.plan.name,
        retentionDays: sub.plan.retentionDays,
        earliestDataAt: earliest ? earliest.toISOString() : null,
        expiryAt: expiryAt ? expiryAt.toISOString() : null,
        daysLeft,
        status,
      });
    }

    return NextResponse.json({ data: rows });
  } catch (error) {
    log.error('api.admin.data.retention', { error: String(error) }, requestContext(req));
    return apiError('Failed to load data-retention report', 500);
  }
}
