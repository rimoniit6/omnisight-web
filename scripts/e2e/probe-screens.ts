import 'dotenv/config';
import { db } from '@/lib/db';

async function main() {
  const rows = await db.screenshot.findMany({
    where: { organizationId: { in: ['org-e2e-mgmt', 'org-e2e-cust'] } },
    orderBy: { createdAt: 'desc' },
    take: 8,
    select: { organizationId: true, filePath: true, fileName: true, width: true, height: true, capturedAt: true, processingStatus: true },
  });
  console.log(JSON.stringify(rows, null, 1));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.$disconnect(); });