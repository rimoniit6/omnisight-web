/**
 * Server-authoritative location ingestion.
 *
 * `recordAgentLocation` decides whether an incoming agent fix becomes an
 * accepted `LocationEvent` (and therefore a Location History row + a
 * `location-update` realtime event) based on the 5 KM movement threshold.
 *
 * Business rule (see LOCATION-5KM-MOVEMENT task):
 *   - First valid location for an employee is ALWAYS accepted.
 *   - Subsequent fixes are accepted only when they are >= 5 km (Haversine)
 *     from the previously *accepted* location — never from the immediately
 *     previous raw reading. Small movements cannot accumulate across ignored
 *     readings to trigger a save.
 *   - A fix below the threshold is NOT stored; the API still returns success
 *     (it is not an error).
 *
 * Concurrency: the lookup of the latest accepted location and the optional
 * insert run inside a single interactive transaction with a `FOR UPDATE` row
 * lock on the latest row. This serializes concurrent uploads for the same
 * employee so two near-simultaneous requests cannot both compare against the
 * same stale baseline and create duplicate accepted events.
 *
 * Privacy: only latitude/longitude/accuracy/recordedAt (+ ids) are stored.
 * No addresses, no reverse geocoding, no raw device metadata.
 */

import { db } from '@/lib/db';
import { calculateDistanceKm } from './location-distance';

export const MOVEMENT_THRESHOLD_KM = 5;

export interface RecordLocationInput {
  employeeId: string;
  organizationId: string;
  deviceId: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null; // null when source='ip' (no GPS accuracy available)
  recordedAt: Date;
  /** Location source: 'native' = Windows/device GPS, 'ip' = IP-based geolocation fallback. */
  source?: 'native' | 'ip';
}

export type RecordLocationResult =
  | {
      accepted: true;
      id: string;
      distanceKm: number;
      first: boolean;
      thresholdKm: number;
    }
  | {
      accepted: false;
      reason: 'below_movement_threshold';
      thresholdKm: number;
      distanceKm: number;
    };

interface LocationRow {
  id: string;
  latitude: number;
  longitude: number;
}

async function latestAccepted(
  tx: Parameters<Parameters<typeof db.$transaction>[0]>[0],
  employeeId: string
): Promise<LocationRow | null> {
  // Take a row lock (FOR UPDATE) on the latest accepted location so that two
  // concurrent uploads for the same employee serialize: the second transaction
  // blocks until the first commits, then reads the new baseline. This prevents
  // both near-simultaneous requests from comparing against the same stale
  // baseline and creating duplicate accepted events. Raw SQL is used because
  // the generated Prisma client does not expose the `lock` argument without a
  // preview feature; FOR UPDATE is universally supported on PostgreSQL.
  const rows = (await tx.$queryRawUnsafe(
    `SELECT id, latitude, longitude FROM "LocationEvent" WHERE "employeeId" = $1 ORDER BY "recordedAt" DESC, "id" DESC LIMIT 1 FOR UPDATE`,
    employeeId
  )) as LocationRow[];
  return rows[0] ?? null;
}

export async function recordAgentLocation(
  input: RecordLocationInput
): Promise<RecordLocationResult> {
  return db.$transaction(async (tx) => {
    const latest = await latestAccepted(tx, input.employeeId);

    // First location for this employee — always accept.
    if (!latest) {
      const created = await tx.locationEvent.create({
        data: {
          employeeId: input.employeeId,
          deviceId: input.deviceId,
          organizationId: input.organizationId,
          latitude: input.latitude,
          longitude: input.longitude,
          accuracy: input.accuracy,
          recordedAt: input.recordedAt,
          source: input.source ?? 'ip',
        },
        select: { id: true },
      });
      return {
        accepted: true,
        id: created.id,
        distanceKm: 0,
        first: true,
        thresholdKm: MOVEMENT_THRESHOLD_KM,
      };
    }

    const distanceKm = calculateDistanceKm(
      latest.latitude,
      latest.longitude,
      input.latitude,
      input.longitude
    );

    // Below threshold — do NOT create a history event.
    if (distanceKm < MOVEMENT_THRESHOLD_KM) {
      return {
        accepted: false,
        reason: 'below_movement_threshold',
        thresholdKm: MOVEMENT_THRESHOLD_KM,
        distanceKm,
      };
    }

    const created = await tx.locationEvent.create({
      data: {
        employeeId: input.employeeId,
        deviceId: input.deviceId,
        organizationId: input.organizationId,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy: input.accuracy,
        recordedAt: input.recordedAt,
        source: input.source ?? 'ip',
      },
      select: { id: true },
    });
    return {
      accepted: true,
      id: created.id,
      distanceKm,
      first: false,
      thresholdKm: MOVEMENT_THRESHOLD_KM,
    };
  });
}
