/**
 * Scheduled anomaly detection job (F-1).
 *
 * Runs the SAME engine as the on-demand route (src/lib/anomalies/service.ts)
 * for every active organization, on the existing hourly scheduler cadence and
 * under the existing crash-safe JobRun lease (`anomaly_detection`).
 *
 * Guarantees:
 *  - Per-organization processing with isolation: one failing org never blocks
 *    the others (continue-on-error, errors collected for observability).
 *  - Each org's `ai_anomaly_detection` setting is honored — disabled orgs are
 *    skipped entirely (fail closed).
 *  - Idempotent: the engine is deterministic and dedupe-safe (unique
 *    dedupeKey per org+employee+type+day), so repeated or concurrent runs
 *    cannot create duplicate anomalies.
 *  - Overlapping runs are impossible: the JobRun lease means only one worker
 *    executes this job at a time (and the unique dedupeKey is a second line
 *    of defense against the on-demand route racing the job).
 */
import { db } from '@/lib/db';
import { getOrgSetting } from './settings';
import { runAnomalyDetection } from '@/lib/anomalies/service';
import { claimJob, finishJob } from './run';

export interface AnomalyDetectionJobResult {
  orgsScanned: number;
  orgsSkipped: number;
  orgsFailed: number;
  employeesScanned: number;
  anomaliesCreated: number;
  /** Real failures only — rule-skip reasons are observability, not errors. */
  errors: string[];
  /** Rule-skip reasons (new-employee, shallow baseline, no activity) —
   *  summarized per org for observability; never mark the job failed. */
  skippedSummary: string[];
}

export async function runAnomalyDetectionJob(): Promise<AnomalyDetectionJobResult> {
  const result: AnomalyDetectionJobResult = {
    orgsScanned: 0,
    orgsSkipped: 0,
    orgsFailed: 0,
    employeesScanned: 0,
    anomaliesCreated: 0,
    errors: [],
    skippedSummary: [],
  };

  if (!(await claimJob('anomaly_detection'))) {
    return result; // lease held elsewhere — no-op this round
  }

  try {
    const orgs = await db.organization.findMany({ where: { status: 'active' }, select: { id: true } });

    for (const org of orgs) {
      try {
        // Fail closed: a disabled setting (or corrupt stored value) skips.
        if ((await getOrgSetting(org.id, 'ai_anomaly_detection', 'true')) !== 'true') {
          result.orgsSkipped += 1;
          continue;
        }

        const run = await runAnomalyDetection({ orgId: org.id });
        result.orgsScanned += 1;
        if (run.status === 'ok') {
          result.employeesScanned += run.scannedEmployees;
          result.anomaliesCreated += run.detected;
          if (run.skippedReasons.length > 0) {
            // Summarized — never the raw telemetry, just rule-skip reasons.
            // Kept OUT of errors: skipping rules for shallow history is the
            // correct, expected behavior, not a job failure.
            const sample = run.skippedReasons.slice(0, 5);
            result.skippedSummary.push(`org ${org.id}: skipped rules (${run.skippedReasons.length} total): ${sample.join(' | ')}`);
          }
        }
      } catch (error) {
        result.orgsFailed += 1;
        result.errors.push(`org ${org.id}: ${String(error)}`);
        console.error(`[jobs] anomaly detection failed for org ${org.id}, continuing:`, error);
      }
    }

    await finishJob('anomaly_detection', result.errors.length > 0 ? result.errors.join('; ') : undefined, {
      orgsScanned: result.orgsScanned,
      orgsSkipped: result.orgsSkipped,
      orgsFailed: result.orgsFailed,
      employeesScanned: result.employeesScanned,
      anomaliesCreated: result.anomaliesCreated,
      skippedRules: result.skippedSummary.length,
    });

    return result;
  } catch (error) {
    await finishJob('anomaly_detection', String(error)).catch(() => {});
    throw error;
  }
}
