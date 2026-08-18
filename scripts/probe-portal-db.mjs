import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

(async () => {
  const emp = await p.employee.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!emp) { console.log('NO EMPLOYEES'); await p.$disconnect(); return; }
  const eid = emp.id;
  console.log('EMPLOYEE:', JSON.stringify({ id: eid, employeeId: emp.employeeId, name: `${emp.firstName} ${emp.lastName}`, org: emp.organizationId, status: emp.status, designation: emp.designation, departmentId: emp.departmentId }));

  const devices = await p.device.findMany({
    where: { employeeId: eid },
    select: { id: true, name: true, status: true, lastHeartbeat: true, agentVersion: true, hostname: true },
  });
  console.log('DEVICES:', JSON.stringify(devices));

  const now = new Date();
  const utcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dhakaStart = new Date(utcStart.getTime() + 6 * 3600 * 1000); // Asia/Dhaka UTC+6

  const [actUtc, actDhaka, actAll] = await Promise.all([
    p.activity.findMany({ where: { employeeId: eid, timestamp: { gte: utcStart } }, select: { id: true, type: true, category: true, duration: true, timestamp: true }, orderBy: { timestamp: 'asc' } }),
    p.activity.findMany({ where: { employeeId: eid, timestamp: { gte: dhakaStart } }, select: { id: true, type: true, category: true, duration: true, timestamp: true }, orderBy: { timestamp: 'asc' } }),
    p.activity.groupBy({ by: ['category'], where: { employeeId: eid }, _count: { _all: true }, _sum: { duration: true } }),
  ]);
  console.log('ACTIVITY_TODAY_UTC:', JSON.stringify({ count: actUtc.length, first: actUtc[0]?.timestamp, last: actUtc[actUtc.length - 1]?.timestamp, sumDuration: actUtc.reduce((s, a) => s + (a.duration || 0), 0) }));
  console.log('ACTIVITY_TODAY_DHAKA:', JSON.stringify({ count: actDhaka.length, first: actDhaka[0]?.timestamp, last: actDhaka[actDhaka.length - 1]?.timestamp, sumDuration: actDhaka.reduce((s, a) => s + (a.duration || 0), 0) }));
  console.log('ACTIVITY_BY_CATEGORY_ALL:', JSON.stringify(actAll));

  // last 7 days (UTC) and 14 days for weekly productivity
  const d7 = new Date(utcStart.getTime() - 6 * 86400 * 1000);
  const d14 = new Date(utcStart.getTime() - 13 * 86400 * 1000);
  const [c7, c14] = await Promise.all([
    p.activity.groupBy({ by: ['category'], where: { employeeId: eid, timestamp: { gte: d7 } }, _count: { _all: true }, _sum: { duration: true } }),
    p.activity.groupBy({ by: ['category'], where: { employeeId: eid, timestamp: { gte: d14 } }, _count: { _all: true }, _sum: { duration: true } }),
  ]);
  console.log('ACTIVITY_BY_CATEGORY_7D:', JSON.stringify(c7));
  console.log('ACTIVITY_BY_CATEGORY_14D:', JSON.stringify(c14));

  const consent = await p.consent.findMany({ where: { employeeId: eid }, select: { consentType: true, status: true, grantedAt: true, revokedAt: true, expiresAt: true, policyId: true } });
  console.log('CONSENT:', JSON.stringify({ count: consent.length, granted: consent.filter((c) => c.status === 'granted').length, rows: consent }));

  const projects = await p.projectMember.findMany({ where: { employeeId: eid }, include: { project: { select: { id: true, name: true, status: true } } } });
  console.log('PROJECT_MEMBERS:', JSON.stringify(projects));
  const timeEntries = await p.timeEntry.count({ where: { employeeId: eid } });
  console.log('TIME_ENTRIES:', timeEntries);

  // organization timezone + monitoring settings
  const org = await p.organization.findUnique({ where: { id: emp.organizationId }, select: { name: true, timezone: true } });
  console.log('ORG:', JSON.stringify(org));
  const settings = await p.organizationSetting.findMany({ where: { organizationId: emp.organizationId }, select: { key: true, value: true, enabled: true } });
  console.log('ORG_SETTINGS:', JSON.stringify(settings));

  await p.$disconnect();
})();
