import { PrismaClient } from '@prisma/client';

// PostgreSQL is the only database. Falls back to the local dev instance when
// run outside Next.js (which loads .env automatically).
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/workai?schema=public';

const db = new PrismaClient();

async function main() {
  const [orgs, depts, emps, devices, users] = await Promise.all([
    db.organization.findMany({ select: { id: true, name: true, status: true } }),
    db.department.findMany({ select: { id: true, name: true, organizationId: true } }),
    db.employee.findMany({
      select: {
        id: true, employeeId: true, firstName: true, lastName: true, email: true,
        status: true, designation: true, departmentId: true, organizationId: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    }),
    db.device.groupBy({ by: ['status'], _count: { id: true } }),
    db.appUser.findMany({ select: { email: true, role: true, organizationId: true } }),
  ]);

  console.log('ORGS:', JSON.stringify(orgs, null, 1));
  console.log('DEPTS:', JSON.stringify(depts, null, 1));
  console.log('DEPARTMENT MANAGERS:', JSON.stringify(
    await db.employee.findMany({ where: { departmentAsManager: { some: {} } }, select: { id: true, firstName: true } })
  ));
  const statusGroup = await db.employee.groupBy({ by: ['status'], _count: { id: true } });
  console.log('EMPLOYEE STATUS COUNTS:', JSON.stringify(statusGroup));
  console.log('EMPLOYEE TOTAL:', await db.employee.count());
  console.log('DEVICES:', JSON.stringify(devices));
  console.log('SAMPLE EMPLOYEES:', JSON.stringify(emps, null, 1));
  console.log('APP USERS:', JSON.stringify(users, null, 1));
}

main().finally(() => db.$disconnect());
