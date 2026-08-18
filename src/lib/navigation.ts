/**
 * Navigation permission mapping (S-2).
 *
 * The SINGLE source of truth for which pages each role may see in the
 * sidebar. API RBAC remains the authoritative security boundary — this UI
 * filtering is UX protection only.
 *
 *   viewer       → sees the monitoring/analytics surface (no admin, no reports)
 *   manager+     → additionally Reports, Daily Report, Employee Portal
 *   admin+       → additionally Settings, AI Provider, Agent Approvals,
 *                  Organization, Security
 *   super_admin  → highest permission level (all pages)
 */
import type { PageType } from '@/lib/store';
import { hasRolePermission } from '@/lib/auth';

export type NavMinRole = 'viewer' | 'manager' | 'admin';

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
  // manager+ — consent exposes org-wide employee PII (matches /api/consent)
  consent: 'manager',
  // manager+
  reports: 'manager',
  'daily-report': 'manager',
  'self-portal': 'manager',
  // admin+
  'ai-provider': 'admin',
  'agent-approvals': 'admin',
  guests: 'admin',
  organization: 'admin',
  security: 'admin',
  settings: 'admin',
};

/**
 * Whether a user with `role` may navigate to `page`.
 * Unknown roles are denied; super_admin/owner/admin satisfy every gate via
 * the shared role hierarchy.
 */
export function canAccessPage(role: string | null | undefined, page: PageType): boolean {
  if (!role) return false;
  const minRole = PAGE_MIN_ROLE[page];
  if (!minRole) return false;
  return hasRolePermission(role, minRole);
}

/** Filter a list of pages down to those the role may access. */
export function filterPagesByRole(role: string | null | undefined, pages: PageType[]): PageType[] {
  return pages.filter((p) => canAccessPage(role, p));
}
