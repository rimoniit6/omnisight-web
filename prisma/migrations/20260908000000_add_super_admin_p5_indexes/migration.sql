-- P5: Super Admin control-plane query indexes (super-admin-hardening cycle).
-- Non-destructive — index creation only, no data changes.

-- AuditLog: the global SA audit browse (/api/super-admin/audit) filters by
-- optional action and ALWAYS orders by createdAt DESC with no organization
-- filter (per-org views already use the (organizationId, createdAt) index).
-- Without a plain createdAt index every page is a full scan + sort.
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- Subscription: getActiveSubscription() runs on every authenticated request
-- (org + ACTIVE + newest). Composite covers the lookup + ordering.
CREATE INDEX "Subscription_organizationId_status_createdAt_idx" ON "Subscription"("organizationId", "status", "createdAt");

-- Invoice: the admin list supports ?status and ?organizationId filters, newest
-- first. Composites serve the global and org-scoped status views.
CREATE INDEX "Invoice_status_createdAt_idx" ON "Invoice"("status", "createdAt");
CREATE INDEX "Invoice_organizationId_status_createdAt_idx" ON "Invoice"("organizationId", "status", "createdAt");