// OmniSight — Sentiment alerting job (Sentiment module, audit fix T3).
//
// The sentiment analyzer computes mood/riskFactors but nothing acted on them:
// a "critical" employee sat in the DB until a manager happened to open the
// page. This job closes that loop: for each org, find the LATEST
// employee-level sentiment record per employee within the lookback window,
// and when it is negative/critical, create an org notification — guarded by
// a per-employee cooldown so a persistently negative score cannot spam the
// inbox (one notification per employee per 7 days).
//
// Design notes:
//  - Runs under the shared JobRun lease (`sentiment_alerts`) like every other
//    scheduler job, so overlapping scheduler ticks / multiple processes are a
//    safe no-op.
//  - ORG DATA BOUNDARY: SentimentRecord is org-owned — every sentiment query
//    routes through getPrismaForOrg(orgId) (activated orgs have their own DB).
//    Notification is a control-plane table and stays on the platform db.
//  - Cooldown state = the employee's most recent 'low_sentiment' notification
//    row (Notification.employeeId + type are indexed). One indexed query per
//    candidate is bounded by the number of negative/critical employees and
//    avoids introducing a new state table.
//  - Cooldown check + notification creation happen in ONE transaction so a
//    concurrent pass can never double-send (N-7 pattern, mirrors alert-rules).
//  - Fail-open per org: one broken org is reported in result.errors; the
//    remaining orgs are still processed.

