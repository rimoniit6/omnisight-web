import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { db as prisma } from '@/lib/db';
import {
  requireDbVerifiedRole,
  apiError,
  apiSuccess,
  authError,
  parseJsonBody,
  BodyParseError,
} from '@/lib/api';
import { hashPassword, getRoleLabel } from '@/lib/auth';
import { normalizeEmail, sendWelcomeEmail } from '@/lib/email';
import { log, requestContext } from '@/lib/logger';

/**
 * POST /api/admin/organizations/create
 *
 * SUPER-ADMIN account generation: provisions a complete, ready-to-log-in
 * organization in one atomic step.
 *
 *   Org        — created active, with the platform-level authority of the
 *                super admin (NO super-admin membership is created).
 *   Admin user — an AppUser (role "user") with an ACTIVE OrganizationMembership
 *                of role "org_admin", so the user functions as the org admin.
 *   Subscription — a PENDING subscription + PENDING invoice are created for the
 *                chosen paid plan (Manual / Contact Sales payment path). No
 *                plan (or the Free plan) → ACTIVE-free, no invoice.
 *   Email      — a welcome/credentials email is composed (MOCK — see email.ts).
 *
 * Body: {
 *   name: string (required, min 2 chars),
 *   slug?: string,
 *   adminEmail: string (required, normalized),
 *   adminName?: string,
 *   password?: string (optional; if omitted a random temp password is generated
 *                     and returned ONCE in the response),
 *   planName?: string ("Free" | "Pro" | "Business" | ...),
 *   timezone?: string (default "Asia/Dhaka"),
 *   deploymentMode?: 'MANAGED' | 'PRIVATE' (default MANAGED; CUSTOMER_DB is
 *                     rejected until a customer primary-database mechanism
 *                     exists — Phase 2 §9-10),
 *   status?: 'active' | 'pending' (default active; pending keeps the org
 *            locked out via requireActiveSessionOrg until SA activates it)
 * }
 */
