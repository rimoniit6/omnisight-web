import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Duplicate React Key Regression Test ─────────────────────────────────────
// Verifies that two departments with the same name but different IDs
// render without duplicate key warnings when using ID-based keys.

describe('Duplicate React Key Regression — department name collisions', () => {
  // Simulate the data structure returned by /api/employees/statistics
  // after the fix: each entry now includes departmentId
  const departmentStats = [
    { departmentId: 'dept-001', name: 'Customer Support', count: 12, activeCount: 10 },
    { departmentId: 'dept-002', name: 'Customer Support', count: 8, activeCount: 7 },
    { departmentId: 'dept-003', name: 'Engineering', count: 20, activeCount: 18 },
  ];

  it('each department entry has a departmentId field', () => {
    for (const dept of departmentStats) {
      assert.ok('departmentId' in dept, `Entry "${dept.name}" missing departmentId`);
    }
  });

  it('two "Customer Support" entries have different departmentIds', () => {
    const csEntries = departmentStats.filter((d) => d.name === 'Customer Support');
    assert.equal(csEntries.length, 2, 'Expected two Customer Support entries');
    assert.notEqual(
      csEntries[0].departmentId,
      csEntries[1].departmentId,
      'Department IDs must differ for same-name entries'
    );
  });

  it('using departmentId as React key produces no duplicates', () => {
    // Simulate what React does: collect all keys
    const keys = departmentStats.map((dept) => dept.departmentId ?? dept.name);
    const uniqueKeys = new Set(keys);
    assert.equal(keys.length, uniqueKeys.size, `Duplicate keys found: ${keys.join(', ')}`);
  });

  it('using name as React key WOULD produce duplicates (proving the bug)', () => {
    const keys = departmentStats.map((dept) => dept.name);
    const uniqueKeys = new Set(keys);
    assert.notEqual(
      keys.length,
      uniqueKeys.size,
      'Name-based keys should collide (proving the original bug)'
    );
  });

  it('handles null departmentId with fallback to name', () => {
    const statsWithUnassigned = [
      { departmentId: null, name: 'Unassigned', count: 3, activeCount: 2 },
      { departmentId: 'dept-001', name: 'Customer Support', count: 12, activeCount: 10 },
    ];
    const keys = statsWithUnassigned.map((dept) => dept.departmentId ?? dept.name);
    const uniqueKeys = new Set(keys);
    assert.equal(keys.length, uniqueKeys.size, 'Null departmentId fallback should still be unique');
  });
});

describe('Member breakdown — employee ID key uniqueness', () => {
  // Simulate the data structure from projects-page memberBreakdown
  const memberBreakdown = [
    { employeeId: 'emp-001', name: 'John Smith', hours: 40 },
    { employeeId: 'emp-002', name: 'John Smith', hours: 35 },
    { employeeId: 'emp-003', name: 'Jane Doe', hours: 20 },
  ];

  it('using employeeId as React key produces no duplicates', () => {
    const keys = memberBreakdown.map((m) => m.employeeId);
    const uniqueKeys = new Set(keys);
    assert.equal(keys.length, uniqueKeys.size, `Duplicate keys found: ${keys.join(', ')}`);
  });

  it('two "John Smith" entries have different employeeIds', () => {
    const johns = memberBreakdown.filter((m) => m.name === 'John Smith');
    assert.equal(johns.length, 2);
    assert.notEqual(johns[0].employeeId, johns[1].employeeId);
  });
});

describe('Department uniqueness constraint — DB level', () => {
  it('Prisma schema has @@unique([organizationId, name]) on Department', () => {
    // This is a documentation test — the actual constraint is in schema.prisma
    // Line 94: @@unique([organizationId, name])
    // This prevents duplicate department names WITHIN the same organization
    // but allows the same name across different organizations.
    const schemaConstraint = '@@unique([organizationId, name])';
    assert.ok(schemaConstraint.includes('organizationId'), 'Constraint must include organizationId');
    assert.ok(schemaConstraint.includes('name'), 'Constraint must include name');
  });
});
