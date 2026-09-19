// OmniSight — Demo-First Experience: idempotent demo tenant bootstrap.
//
// Creates (or validates) the ONE demo organization + demo user + membership +
// fictional ACTIVE subscription. Safe to run repeatedly:
//
//   find existing demo org (by isDemo marker) → reuse if valid → else create
//
// Guarantees:
//   • at most one demo org (DB partial unique index + script-level checks)
//   • demo user is NEVER super_admin (role 'user', no platform power)
//   • demo membership role is 'org_admin' (Organization Admin view — full
//     feature surface incl. Users, Settings, Security, AI Provider; visitors
//     see the admin experience the customer would configure)
//   • subscription is a fictional, non-billable ACTIVE row (no invoices, no
//     payment records, no purchase requests — never touches customer flows)
//   • every write is asserted to target the demo org (assertDemoOrg)
//
// Usage:  npx tsx --require ./tests/helpers/mock-server-only.cjs scripts/bootstrap-demo.ts
// (DEMO_USER_PASSWORD env is optional; a random password is generated when
// unset — it is never printed and never needed: sessions are minted
// server-side by /api/demo/enter, not by password login.)
//
// NOTE: The --require flag pre-seeds Node's require cache with a no-op
// `server-only` shim BEFORE tsx processes the ESM module graph. See
// scripts/seed-demo.ts header for the full explanation.

import { randomBytes } from 'crypto';
import { db } from '@/lib/db';
import { hashPasswordSync } from '@/lib/auth';
import {
  DEMO_ORG_SLUG,
  DEMO_ORG_NAME,
  DEMO_ORG_TIMEZONE,
  DEMO_USER_EMAIL,
  DEMO_USER_NAME,
  demoUserPassword,
  assertDemoOrg,
  DemoOrgError,
} from '../src/lib/demo/guards';

interface BootstrapResult {
  demoOrgId: string;
  demoUserId: string;
  created: { org: boolean; user: boolean; membership: boolean; subscription: boolean };
}

