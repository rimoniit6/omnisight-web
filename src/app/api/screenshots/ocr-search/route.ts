import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSessionOrg } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';

// GET /api/screenshots/ocr-search?query=...&page=1&pageSize=20
export async function GET(req: NextRequest) {
  try {
    // Tenant isolation: OCR search is organization-scoped from the verified
    // session — never from client input.
    const scope = await requireSessionOrg(req);
    if (!scope.ok) return authError(scope);
    if (!scope.organizationId) {
      return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
    }
    const orgId = scope.organizationId;

    const { searchParams } = new URL(req.url);
    const query = searchParams.get('query');
    const page = Math.max(1, Number(searchParams.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(searchParams.get('pageSize')) || 20));

    if (!query || query.trim().length === 0) {
      return NextResponse.json({ error: 'query parameter is required' }, { status: 400 });
    }

    // SQLite doesn't support mode: 'insensitive', so use raw SQL with LIKE
    // Escape any SQL LIKE special characters in the query
    const escapedQuery = query
      .replace(/%/g, '\\%')
      .replace(/_/g, '\\_');
    const likePattern = `%${escapedQuery}%`;

    // Use Prisma.raw with parameterized query for safety
    // We need the total count and the paginated results
    const [countResult, screenshots] = await Promise.all([
      // Count total matching rows — org-scoped
      db.$queryRawUnsafe<[{ count: bigint }]>(
        `SELECT COUNT(*) as count FROM "Screenshot" WHERE "organizationId" = $1 AND "ocrText" IS NOT NULL AND LOWER("ocrText") LIKE LOWER($2)`,
        orgId,
        likePattern
      ),
      // Fetch paginated results with joins — org-scoped
      db.$queryRawUnsafe<unknown[]>(
        `SELECT s.*, 
          e."id" as "employee_id", e."firstName" as "employee_firstName", e."lastName" as "employee_lastName", 
          e."employeeId" as "employee_employeeId", e."avatar" as "employee_avatar",
          d."id" as "device_id", d."name" as "device_name", d."hostname" as "device_hostname", d."status" as "device_status"
        FROM "Screenshot" s
        LEFT JOIN "Employee" e ON s."employeeId" = e."id"
        LEFT JOIN "Device" d ON s."deviceId" = d."id"
        WHERE s."organizationId" = $1 AND s."ocrText" IS NOT NULL AND LOWER(s."ocrText") LIKE LOWER($2)
        ORDER BY s."capturedAt" DESC
        LIMIT $3 OFFSET $4`,
        orgId,
        likePattern,
        pageSize,
        (page - 1) * pageSize
      ),
    ]);

    const total = Number(countResult[0]?.count ?? 0);

    // Normalize the raw results to match the Prisma include shape
    const data = (screenshots as Record<string, unknown>[]).map((row) => {
      const { employee_id, employee_firstName, employee_lastName, employee_employeeId, employee_avatar, device_id, device_name, device_hostname, device_status, ...screenshotFields } = row;
      return {
        ...screenshotFields,
        employee: employee_id
          ? {
              id: employee_id,
              firstName: employee_firstName,
              lastName: employee_lastName,
              employeeId: employee_employeeId,
              avatar: employee_avatar,
            }
          : null,
        device: device_id
          ? {
              id: device_id,
              name: device_name,
              hostname: device_hostname,
              status: device_status,
            }
          : null,
      };
    });

    return NextResponse.json({
      data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    log.error('api.screenshots.ocr-search.', { error: String('OCR search error:') }, requestContext(req));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
