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

export type NavMinRole = 'viewer' | 'manager' | 'org_admin' | 'super_admin';

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
  // org_admin+ — audio transcription management
  audio: 'org_admin',
  // manager+ — consent exposes org-wide employee PII (matches /api/consent)
  consent: 'manager',
  // manager+
  reports: 'manager',
  'daily-report': 'manager',
  'self-portal': 'manager',
  // org_admin+
  'ai-provider': 'org_admin',
  'agent-approvals': 'org_admin',
  organization: 'org_admin',
  users: 'org_admin',
  security: 'org_admin',
  settings: 'org_admin',
  // Super Admin Control Center pages — require exact super_admin role
  'super-admin-organizations': 'super_admin',
  'super-admin-organization-detail': 'super_admin',
  'sa-overview': 'super_admin',
  // Unified packages & pricing configuration — super_admin only.
  'sa-packages-pricing': 'super_admin',
  // Full provisioning flow (org + package + admin + subscription + license)
  // — platform-level, super_admin only.
  'sa-create-organization': 'super_admin',
  // Public landing page content editor — super_admin only.
  'sa-landing': 'super_admin',
  // Control-plane audit log viewer — super_admin only. Reached from Overview
  // (Recent Activity → View Audit Logs); NOT a primary sidebar item.
  'sa-audit': 'super_admin',
  // Branding: org_admin+ for org branding, super_admin for platform branding
  branding: 'org_admin',
  // URL-routed external page (rendered outside the SPA shell)
  billing: 'org_admin',
  // Organization Admin data infrastructure configuration (DB + Storage)
  'data-infrastructure': 'org_admin',
  // Super Admin infrastructure change request queue
  'sa-infra-requests': 'super_admin',
  // V1 purchase review queue — super_admin only.
  'sa-purchase-requests': 'super_admin',
};

/**
 * Whether a user with `role` may navigate to `page`.
 * Unknown roles are denied; super_admin/org_admin/manager satisfy every gate
 * via the shared role hierarchy.
 */
export function canAccessPage(role: string | null | undefined, page: PageType): boolean {
  if (!role) return false;
  const minRole = PAGE_MIN_ROLE[page];
  if (!minRole) return false;
  return hasRolePermission(role, minRole);
}
