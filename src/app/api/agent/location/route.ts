import { NextRequest, NextResponse } from 'next/server';
import { validateAgentToken } from '@/lib/agent/auth';
import { hasActiveConsent } from '@/lib/consent';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';
import { recordAgentLocation } from '@/lib/location-service';
import { log, requestContext } from '@/lib/logger';

// POST /api/agent/location
// One geolocation fix from the desktop agent's native geolocation module.
//
// PRIVACY CONTRACT: the payload may contain ONLY latitude, longitude,
// accuracy and timestamp. Addresses, reverse-geocoded strings and raw device
// location metadata are NEVER accepted (closed schema — unknown fields are
// rejected). No reverse geocoding happens on the server; nothing but
// coordinates is persisted.
//
// Enforcement chain:
//   validateAgentToken → location consent (403) → org `location_tracking`
//   (403) → strict coordinate/timestamp validation → 5 KM movement filter
//   (server-authoritative) → LocationEvent row (only when the fix is a
//   significant movement from the previously *accepted* location).
//
// The 5 KM filter is enforced HERE, server-side, not in the Agent UI. The
// Agent keeps sending fixes normally; the server decides whether a fix
// becomes an accepted history event. This keeps behaviour consistent across
// all agents and prevents repeated/duplicate uploads from bloating history.
//
// Movement < 5 KM returns HTTP 200 with `{ accepted: false, ... }` (NOT an
// error) so the Agent client keeps working unchanged.

const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_ACCURACY_METERS = 1_000_000;
const ALLOWED_KEYS = new Set(['latitude', 'longitude', 'accuracy', 'timestamp', 'source']);
const FORBIDDEN_KEYS = new Set(['address', 'reverseGeocodedAddress', 'rawDeviceLocationMetadata', 'street', 'city', 'postalCode', 'country']);

function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return !Number.isNaN(new Date(value).getTime());
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid || !authResult.employee) {
      return NextResponse.json({ error: authResult.error || 'Authentication failed' }, { status: 401 });
    }
    const employee = authResult.employee;

    if (!(await hasActiveConsent(employee.id, 'location'))) {
      return NextResponse.json(
        { error: 'Location tracking requires consent. Consent is not granted or has been revoked.' },
        { status: 403 }
      );
    }

    const monitoring = await resolveOrgMonitoring(employee.organizationId);
    if (monitoring.location_tracking !== true) {
      return NextResponse.json({ error: 'LOCATION_TRACKING_DISABLED' }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }

    // Closed schema: no unknown / forbidden / address-like fields.
    for (const key of Object.keys(body)) {
      if (FORBIDDEN_KEYS.has(key)) {
        return NextResponse.json({ error: `Field "${key}" is not allowed — addresses are never accepted` }, { status: 422 });
      }
      if (!ALLOWED_KEYS.has(key)) {
        return NextResponse.json({ error: `Unknown field "${key}" — payload schema is closed` }, { status: 422 });
      }
    }

    const { latitude, longitude, accuracy, timestamp, source } = body;
    if (!isFiniteNumber(latitude) || latitude < -90 || latitude > 90) {
      return NextResponse.json({ error: 'latitude must be a number in [-90, 90]' }, { status: 422 });
    }
    if (!isFiniteNumber(longitude) || longitude < -180 || longitude > 180) {
      return NextResponse.json({ error: 'longitude must be a number in [-180, 180]' }, { status: 422 });
    }
    // Accuracy: nullable — null when source='ip' (no GPS accuracy available)
    if (accuracy !== null && (!isFiniteNumber(accuracy) || accuracy < 0 || accuracy > MAX_ACCURACY_METERS)) {
      return NextResponse.json({ error: `accuracy must be null or a number in [0, ${MAX_ACCURACY_METERS}] meters` }, { status: 422 });
    }
    if (!isIsoTime(timestamp)) {
      return NextResponse.json({ error: 'timestamp must be an ISO timestamp' }, { status: 422 });
    }
    const recordedAt = new Date(timestamp);
    if (recordedAt.getTime() > Date.now() + FUTURE_SKEW_MS) {
      return NextResponse.json({ error: 'timestamp is in the future' }, { status: 422 });
    }
    // Source: 'native' or 'ip' — defaults to 'ip' for backward compatibility
    const locationSource = source === 'native' ? 'native' : 'ip';

    const result = await recordAgentLocation({
      employeeId: employee.id,
      organizationId: employee.organizationId,
      deviceId: authResult.deviceId || null,
      latitude,
      longitude,
      accuracy,
      recordedAt,
      source: locationSource,
    });

    if (result.accepted) {
      return NextResponse.json({
        success: true,
        accepted: true,
        id: result.id,
        first: result.first,
        distanceKm: result.distanceKm,
        thresholdKm: result.thresholdKm,
        message: result.first
          ? 'First location recorded'
          : 'Location recorded — significant movement accepted',
      });
    }

    // Below the movement threshold: not an error. The Agent keeps sending
    // fixes; only significant movements become history events.
    return NextResponse.json({
      success: false,
      accepted: false,
      reason: result.reason,
      thresholdKm: result.thresholdKm,
      distanceKm: result.distanceKm,
      message: 'Movement below threshold — not recorded as a new history event',
    });
  } catch (error) {
    log.error('api.agent.location.', { error: String('Agent location error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
