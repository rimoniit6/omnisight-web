import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authenticateRequest, getSessionOrg } from '@/lib/api';
import { hasRolePermission } from '@/lib/auth';
import { RETENTION_KEYS } from '@/lib/jobs/settings';
import type { RetentionKey } from '@/lib/jobs/settings';

// Org-scoped data-retention configuration. Values are persisted in the
// OrganizationSetting table (one row per org + key) and consumed by the
// retention processor (src/lib/jobs/retention.ts). Semantics:
//   days > 0  -> operational data older than N days is purged/anonymized
//   days = 0  -> keep forever (default for compliance/audit categories)
// Validation rejects negatives, non-integers and absurd values (> 10 years).

const MAX_RETENTION_DAYS = 3650;

function validateRetentionValue(raw: unknown): number | null {
  // Strict decimal-integer only: rejects negatives, floats, hex ('0x10'),
  // scientific notation ('1e2') and empty strings.
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_RETENTION_DAYS) return null;
  return n;
}

// GET /api/settings/retention — current retention configuration for the org.
// Any authenticated member of the org may read it.
export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    const rows = await db.organizationSetting.findMany({
      where: { organizationId: org.id, key: { in: Object.keys(RETENTION_KEYS) } },
    });
    const raw = new Map(rows.map((r) => [r.key, r.value]));

    const settings = (Object.keys(RETENTION_KEYS) as RetentionKey[]).map((key) => {
      const stored = raw.get(key);
      const parsed = stored !== undefined ? Number(stored) : RETENTION_KEYS[key];
      return {
        key,
        category: key === 'audit_log_retention_days' || key === 'consent_log_retention_days' ? 'compliance' : 'operational',
        days: Number.isInteger(parsed) && parsed >= 0 ? parsed : RETENTION_KEYS[key],
        default: RETENTION_KEYS[key],
        // compliance records are anonymized, never deleted
        behavior: key === 'audit_log_retention_days' || key === 'consent_log_retention_days' ? 'anonymize' : 'delete',
      };
    });

    return NextResponse.json({ data: settings });
  } catch (error) {
    console.error('Retention settings GET error:', error);
    return NextResponse.json({ error: 'Failed to fetch retention settings' }, { status: 500 });
  }
}

// PUT /api/settings/retention — update one retention setting (admin+).
// Validated, tenant-scoped, and audited.
export async function PUT(req: NextRequest) {
  try {
    const auth = await authenticateRequest(req);
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized. Please sign in.' }, { status: 401 });
    }
    if (!hasRolePermission(auth.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    const org = await getSessionOrg(req);
    if (!org) return NextResponse.json({ error: 'No organization found' }, { status: 404 });

    const body = await req.json();
    const { key, value } = body as { key?: string; value?: unknown };

    if (!key || !(key in RETENTION_KEYS)) {
      return NextResponse.json(
        { error: `Invalid retention key. Valid: ${Object.keys(RETENTION_KEYS).join(', ')}` },
        { status: 400 }
      );
    }
    const days = validateRetentionValue(value);
    if (days === null) {
      return NextResponse.json(
        { error: `Retention value must be a whole number of days between 0 and ${MAX_RETENTION_DAYS}` },
        { status: 422 }
      );
    }

    const setting = await db.$transaction(async (tx) => {
      const upserted = await tx.organizationSetting.upsert({
        where: { organizationId_key: { organizationId: org.id, key } },
        update: { value: String(days), category: key === 'audit_log_retention_days' || key === 'consent_log_retention_days' ? 'compliance' : 'monitoring' },
        create: { organizationId: org.id, key, value: String(days), category: key === 'audit_log_retention_days' || key === 'consent_log_retention_days' ? 'compliance' : 'monitoring' },
      });
      await tx.auditLog.create({
        data: {
          action: 'configure',
          resource: 'settings',
          resourceId: upserted.id,
          description: `Retention policy ${key} set to ${days} days by ${auth.email}`,
          userId: auth.userId,
          organizationId: org.id,
        },
      });
      return upserted;
    });

    return NextResponse.json({ data: { key, days }, setting });
  } catch (error) {
    console.error('Retention settings PUT error:', error);
    return NextResponse.json({ error: 'Failed to update retention setting' }, { status: 500 });
  }
}