export async function POST(req: NextRequest) {
  const adminResult = await requireDbVerifiedRole(req, { requireSuperAdmin: true });
  if (!adminResult.ok) return authError(adminResult);
  const admin = adminResult;

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody(req);
  } catch (e) {
    if (e instanceof BodyParseError) return apiError('Invalid request body', 400);
    return apiError('Invalid request body', 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 2) {
    return apiError('Organization name is required (min 2 characters)', 422);
  }

  const adminEmail = normalizeEmail(body.adminEmail);
  if (!adminEmail) {
    return apiError('Admin email is required', 422);
  }

  const adminName = typeof body.adminName === 'string' ? body.adminName.trim().slice(0, 120) : null;
  const timezone = typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : 'Asia/Dhaka';

  // Phase 2 §9: deployment mode is explicit at creation. CUSTOMER_DB is
  // rejected (no datasource infra — fail closed, never inferred from useOwnDb).
  const deploymentMode = typeof body.deploymentMode === 'string' ? body.deploymentMode : 'MANAGED';
  if (deploymentMode !== 'MANAGED' && deploymentMode !== 'PRIVATE') {
    return apiError(
      deploymentMode === 'CUSTOMER_DB'
        ? 'CUSTOMER_DB requires a configured customer primary database (Configuration: Pending). Create as MANAGED or PRIVATE instead.'
        : 'Invalid deploymentMode. Must be: MANAGED or PRIVATE',
      422,
    );
  }

  // Phase 2 §20: opt-in PENDING lifecycle (default active preserves backward compatibility).
  const initialStatus = typeof body.status === 'string' ? body.status : 'active';
  if (initialStatus !== 'active' && initialStatus !== 'pending') {
    return apiError("Invalid status. Must be: 'active' or 'pending'", 422);
  }

  // Password: use the provided one (validated ≥ 8), else generate a strong temp password.
  let tempPassword: string | null = null;
  let password = body.password as string | undefined;
  if (typeof password === 'string' && password !== '') {
    if (password.length < 8) {
      return apiError('Password must be at least 8 characters', 422);
    }
  } else {
    tempPassword = randomBytes(12).toString('base64url');
    password = tempPassword;
  }

  // Slug uniqueness
  const slug = (typeof body.slug === 'string' && body.slug.trim()
    ? body.slug.trim()
    : name
  )
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);

  if (!slug) {
    return apiError('Could not derive a valid organization slug', 422);
  }

  const existingSlug = await prisma.organization.findUnique({ where: { slug } });
  if (existingSlug) {
    return apiError('An organization with that slug already exists', 409);
  }

  // Admin uniqueness (case-insensitive, across all workspaces).
  const existingUser = await prisma.appUser.findFirst({
    where: { email: { equals: adminEmail, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existingUser) {
    return apiError('A user with that email already exists', 409);
  }

  // Optional paid plan provisioning.
  const planName = typeof body.planName === 'string' ? body.planName.trim() : '';
  let plan = null;
  if (planName) {
    plan = await prisma.plan.findFirst({
      where: { name: { equals: planName, mode: 'insensitive' }, isActive: true },
      select: { id: true, name: true, priceMonthly: true, currency: true },
    });
    if (!plan) {
      return apiError(`Plan "${planName}" not found or inactive`, 422);
    }
  }
  const isPaid = plan !== null && plan.name !== 'Free' && plan.priceMonthly > 0;

  const hashedPassword = await hashPassword(password);

  const result = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name,
        slug,
        email: adminEmail,
        timezone,
        status: initialStatus,
        deploymentMode,
      },
      select: { id: true, name: true, slug: true, status: true, deploymentMode: true, createdAt: true },
    });

    const user = await tx.appUser.create({
      data: {
        email: adminEmail,
        name: adminName || adminEmail.split('@')[0] || 'Organization Admin',
        password: hashedPassword,
        role: 'user',
        organizationId: organization.id,
        isActive: true,
        mustChangePassword: tempPassword !== null,
      },
      select: { id: true, email: true, name: true },
    });

    // Authoritative membership layer — org admin of the new workspace.
    await tx.organizationMembership.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        role: 'org_admin',
        status: 'ACTIVE',
      },
    });

    // Provision subscription + PENDING invoice for paid plans.
    let subscriptionId: string | null = null;
    if (plan && isPaid) {
      const now = new Date();
      const endDate = new Date(now);
      endDate.setMonth(endDate.getMonth() + 1);
      const dueDate = new Date(now);
      dueDate.setDate(dueDate.getDate() + 7);

      const year = now.getFullYear();
      const last = await tx.invoice.findFirst({
        where: { invoiceNumber: { startsWith: `INV-${year}-` } },
        orderBy: { createdAt: 'desc' },
      });
      const lastSeq = last ? parseInt(last.invoiceNumber.split('-').pop() ?? '0', 10) || 0 : 0;
      const invoiceNumber = `INV-${year}-${String(lastSeq + 1).padStart(4, '0')}`;

      const subscription = await tx.subscription.create({
        data: {
          organizationId: organization.id,
          planId: plan.id,
          status: 'PENDING',
          startDate: now,
          endDate,
          notes: `Provisioned by super admin — Manual (${plan.name})`,
        },
      });

      await tx.invoice.create({
        data: {
          subscriptionId: subscription.id,
          organizationId: organization.id,
          invoiceNumber,
          amount: plan.priceMonthly,
          currency: plan.currency || 'BDT',
          status: 'PENDING',
          dueDate,
          notes: `Subscription to ${plan.name} (manual provisioning)`,
        },
      });

      await tx.organization.update({
        where: { id: organization.id },
        data: { subscriptionId: subscription.id },
      });
      subscriptionId = subscription.id;
    }

    // Audit log(s)
    await tx.auditLog.create({
      data: {
        action: 'create',
        resource: 'organization',
        resourceId: organization.id,
        description: `Organization "${organization.name}" generated with admin ${user.email} (mode ${deploymentMode}, status ${initialStatus}${plan ? `, package ${plan.name}` : ''})`,
        userId: admin.userId,
        organizationId: organization.id,
      },
    });
    await tx.auditLog.create({
      data: {
        action: 'create',
        resource: 'user',
        resourceId: user.id,
        description: `Org admin ${user.email} created for org "${organization.name}"`,
        userId: admin.userId,
        organizationId: organization.id,
      },
    });

    return { organization, user, subscriptionId };
  });

  // Welcome email (MOCK): relay admin email + login link.
  const loginUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/login`;
  await sendWelcomeEmail(adminEmail, name, getRoleLabel('org_admin'), loginUrl).catch(() => null);

  log.info(
    'api.admin.organizations.create',
    { orgId: result.organization.id, adminEmail, hasTempPassword: Boolean(tempPassword) },
    requestContext(req)
  );

  return apiSuccess(
    {
      organization: result.organization,
      admin: result.user,
      subscriptionId: result.subscriptionId,
      // Returned ONCE only — relay to the new admin, then it should be reset.
      tempPassword,
    },
    201
  );
}
