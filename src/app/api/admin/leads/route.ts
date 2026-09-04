import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireSuperAdmin, apiError } from '@/lib/api';
import { log, requestContext } from '@/lib/logger';
import { LEAD_STATUSES, isLeadStatus, type LeadStatus } from '@/lib/leads';

// GET /api/admin/leads
// Super Admin: list sales leads (optionally filtered by status), newest first.
export async function GET(req: NextRequest) {
  try {
    const admin = await requireSuperAdmin(req);
    if (!admin.ok) {
      return apiError(admin.status === 401 ? 'Unauthorized' : 'Super admin access required', admin.status);
    }

    const statusFilter = req.nextUrl.searchParams.get('status');
    const status = statusFilter && isLeadStatus(statusFilter) ? statusFilter : undefined;

    const leads = await db.lead.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    return NextResponse.json({
      leads: leads.map((lead) => ({
        id: lead.id,
        name: lead.name,
        email: lead.email,
        company: lead.company,
        planInterest: lead.planInterest,
        message: lead.message,
        status: lead.status,
        source: lead.source,
        createdAt: lead.createdAt.toISOString(),
        updatedAt: lead.updatedAt.toISOString(),
      })),
    });
  } catch (error) {
    log.error('api.admin.leads.get', { error: String(error) }, requestContext(req));
    return apiError('Failed to fetch leads', 500);
  }
}