export async function bootstrapDemo(): Promise<BootstrapResult> {
  // ── 1. Demo Organization (find-or-create by marker) ──────────────────────
  const existingDemo = await db.organization.findFirst({
    where: { isDemo: true },
    select: { id: true, slug: true, deploymentMode: true, status: true },
  });

  let orgId: string;
  let orgCreated = false;

  if (existingDemo) {
    // Reuse — but only if it is still a healthy demo tenant. Reconcile the
    // mutable fields instead of failing: the bootstrap is the only writer of
    // this row's demo identity.
    const patch: Record<string, unknown> = {};
    if (existingDemo.slug !== DEMO_ORG_SLUG) patch.slug = DEMO_ORG_SLUG;
    if (existingDemo.deploymentMode !== 'MANAGED') patch.deploymentMode = 'MANAGED';
    if (existingDemo.status !== 'active') patch.status = 'active';
    if (Object.keys(patch).length > 0) {
      await db.organization.update({ where: { id: existingDemo.id }, data: patch });
    }
    orgId = existingDemo.id;
  } else {
    // No demo org yet. Guard against a slug collision with a REAL customer
    // org (someone may have created 'omnisight-demo' before this feature):
    // fail loudly rather than mutate a customer's organization.
    const slugOwner = await db.organization.findUnique({
      where: { slug: DEMO_ORG_SLUG },
      select: { id: true, name: true },
    });
    if (slugOwner) {
      throw new Error(
        `Slug "${DEMO_ORG_SLUG}" is already used by organization "${slugOwner.name}" (${slugOwner.id}). ` +
          'Rename that organization or change DEMO_ORG_SLUG in src/lib/demo/guards.ts.'
      );
    }
    const org = await db.organization.create({
      data: {
        name: DEMO_ORG_NAME,
        slug: DEMO_ORG_SLUG,
        email: DEMO_USER_EMAIL,
        timezone: DEMO_ORG_TIMEZONE,
        status: 'active',
        deploymentMode: 'MANAGED',
        isDemo: true,
      },
      select: { id: true },
    });
    orgId = org.id;
    orgCreated = true;
  }

  // Every subsequent write asserts it targets the demo org (fail-closed).
  const demo = await assertDemoOrg(orgId);

  // ── 2. Demo user (find-or-create by email) ───────────────────────────────
  // role='user' (NOT super_admin — the user must never hold platform power);
  // organizationId set for the legacy single-org fallback path.
  const existingUser = await db.appUser.findUnique({
    where: { email: DEMO_USER_EMAIL },
    select: { id: true, role: true, organizationId: true, isActive: true },
  });

  let userId: string;
  let userCreated = false;
  if (existingUser) {
    // Reconcile: never super_admin, bound to the demo org, active, and not
    // gated behind the first-login password change (the demo mints sessions
    // directly and must land straight in the dashboard).
    const patch: Record<string, unknown> = {};
    if (existingUser.role !== 'user') patch.role = 'user';
    if (existingUser.organizationId !== demo.id) patch.organizationId = demo.id;
    if (!existingUser.isActive) patch.isActive = true;
    if (Object.keys(patch).length > 0) {
      await db.appUser.update({ where: { id: existingUser.id }, data: patch });
    }
    userId = existingUser.id;
  } else {
    // Password: env-provided or random (12+ chars, mixed case + digit to
    // satisfy any future direct-login policy). Hashed, never printed.
    const password =
      demoUserPassword() ??
      `D${randomBytes(12).toString('base64url')}a9`;
    const user = await db.appUser.create({
      data: {
        email: DEMO_USER_EMAIL,
        name: DEMO_USER_NAME,
        password: hashPasswordSync(password),
        role: 'user',
        isActive: true,
        mustChangePassword: false,
        organizationId: demo.id,
      },
      select: { id: true },
    });
    userId = user.id;
    userCreated = true;
  }

  // ── 3. ACTIVE membership (role: org_admin — the Organization Admin view:
  //       the fullest feature surface a demo visitor can see, incl. Users,
  //       Settings, Security, AI Provider. NOT super_admin — platform/control-
  //       plane surfaces stay out of navigation naturally). ───────────────
  const membership = await db.organizationMembership.findUnique({
    where: { userId_organizationId: { userId, organizationId: demo.id } },
    select: { id: true, role: true, status: true },
  });
  let membershipCreated = false;
  if (membership) {
    const patch: Record<string, unknown> = {};
    if (membership.role !== 'org_admin') patch.role = 'org_admin';
    if (membership.status !== 'ACTIVE') patch.status = 'ACTIVE';
    if (Object.keys(patch).length > 0) {
      await db.organizationMembership.update({ where: { id: membership.id }, data: patch });
    }
  } else {
    await db.organizationMembership.create({
      data: { userId, organizationId: demo.id, role: 'org_admin', status: 'ACTIVE' },
    });
    membershipCreated = true;
  }

  // ── 4. Fictional ACTIVE subscription (Phase 6) ───────────────────────────
  // Keeps subscription-sweep from pausing the demo org and gives plan-based
  // retention (365d screenshots). NEVER billable: no Invoice, no PaymentRecord,
  // no PurchaseRequest is created; endDate far-future; no payment fields.
  let subscriptionCreated = false;
  let subscriptionId: string | null = null;
  const activeSub = await db.subscription.findFirst({
    where: {
      organizationId: demo.id,
      status: 'ACTIVE',
      OR: [{ endDate: null }, { endDate: { gt: new Date() } }],
    },
    select: { id: true },
  });
  if (activeSub) {
    subscriptionId = activeSub.id;
  } else {
    // Use the built-in Business plan catalog entry (seeded by src/lib/seed.ts
    // / production bootstrap of plans). Fall back to any active plan so the
    // bootstrap never fails on a missing catalog name.
    const plan =
      (await db.plan.findUnique({ where: { name: 'Business' }, select: { id: true } })) ??
      (await db.plan.findFirst({ where: { isActive: true }, select: { id: true } }));
    if (!plan) {
      throw new Error(
        'No Plan catalog entry exists. Run the plan bootstrap (scripts/bootstrap-super-admin.ts or db:seed:dev) before bootstrapping the demo.'
      );
    }
    const sub = await db.subscription.create({
      data: {
        organizationId: demo.id,
        planId: plan.id,
        status: 'ACTIVE',
        startDate: new Date(),
        endDate: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000), // 100y — never expires in practice
        notes: 'Demo tenant — fictional subscription, never billed.',
      },
      select: { id: true },
    });
    subscriptionId = sub.id;
    subscriptionCreated = true;
  }

  // 5. Self-heal: link the CURRENT-subscription pointer and reactivate the
  //    org. The subscription-sweep job reads `org.subscription` (resolved via
  //    Organization.subscriptionId) — an orphaned Subscription row leaves the
  //    pointer null, the sweep sees "no active subscription", pauses the demo
  //    org, and resolveDemoOrganization() then fails NOT_ACTIVE → the public
  //    /api/demo/enter path 503s. Idempotent on every bootstrap run.
  if (subscriptionId) {
    const currentOrg = await db.organization.findUnique({
      where: { id: demo.id },
      select: { subscriptionId: true, status: true },
    });
    if (currentOrg && (currentOrg.subscriptionId !== subscriptionId || currentOrg.status !== 'active')) {
      await db.organization.update({
        where: { id: demo.id },
        data: { subscriptionId, status: 'active' },
      });
    }
  }

  return {
    demoOrgId: demo.id,
    demoUserId: userId,
    created: { org: orgCreated, user: userCreated, membership: membershipCreated, subscription: subscriptionCreated },
  };
}

// ─── CLI entry ──────────────────────────────────────────────────────────────
const isMain = process.argv[1]?.endsWith('bootstrap-demo.ts');

if (isMain) {
  bootstrapDemo()
    .then((r) => {
      console.log('✅ Demo bootstrap complete (idempotent).');
      console.log(`   Demo organization: ${r.demoOrgId}${r.created.org ? ' (created)' : ' (reused)'}`);
      console.log(`   Demo user:         ${r.demoUserId}${r.created.user ? ' (created)' : ' (reused)'}`);
      if (r.created.membership) console.log('   Membership:        created (org_admin/ACTIVE)');
      if (r.created.subscription) console.log('   Subscription:      created (fictional ACTIVE)');
      console.log('   Next: run the demo seeder to populate the deterministic dataset.');
    })
    .catch((e) => {
      if (e instanceof DemoOrgError) {
        console.error('❌ Demo bootstrap failed (fail-closed):', e.message);
      } else {
        console.error('❌ Demo bootstrap failed:', e);
      }
      process.exit(1);
    })
    .finally(async () => {
      await db.$disconnect();
    });
}
