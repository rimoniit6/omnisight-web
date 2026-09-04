import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { normalizeEmail } from '@/lib/email';
import { log, requestContext } from '@/lib/logger';
import { checkRateLimit, RATE_LIMITS, getClientIpFromHeaders } from '@/lib/rate-limit';

// POST /api/leads — PUBLIC marketing / contact-sales submission.
//
// Stores a Lead row so the sales team can follow up. Accepts submissions from
// the public /contact page and the landing-page CTA.
//
// Rules:
//   • Unauthenticated by design (this is a public marketing form).
//   • Email normalized (trim + lowercase) for consistent lookups.
//   • Rate-limited per IP to prevent spam.
//   • Never returns/store duplicate junk — a NEW lead each time (marketing may
//     want repeated touches), but the email is indexed for quick search.

const VALID_PLANS = new Set(['Free', 'Pro', 'Business', 'Enterprise', 'Self-Hosted']);

export async function POST(req: NextRequest) {
  try {
    const clientIp = getClientIpFromHeaders(req.headers);
    const rl = await checkRateLimit(
      `lead-create:${clientIp}`,
      RATE_LIMITS.licenseGenerate.limit,
      RATE_LIMITS.licenseGenerate.windowMs
    );
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many requests. Try again in ${rl.retryAfterSeconds} seconds.` },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as {
      name?: unknown;
      email?: unknown;
      company?: unknown;
      planInterest?: unknown;
      message?: unknown;
    };

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = normalizeEmail(body.email);
    if (!name || !email) {
      return NextResponse.json({ error: 'Name and email are required' }, { status: 422 });
    }
    if (name.length > 200 || email.length > 320) {
      return NextResponse.json({ error: 'Input too long' }, { status: 422 });
    }

    const planInterest =
      typeof body.planInterest === 'string' && VALID_PLANS.has(body.planInterest)
        ? body.planInterest
        : 'Enterprise';

    const company = typeof body.company === 'string' ? body.company.trim().slice(0, 200) : null;
    const message = typeof body.message === 'string' ? body.message.trim().slice(0, 4000) : null;

    const lead = await db.lead.create({
      data: {
        name,
        email,
        company: company || null,
        planInterest,
        message: message || null,
        status: 'NEW',
        source: 'contact_page',
      },
    });

    log.info('api.leads.create', { leadId: lead.id, planInterest, hasMessage: Boolean(message) }, requestContext(req));

    return NextResponse.json({ success: true, id: lead.id }, { status: 201 });
  } catch (error) {
    log.error('api.leads.create', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to submit inquiry' }, { status: 500 });
  }
}
