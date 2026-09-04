// OmniSight — Central role/access matrix (Phase 2, §32).
//
// Authoritative summary of who may do what. API routes enforce this
// server-side (control-plane.ts, tenant-db.ts, api.ts); this module is the
// single documented reference and provides the mode predicate. UI role
// checks are UX-only and must never be treated as the security boundary.

import { allowsSuperAdminTenantAccess, type DeploymentMode } from '@/lib/deployment-mode';

export type Capability =
  | 'control_plane_org_management'
  | 'package_management'
  | 'subscription_management'
  | 'payment_records'
  | 'license_management'
  | 'managed_tenant_data'
  | 'customer_tenant_data'
  | 'org_member_management';

export type Role = 'super_admin' | 'org_admin' | 'manager' | 'viewer' | 'employee';

/**
 * Static matrix: YES = allowed, NO = denied, SCOPED = allowed within the
 * caller's own organization and role permissions. Super Admin tenant-data
 * cells are mode-dependent — see canSuperAdminAccessTenantData().
 */
export const ACCESS_MATRIX: Record<Capability, Record<Role, 'YES' | 'NO' | 'SCOPED'>> = {
  control_plane_org_management: { super_admin: 'YES', org_admin: 'NO', manager: 'NO', viewer: 'NO', employee: 'NO' },
  package_management: { super_admin: 'YES', org_admin: 'NO', manager: 'NO', viewer: 'NO', employee: 'NO' },
  subscription_management: { super_admin: 'YES', org_admin: 'SCOPED', manager: 'NO', viewer: 'NO', employee: 'NO' },
  payment_records: { super_admin: 'YES', org_admin: 'SCOPED', manager: 'NO', viewer: 'NO', employee: 'NO' },
  license_management: { super_admin: 'YES', org_admin: 'NO', manager: 'NO', viewer: 'NO', employee: 'NO' },
  // NOTE: super_admin tenant-data rows are mode-gated (MANAGED only).
  managed_tenant_data: { super_admin: 'YES', org_admin: 'SCOPED', manager: 'SCOPED', viewer: 'SCOPED', employee: 'SCOPED' },
  customer_tenant_data: { super_admin: 'NO', org_admin: 'SCOPED', manager: 'SCOPED', viewer: 'SCOPED', employee: 'SCOPED' },
  org_member_management: { super_admin: 'YES', org_admin: 'SCOPED', manager: 'SCOPED', viewer: 'NO', employee: 'NO' },
};

/**
 * Super Admin operational-data access for one organization in the given
 * deployment mode. CUSTOMER_DB / PRIVATE (and any unresolvable mode) deny.
 */
export function canSuperAdminAccessTenantData(mode: DeploymentMode): boolean {
  return allowsSuperAdminTenantAccess(mode);
}

/** Human-readable policy line for UI banners and audit descriptions. */
export function tenantAccessPolicyLine(mode: DeploymentMode): string {
  switch (mode) {
    case 'MANAGED':
      return 'OmniSight-managed environment — Super Admin operational access permitted.';
    case 'CUSTOMER_DB':
      return 'Customer-owned database — Super Admin access is limited to control-plane management.';
    case 'PRIVATE':
      return 'Private deployment hosted in customer infrastructure — operational data is not accessible from the central console.';
  }
}
