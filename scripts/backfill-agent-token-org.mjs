/**
 * Backfill AgentToken.organizationId from Employee.organizationId.
 *
 * Safe to run repeatedly: only touches tokens where organizationId IS NULL.
 * Reports orphaned tokens (Employee also missing orgId) without assigning
 * an arbitrary organization.
 *
 * Run: node scripts/backfill-agent-token-org.mjs
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  // 1. Find tokens with NULL organizationId
  const nullTokens = await db.agentToken.findMany({
    where: { organizationId: null },
    include: { employee: { select: { id: true, organizationId: true } } },
  });

  console.log(`[backfill] found ${nullTokens.length} AgentToken rows with NULL organizationId`);

  if (nullTokens.length === 0) {
    console.log('[backfill] nothing to backfill');
    return;
  }

  // 2. Separate backfillable from orphaned
  const backfillable = [];
  const orphaned = [];

  for (const token of nullTokens) {
    if (token.employee?.organizationId) {
      backfillable.push(token);
    } else {
      orphaned.push(token);
    }
  }

  console.log(`[backfill] ${backfillable.length} can be backfilled, ${orphaned.length} orphaned`);

  // 3. Report orphans (do NOT silently assign)
  if (orphaned.length > 0) {
    console.error('[backfill] ORPHANED TOKENS (employee has no organizationId):');
    for (const token of orphaned) {
      console.error(`  token=${token.id} employeeId=${token.employeeId}`);
    }
    console.error('[backfill] These tokens will be deleted as they cannot be bound to an organization.');
    // Delete orphaned tokens — they cannot function without an organization
    for (const token of orphaned) {
      await db.agentToken.delete({ where: { id: token.id } });
    }
    console.log(`[backfill] deleted ${orphaned.length} orphaned tokens`);
  }

  // 4. Backfill valid tokens
  let updated = 0;
  for (const token of backfillable) {
    await db.agentToken.update({
      where: { id: token.id },
      data: { organizationId: token.employee.organizationId },
    });
    updated++;
  }

  console.log(`[backfill] updated ${updated} tokens with organizationId`);

  // 5. Verify no nulls remain
  const remaining = await db.agentToken.count({ where: { organizationId: null } });
  console.log(`[backfill] remaining NULL organizationId: ${remaining}`);
  if (remaining > 0) {
    console.error('[backfill] ERROR: Some tokens still have NULL organizationId');
    process.exit(1);
  }

  console.log('[backfill] done');
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await db.$disconnect();
    process.exit(1);
  });
