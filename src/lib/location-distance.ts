/**
 * Geographic distance utility — Haversine formula.
 *
 * Used by the server-side 5 KM movement-threshold filter (see
 * src/lib/location-service.ts) so that a new location is only accepted as a
 * LocationEvent when it has moved at least MOVEMENT_THRESHOLD_KM from the
 * previously *accepted* location.
 *
 * Coordinates are validated to sane ranges; out-of-range input throws rather
 * than returning a silently wrong distance. Distance is computed in kilometers
 * using the mean Earth radius (6371 km). Floating-point equality is NEVER used
 * for the acceptance decision — callers compare `distanceKm >= threshold`.
 */

export const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * @throws {Error} if latitude/longitude are outside valid WGS84 ranges.
 */
export function assertValidCoordinate(latitude: number, longitude: number): void {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error(`Invalid latitude: ${latitude} (must be within [-90, 90])`);
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error(`Invalid longitude: ${longitude} (must be within [-180, 180])`);
  }
}

/**
 * Great-circle distance between two coordinates in kilometers.
 *
 * @returns kilometers (0 for identical points)
 */
export function calculateDistanceKm(
  latitude1: number,
  longitude1: number,
  latitude2: number,
  longitude2: number
): number {
  assertValidCoordinate(latitude1, longitude1);
  assertValidCoordinate(latitude2, longitude2);

  const dLat = toRadians(latitude2 - latitude1);
  const dLon = toRadians(longitude2 - longitude1);
  const lat1 = toRadians(latitude1);
  const lat2 = toRadians(latitude2);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  // Clamp to [0,1] to avoid NaN from floating-point drift near 1.
  const clamped = Math.min(1, Math.max(0, a));
  const c = 2 * Math.atan2(Math.sqrt(clamped), Math.sqrt(1 - clamped));
  return EARTH_RADIUS_KM * c;
}
