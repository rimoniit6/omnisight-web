/**
 * Navigation permission mapping (S-2).
 *
 * The SINGLE source of truth for which pages each role may see in the
 * sidebar. API RBAC remains the authoritative security boundary — this UI
 * filtering is UX protection only.
 *
 *   viewer        → sees the monitoring/analytics surface (no admin, no reports)
 *   manager+      → additionally Reports, Daily Report, Employee Portal
 *   org_admin+    → additionally Settings, AI Provider, Agent Approvals,
 *                   Organization, Security
 *   super_admin   → highest permission level (all pages + platform admin)
 */
import type { PageType } from '@/lib/store';
import { hasRolePermission } from '@/lib/auth';

export type NavMinRole = 'viewer' | 'manager' | 'admin' | 'org_admin';

export const PAGE_MIN_ROLE: Record<PageType, NavMinRole> = {
  // viewer — monitoring / analytics surface
  dashboard: 'viewer',
  employees: 'viewer',
  'employee-details': 'viewer',
  departments: 'viewer',
  devices: 'viewer',
  activities: 'viewer',
  analytics: 'viewer',
  insights: 'viewer',
  notifications: 'viewer',
  alerts: 'viewer',
  // S-05: audit logs carry security telemetry (hostnames, employee codes,
  // IPs, admin emails) — manager+ like the export endpoint, not viewer.
  audit: 'manager',
  screenshots: 'viewer',
  'break-status': 'viewer',
  'live-monitor': 'viewer',
  policies: 'viewer',
  anomalies: 'viewer',
  projects: 'viewer',
  sentiment: 'viewer',
  // admin+ — audio transcription management
  audio: 'admin',
  // manager+ — consent exposes org-wide employee PII (matches /api/consent)
  consent: 'manager',
  // manager+
  reports: 'manager',
  'daily-report': 'manager',
  'self-portal': 'manager',
  // org_admin+
  'ai-provider': 'org_admin',
  'agent-approvals': 'org_admin',
  guests: 'org_admin',
  organization: 'org_admin',
  security: 'org_admin',
  settings: 'org_admin',
  // Super Admin pages — only super_admin role can access
  'super-admin-organizations': 'org_admin',
  'super-admin-organization-detail': 'org_admin',
};

/**
 * Whether a user with `role` may navigate to `page`.
 * Unknown roles are denied; super_admin/org_admin/manager satisfy every gate
 * via the shared role hierarchy.
 *
 * Special case: super-admin-* pages require EXACTLY super_admin (not just
 * org_admin+ hierarchy) because they are platform management, not org management.
 */
export function canAccessPage(role: string | null | undefined, page: PageType): boolean {
  if (!role) return false;
  // Super Admin pages are restricted to super_admin only
  if (page === 'super-admin-organizations' || page === 'super-admin-organization-detail') {
    return role === 'super_admin';
  }
  const minRole = PAGE_MIN_ROLE[page];
  if (!minRole) return false;
  return hasRolePermission(role, minRole);
}
