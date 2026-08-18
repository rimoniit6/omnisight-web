import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { validateAgentToken } from '@/lib/agent/auth';
import { hasActiveConsent } from '@/lib/consent';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';

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
//   (403) → strict coordinate/timestamp validation → LocationEvent row.

const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_ACCURACY_METERS = 1_000_000;
const ALLOWED_KEYS = new Set(['latitude', 'longitude', 'accuracy', 'timestamp']);
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

    const { latitude, longitude, accuracy, timestamp } = body;
    if (!isFiniteNumber(latitude) || latitude < -90 || latitude > 90) {
      return NextResponse.json({ error: 'latitude must be a number in [-90, 90]' }, { status: 422 });
    }
    if (!isFiniteNumber(longitude) || longitude < -180 || longitude > 180) {
      return NextResponse.json({ error: 'longitude must be a number in [-180, 180]' }, { status: 422 });
    }
    if (!isFiniteNumber(accuracy) || accuracy < 0 || accuracy > MAX_ACCURACY_METERS) {
      return NextResponse.json({ error: `accuracy must be a number in [0, ${MAX_ACCURACY_METERS}] meters` }, { status: 422 });
    }
    if (!isIsoTime(timestamp)) {
      return NextResponse.json({ error: 'timestamp must be an ISO timestamp' }, { status: 422 });
    }
    const recordedAt = new Date(timestamp);
    if (recordedAt.getTime() > Date.now() + FUTURE_SKEW_MS) {
      return NextResponse.json({ error: 'timestamp is in the future' }, { status: 422 });
    }

    const created = await db.locationEvent.create({
      data: {
        employeeId: employee.id,
        deviceId: authResult.deviceId || null,
        organizationId: employee.organizationId,
        latitude,
        longitude,
        accuracy,
        recordedAt,
      },
    });

    return NextResponse.json({ success: true, id: created.id, message: 'Location recorded' });
  } catch (error) {
    console.error('Agent location error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
