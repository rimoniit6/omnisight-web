import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { validateAgentToken } from '@/lib/agent/auth';
import { hasActiveConsent } from '@/lib/consent';
import { resolveOrgMonitoring } from '@/lib/jobs/settings';
import { validateUsbEventInput, usbDedupeKey } from '@/lib/policies/validation';

// POST /api/agent/usb
// Agent reports a real USB device arrival/removal observation.
//
// SECURITY / PRIVACY:
//   - organizationId / employeeId / deviceId are ALWAYS derived from the
//     authenticated agent token — client payload values are ignored.
//   - Collection is gated on BOTH the org monitoring flag (usb_monitoring)
//     AND the employee's active usb_monitoring consent. Revoked consent or a
//     disabled org flag fails closed with 403 — the server never trusts the
//     agent to self-gate.
//   - Only insert/remove events are accepted; `blocked` is never client-
//     controlled (the schema default false is authoritative).
//   - Duplicate reports (same device + type within the dedupe window) are
//     deduplicated at the DB level by the unique dedupeKey.
export async function POST(req: NextRequest) {
  try {
    const authResult = await validateAgentToken(req);
    if (!authResult.valid) {
      return NextResponse.json({ error: authResult.error }, { status: 401 });
    }
    const employee = authResult.employee!;
    const orgId = employee.organizationId;

    // Org config gate (fail closed): the org must enable USB monitoring.
    const monitoring = await resolveOrgMonitoring(orgId);
    if (monitoring.usb_monitoring !== true) {
      return NextResponse.json(
        { error: 'USB monitoring is not enabled for this organization' },
        { status: 403 }
      );
    }

    // Consent gate (fail closed): the employee must hold active usb_monitoring
    // consent bound to the current published policy.
    if (!(await hasActiveConsent(employee.id, 'usb_monitoring'))) {
      return NextResponse.json(
        { error: 'USB monitoring requires consent. Consent is not granted or has been revoked.' },
        { status: 403 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const validated = validateUsbEventInput(body);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 422 });
    }
    const input = validated.value;

    const occurredAt = input.occurredAt ?? new Date();

    const dedupeKey = usbDedupeKey({
      organizationId: orgId,
      deviceId: authResult.deviceId ?? null,
      serialNumber: input.serialNumber,
      eventType: input.eventType,
      occurredAt,
    });

    try {
      const created = await db.usbEvent.create({
        data: {
          eventType: input.eventType,
          deviceName: input.deviceName,
          vendorName: input.vendorName,
          serialNumber: input.serialNumber,
          vid: input.vid,
          pid: input.pid,
          manufacturer: input.manufacturer,
          deviceClass: input.deviceClass,
          driveLetter: input.driveLetter,
          filePath: input.filePath,
          employeeId: employee.id,
          deviceId: authResult.deviceId ?? null,
          blocked: false, // never client-controlled
          organizationId: orgId,
          dedupeKey,
          createdAt: occurredAt,
        },
      });

      return NextResponse.json({ success: true, eventId: created.id, duplicate: false }, { status: 201 });
    } catch (error) {
      // DB-level dedupe: an identical event within the window (or a concurrent
      // duplicate) hits the unique dedupeKey — report as a successful no-op.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return NextResponse.json({ success: true, eventId: null, duplicate: true }, { status: 200 });
      }
      throw error;
    }
  } catch (error) {
    console.error('Agent USB POST error:', error);
    return NextResponse.json({ error: 'Failed to record USB event' }, { status: 500 });
  }
}
