const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  try {
    const tables = await db.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    console.log('Tables:', JSON.stringify(tables.map(t => t.table_name)));
    
    const guestExists = tables.some(t => t.table_name === 'Guest');
    console.log('Guest table exists:', guestExists);
    
    if (guestExists) {
      const count = await db.$queryRaw`SELECT count(*)::int as count FROM "Guest"`;
      console.log('Guest records:', count[0].count);
    }
    
    // Check Employee.guestId column
    const cols = await db.$queryRaw`SELECT column_name FROM information_schema.columns WHERE table_name = 'Employee' AND column_name = 'guestId'`;
    console.log('Employee.guestId column exists:', cols.length > 0);
    
    const empCount = await db.employee.count();
    console.log('Employee count:', empCount);
    
    const orgCount = await db.organization.count();
    console.log('Organization count:', orgCount);
    
    const devCount = await db.device.count();
    console.log('Device count:', devCount);
    
    // Test basic CRUD
    console.log('\n--- CRUD Tests ---');
    
    // Create organization
    const org = await db.organization.create({ data: { name: 'TestOrg-Verify', slug: 'testorg-verify-' + Date.now() } });
    console.log('Create org: PASS (id=' + org.id.slice(0, 8) + ')');
    
    // Create employee
    const emp = await db.employee.create({ data: { employeeId: 'EMP-VERIFY-' + Date.now(), firstName: 'Test', lastName: 'User', email: 'test-verify-' + Date.now() + '@test.com', organizationId: org.id } });
    console.log('Create employee: PASS (id=' + emp.id.slice(0, 8) + ')');
    
    // Create device
    const dev = await db.device.create({ data: { name: 'TestDevice-Verify', organizationId: org.id, employeeId: emp.id, status: 'online' } });
    console.log('Create device: PASS (id=' + dev.id.slice(0, 8) + ')');
    
    // Read organization
    const readOrg = await db.organization.findUnique({ where: { id: org.id }, include: { employees: true, devices: true } });
    console.log('Read org with relations: PASS (employees=' + readOrg.employees.length + ', devices=' + readOrg.devices.length + ')');
    
    // Update employee
    const updEmp = await db.employee.update({ where: { id: emp.id }, data: { firstName: 'Updated' } });
    console.log('Update employee: PASS');
    
    // Delete test data
    await db.device.delete({ where: { id: dev.id } });
    await db.employee.delete({ where: { id: emp.id } });
    await db.organization.delete({ where: { id: org.id } });
    console.log('Delete test data: PASS');
    
    console.log('\nAll CRUD tests PASSED');
  } catch(e) { console.error('ERROR:', e.message); }
  finally { await db.$disconnect(); }
})();