import type { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { getPrismaForOrg } from '@/lib/org-db';
import { claimJob, finishJob } from './lease';
import { createOrgNotification } from '@/lib/notifications/service';
import { log } from '@/lib/logger';

/** Moods that trigger an alert. 'no-data' is intentionally excluded. */
const ALERT_MOODS = ['negative', 'critical'] as const;

/** Minimum days between two notifications for the SAME employee. */
export const SENTIMENT_ALERT_COOLDOWN_DAYS = 7;

/**
 * How far back a "latest" sentiment record is considered current. Records
 * older than this are stale (the employee may have left, or analysis simply
 * has not run) and must not page anyone.
 */
export const SENTIMENT_ALERT_LOOKBACK_DAYS = 14;

/** Notification `type` — registered in src/lib/notifications/constants.ts. */
export const SENTIMENT_ALERT_TYPE = 'low_sentiment';

export interface SentimentAlertsResult {
  evaluatedOrgs: number;
  /** Employees whose latest in-window mood is negative/critical. */
  candidates: number;
  notificationsSent: number;
  suppressedByCooldown: number;
  errors: string[];
}

function emptyResult(): SentimentAlertsResult {
  return { evaluatedOrgs: 0, candidates: 0, notificationsSent: 0, suppressedByCooldown: 0, errors: [] };
}

interface NegativeCandidate {
  employeeId: string;
  score: number | null;
  mood: string;
  riskFactors: string | null;
}

/**
 * Latest employee-level sentiment record per employee within the lookback
 * window, restricted to alert-worthy moods. SQL-level DISTINCT ON keeps this
 * O(rows-in-window) — no full-history in-memory pass (audit fix T4 applies to
 * the job too). Table/column names are static (no user input interpolated).
 */
async function loadNegativeCandidates(
  orgData: PrismaClient,
  orgId: string,
  lookbackStart: Date
): Promise<NegativeCandidate[]> {
  return orgData.$queryRaw<NegativeCandidate[]>`
    SELECT DISTINCT ON (sr."employeeId")
           sr."employeeId", sr."score", sr."mood", sr."riskFactors"
    FROM "SentimentRecord" sr
    JOIN "Employee" e ON e.id = sr."employeeId"
    WHERE e."organizationId" = ${orgId}
      AND sr."projectId" IS NULL
      AND sr."createdAt" >= ${lookbackStart}
      AND sr."mood" IN (${ALERT_MOODS[0]}, ${ALERT_MOODS[1]})
    ORDER BY sr."employeeId", sr."createdAt" DESC
  `;
}

/** Cooldown check + notification creation in ONE transaction. */
async function notifyWithCooldown(
  orgId: string,
  employee: { id: string; name: string; mood: string; score: number | null; riskFactors: string[] },
  now: Date
): Promise<'created' | 'cooldown'> {
  return db.$transaction(async (tx) => {
    const last = await tx.notification.findFirst({
      where: { organizationId: orgId, employeeId: employee.id, type: SENTIMENT_ALERT_TYPE },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last) {
      const cooldownMs = SENTIMENT_ALERT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
      if (now.getTime() - last.createdAt.getTime() < cooldownMs) return 'cooldown';
    }

    const sevWord = employee.mood === 'critical' ? 'Critical' : 'Negative';
    const scoreText = employee.score !== null ? ` (score ${Math.round(employee.score)}/100)` : '';
    const risks =
      employee.riskFactors.length > 0 ? ` Risk factors: ${employee.riskFactors.join(', ')}.` : '';
    await createOrgNotification(tx, {
      title: `${sevWord} sentiment detected: ${employee.name}`,
      message: `The latest sentiment analysis for ${employee.name} is ${employee.mood}${scoreText}.${risks} Review the employee's sentiment details and schedule a check-in.`,
      type: SENTIMENT_ALERT_TYPE,
      priority: employee.mood === 'critical' ? 'critical' : 'high',
      status: 'unread',
      // actionUrl must be an approved SPA route (validation.ts allowlist);
      // the employee entityType + entityId is what deep-links to the
      // employee's detail page on notification click.
      actionUrl: '/employees',
      entityType: 'employee',
      entityId: employee.id,
      employeeId: employee.id,
      organizationId: orgId,
    });
    return 'created';
  });
}

/**
 * Run the sentiment-alert pass for ONE org. Exported for tests.
 */
export async function runSentimentAlertsForOrg(orgId: string, now = new Date()): Promise<SentimentAlertsResult> {
  const result = emptyResult();
  const { client: orgData } = await getPrismaForOrg(orgId);

  const lookbackStart = new Date(now.getTime() - SENTIMENT_ALERT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const candidates = await loadNegativeCandidates(orgData, orgId, lookbackStart);
  result.evaluatedOrgs = 1;
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  // Resolve display names once (single query, never per-candidate).
  const employeeIds = candidates.map((c) => c.employeeId);
  const employees = await orgData.employee.findMany({
    where: { id: { in: employeeIds }, organizationId: orgId },
    select: { id: true, firstName: true, lastName: true },
  });
  const nameById = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));

  for (const c of candidates) {
    let risks: string[] = [];
    try {
      const parsed: unknown = JSON.parse(c.riskFactors || '[]');
      if (Array.isArray(parsed)) risks = parsed.filter((r): r is string => typeof r === 'string');
    } catch {
      risks = [];
    }
    try {
      const outcome = await notifyWithCooldown(
        orgId,
        {
          id: c.employeeId,
          name: nameById.get(c.employeeId) || 'Unknown employee',
          mood: c.mood,
          score: c.score,
          riskFactors: risks,
        },
        now
      );
      if (outcome === 'created') result.notificationsSent++;
      else result.suppressedByCooldown++;
    } catch (error) {
      result.errors.push(`sentiment alert for employee ${c.employeeId}: ${String(error)}`);
    }
  }
  return result;
}

/**
 * Lease-guarded scheduler entrypoint. Iterates ALL orgs (the scheduler has no
 * org context of its own); per-org failures are isolated and reported.
 */
export async function runSentimentAlertsJob(now = new Date()): Promise<SentimentAlertsResult> {
  if (!(await claimJob('sentiment_alerts'))) return emptyResult();
  const total = emptyResult();
  try {
    const orgs = await db.organization.findMany({ select: { id: true } });
    for (const org of orgs) {
      try {
        const r = await runSentimentAlertsForOrg(org.id, now);
        total.evaluatedOrgs += r.evaluatedOrgs;
        total.candidates += r.candidates;
        total.notificationsSent += r.notificationsSent;
        total.suppressedByCooldown += r.suppressedByCooldown;
        total.errors.push(...r.errors.map((e) => `${org.id}: ${e}`));
      } catch (error) {
        total.errors.push(`${org.id}: ${String(error)}`);
      }
    }
    await finishJob('sentiment_alerts', total.errors.length > 0 ? total.errors.join('; ') : undefined, {
      evaluatedOrgs: total.evaluatedOrgs,
      candidates: total.candidates,
      notificationsSent: total.notificationsSent,
      suppressedByCooldown: total.suppressedByCooldown,
    });
    if (total.notificationsSent > 0) {
      log.info('jobs.sentiment_alerts', { notificationsSent: total.notificationsSent, candidates: total.candidates });
    }
    return total;
  } catch (error) {
    await finishJob('sentiment_alerts', String(error));
    throw error;
  }
}
