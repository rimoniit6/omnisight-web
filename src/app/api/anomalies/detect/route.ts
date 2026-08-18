import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, getSessionOrg } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { runAnomalyDetection } from '@/lib/anomalies/service';

// POST /api/anomalies/detect — Run anomaly detection on current data (manager+)
// All per-employee data is loaded in batched queries (no N+1); detections are
// deterministic (no randomness), written atomically, deduplicated DB-safely
// (unique dedupeKey), and honor the org-scoped `ai_anomaly_detection` setting
// (fails closed). The detection logic lives in src/lib/anomalies — the same
// engine the scheduled job (F-1) uses.
export async function POST(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'manager')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    const org = await getSessionOrg(req);
    if (!org) {
      return NextResponse.json({ error: 'No organization found' }, { status: 404 });
    }

    let employeeId: string | undefined;
    try {
      const body = await req.json();
      if (body && typeof body === 'object' && typeof body.employeeId === 'string') {
        employeeId = body.employeeId;
      }
    } catch {
      // Empty body is fine for a full-org run.
    }

    const result = await runAnomalyDetection({ orgId: org.id, employeeId });

    if (result.status === 'disabled') {
      return NextResponse.json({ error: 'Anomaly detection is disabled for this organization' }, { status: 403 });
    }

    return NextResponse.json({
      message: 'Anomaly detection complete',
      scannedEmployees: result.scannedEmployees,
      detected: result.detected,
      skipped: result.skipped,
      skippedReasons: result.skippedReasons,
    });
  } catch (error) {
    console.error('Anomaly detection error:', error);
    return NextResponse.json({ error: 'Failed to run anomaly detection' }, { status: 500 });
  }
}
