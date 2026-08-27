// Migrate legacy AppUser.organizationId / AppUser.role into the authoritative
// OrganizationMembership table.
//
// Safe to run repeatedly: uses upsert on the compound-unique
// [userId, organizationId], so re-running never creates duplicates and never
// overwrites an existing membership's role/status (only backfills missing ones).
//
// Run:  node scripts/migrate-legacy-memberships.mjs
// (or:  npx tsx scripts/migrate-legacy-memberships.mjs)

import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const users = await db.appUser.findMany({
    where: { organizationId: { not: null } },
    select: { id: true, organizationId: true, role: true },
  });

  console.log(`[migrate] found ${users.length} users with a legacy organizationId`);

  let created = 0;
  let skipped = 0;
  for (const u of users) {
    if (!u.organizationId) continue;

    const existing = await db.organizationMembership.findUnique({
      where: { userId_organizationId: { userId: u.id, organizationId: u.organizationId } },
    });
    if (existing) {
      skipped++;
      continue;
    }

    // Backfill only when the target organization still exists.
    const org = await db.organization.findUnique({ where: { id: u.organizationId } });
    if (!org) {
      console.warn(`[migrate] skip ${u.id}: organization ${u.organizationId} missing`);
      skipped++;
      continue;
    }

    // super_admin is a global role — do not create a per-org membership for it.
    if (u.role === 'super_admin') {
      skipped++;
      continue;
    }

    await db.organizationMembership.create({
      data: {
        userId: u.id,
        organizationId: u.organizationId,
        role: u.role,
        status: 'ACTIVE',
      },
    });
    created++;
  }

  console.log(`[migrate] created ${created} memberships, skipped ${skipped}`);
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
