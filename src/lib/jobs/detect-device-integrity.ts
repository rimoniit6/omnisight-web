// OmniSight — device-integrity detection (R3: server-authoritative tamper /
// telemetry-interruption signal).
//
// The SERVER is the authority on agent health. An approved, actively-monitored
// device that stops reporting is the strongest honest signal that something
// intervened with the agent (process kill, uninstall, blocked binary, stolen
// device, network loss). This job converts that signal into a low-severity,
// dedupe-keyed `device_missing` anomaly — deliberately NOT labeled "tampered":
// a silent device has many legitimate causes (shutdown, sleep, network
// outage), so the anomaly reports the fact and the possible causes, and the
// admin judges.
//
// Semantics:
//   - Only devices whose status is still `online` (they WERE reporting) with a
//     heartbeat older than DEVICE_MISSING_THRESHOLD_MS are flagged.
//   - Only devices whose bound employee has ACTIVE `monitoring` consent are
//     flagged — a consent-revoked device going silent is expected, not
//     suspicious (no false positives).
//   - Dedupe: one anomaly per org+device+type+UTC day (unique dedupeKey), so
//     a device that stays silent for days produces one row per day, not one
//     per job run.
//   - Crash-safe under the shared JobRun lease; continue-on-error per org.
//   - Network outages are NOT classified as tampering: the anomaly text states
//     the possible causes and the severity is low.
//
// Detection latency: ≤ DEVICE_MISSING_THRESHOLD_MS + job cadence (hourly) —
// i.e. a silently-killed agent is surfaced within ~15–75 minutes, documented
// as the operational SLA. Client-side binary-integrity attestation (signed
// binaries, debugger detection) is intentionally NOT implemented: without a
// TPM-backed attestation it is security theater, and the server remains the
// authority.
import { db } from '@/lib/db';
import { persistAnomaly } from '@/lib/anomalies/service';
import { claimJob, finishJob } from './run';

export const DEVICE_MISSING_THRESHOLD_MS = 15 * 60 * 1000; // 15 min — 3× the 5-min online threshold

export interface DeviceIntegrityResult {
  orgsScanned: number;
  devicesScanned: number;
  missingDetected: number;
  anomaliesCreated: number;
  errors: string[];
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function runDeviceIntegrityJob(): Promise<DeviceIntegrityResult> {
  const result: DeviceIntegrityResult = { orgsScanned: 0, devicesScanned: 0, missingDetected: 0, anomaliesCreated: 0, errors: [] };

  if (!(await claimJob('device_integrity'))) {
    return result; // lease held elsewhere — no-op this round
  }

  try {
    const orgs = await db.organization.findMany({ where: { status: 'active' }, select: { id: true } });
    const staleBefore = new Date(Date.now() - DEVICE_MISSING_THRESHOLD_MS);
    const day = utcDayKey(new Date());

    for (const org of orgs) {
      try {
        const staleDevices = await db.device.findMany({
          where: {
            organizationId: org.id,
            status: 'online', // WAS reporting → went silent
            lastHeartbeat: { lt: staleBefore },
            employeeId: { not: null }, // enforced by the relation filter below
            employee: {
              status: 'active',
              consents: { some: { consentType: 'monitoring', status: 'granted' } },
            },
          },
          select: {
            id: true,
            name: true,
            hostname: true,
            employeeId: true,
            lastHeartbeat: true,
          },
        });

        result.orgsScanned += 1;
        result.devicesScanned += staleDevices.length;
        result.missingDetected += staleDevices.length;

        for (const d of staleDevices) {
          const dedupeKey = `${org.id}:${d.id}:device_missing:${day}`;
          const existing = await db.anomaly.findUnique({ where: { dedupeKey }, select: { id: true } });
          if (existing) continue;

          const minutesAgo = d.lastHeartbeat
            ? Math.max(1, Math.round((Date.now() - d.lastHeartbeat.getTime()) / 60_000))
            : null;
          const label = d.name || d.hostname || d.id;
          const { created } = await persistAnomaly(
            {
              type: 'device_missing',
              severity: 'low',
              title: 'Device stopped reporting',
              description:
                `Device "${label}" last reported ${minutesAgo === null ? 'at an unknown time' : `${minutesAgo} minutes ago`}. ` +
                'Possible causes: network outage, shutdown/sleep, agent process termination, uninstall, or device tampering — review the device record and the employee\'s consent state.',
              score: 60,
              confidence: 0.7,
              // Guaranteed non-null: the query requires an employee relation
              // match (employeeId: { not: null } + the `employee:` filter).
              employeeId: d.employeeId!,
              deviceId: d.id,
              metadata: {
                lastHeartbeat: d.lastHeartbeat ? d.lastHeartbeat.toISOString() : null,
                thresholdMinutes: DEVICE_MISSING_THRESHOLD_MS / 60_000,
                cause: 'heartbeat_timeout',
              },
            },
            org.id,
            dedupeKey
          );
          if (created) result.anomaliesCreated += 1;
        }
      } catch (error) {
        result.errors.push(`org ${org.id}: ${String(error)}`);
        console.error(`[jobs] device-integrity detection failed for org ${org.id}, continuing:`, error);
      }
    }
    await finishJob('device_integrity', result.errors.length ? result.errors.join('; ') : undefined, {
      ...result,
    });
  } catch (error) {
    result.errors.push(`device_integrity: ${String(error)}`);
    await finishJob('device_integrity', String(error)).catch(() => {});
  }

  return result;
}
