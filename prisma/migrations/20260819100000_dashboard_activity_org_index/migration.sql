-- Dashboard performance: composite index covering the join-through-Employee
-- activity queries (dashboard route fetches activities scoped by organizationId
-- with a time range). This index accelerates the "Activity WHERE employeeId IN
-- (SELECT id FROM Employee WHERE organizationId = X) AND timestamp >= Y" pattern
-- by allowing PostgreSQL to seek directly to matching activities per employee.
CREATE INDEX "Activity_employeeId_timestamp_category_idx"
  ON "Activity" ("employeeId", "timestamp", "category");
