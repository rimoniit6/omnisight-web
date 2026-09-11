/**
 * Sidebar navigation structure — SINGLE source of truth shared by the desktop
 * shell (app-sidebar) and the mobile drawer (mobile-sidebar).
 *
 * Role gating stays in lib/navigation.ts (canAccessPage / PAGE_MIN_ROLE); this
 * module only declares WHAT the navigation contains. The two shells must never
 * drift apart, so tests import navGroups directly to prove structure:
 *   • exactly one Organizations entry for the platform (super admin)
 *   • no lead-inbox / payment-verification / platform-ops entries
 *   • the Super Admin surface is Organizations-centric: Overview,
 *     Organizations, Packages (reusable catalog), Landing Page — while
 *     Subscriptions / Manual Payments / Licenses live INSIDE each
 *     Organization (org detail), not as standalone menus.
 */
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  Users,
  Building2,
  Monitor,
  Activity,
  Camera,
  Mic,
  Pause,
  Radio,
  BarChart3,
  Brain,
  Bot,
  Bell,
  AlertTriangle,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  FileCheck,
  UserCircle,
  FolderKanban,
  HeartPulse,
  Crown,
  Palette,
  Package,
  FileText,
  Settings,
  FileBarChart,
  Globe,
  ServerCog,
  ClipboardList,
  ShoppingBag,
} from 'lucide-react';
import type { PageType } from '@/lib/store';
import { canAccessPage } from '@/lib/navigation';

export interface NavItem {
  page: PageType;
  label: string;
  icon: LucideIcon;
  /** Render a count badge on the item (desktop shell only). */
  showBadge?: boolean;
  /** URL-routed page rendered outside the SPA shell (e.g. /dashboard/billing). */
  href?: string;
}

export interface NavGroup {
  /** Stable unique key (section labels repeat across tenant/platform groups). */
  id: string;
  section: string;
  items: NavItem[];
}

/**
 * Org-consolidation rule: for the platform (super_admin) role the tenant
 * "Organization" settings page is superseded by the Control Center's single
 * authoritative "Organizations" entry. org_admin/manager keep their own
 * workspace settings page. Kept here (not in navigation.ts) because this is a
 * shell-visibility rule, not a permission gate — API RBAC is unchanged.
 */
export const PLATFORM_SUPERSEDED_PAGES: ReadonlySet<PageType> = new Set(['organization']);

/**
 * Tenant self-service billing surfaces hidden from the shell (manual sales
 * model: the Super Admin records payments; there is no tenant checkout in the
 * normal workflow). Pages/APIs remain reachable by URL for support — this is
 * navigation cleanup only, not an authorization change.
 */
const HIDDEN_TENANT_PAGES: ReadonlySet<PageType> = new Set(['billing']);

/**
 * Whether `role` may see `page` in the sidebar shells. Combines the
 * navigation permission gate with shell-specific supersession rules.
 */
export function canAccessShellItem(role: string | null | undefined, page: PageType): boolean {
  if (role === 'super_admin' && PLATFORM_SUPERSEDED_PAGES.has(page)) return false;
  // Tenant self-checkout is not part of the manual-sales workflow — hidden
  // from every shell while the underlying page/API stay available by URL.
  if (HIDDEN_TENANT_PAGES.has(page)) return false;
  return canAccessPage(role, page);
}

/**
 * Groups visible to `role` in the shells (shared by desktop + mobile).
 *
 * Platform rule: the Super Admin manages customers through the Control
 * Center. An org-less super_admin sees ONLY the Control Center group
 * (Overview / Organizations / Packages / Landing Page) — tenant operational
 * groups require an active organization context and appear once the SA has
 * switched into one (e.g. a MANAGED org), where MANAGED operational access is
 * authorized. Tenant supersession ('organization' hidden from super_admin)
 * still applies inside those groups.
 */
export function visibleGroupsFor(
  role: string | null | undefined,
  hasOrganizationContext: boolean,
): NavGroup[] {
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccessShellItem(role, item.page)),
    }))
    .filter((group) => {
      if (group.items.length === 0) return false;
      if (role === 'super_admin' && !hasOrganizationContext && group.id !== 'control-center') return false;
      return true;
    });
}

export const navGroups: NavGroup[] = [
  {
    id: 'tenant-overview',
    section: 'Overview',
    items: [
      { page: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { page: 'employees', label: 'Employees', icon: Users },
      { page: 'departments', label: 'Departments', icon: Building2 },
      { page: 'devices', label: 'Devices', icon: Monitor },
      { page: 'activities', label: 'Activities', icon: Activity },
      { page: 'screenshots', label: 'Screenshots', icon: Camera },
      { page: 'audio', label: 'Audio Transcriptions', icon: Mic },
      { page: 'break-status', label: 'Break Monitor', icon: Pause },
      { page: 'live-monitor', label: 'Live Monitor', icon: Radio },
      { page: 'analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    id: 'tenant-intelligence',
    section: 'Intelligence',
    items: [
      { page: 'insights', label: 'AI Insights', icon: Brain },
      { page: 'sentiment', label: 'Sentiment', icon: HeartPulse },
      { page: 'ai-provider', label: 'AI Provider', icon: Bot },
    ],
  },
  {
    id: 'tenant-security',
    section: 'Security',
    items: [
      { page: 'agent-approvals', label: 'Agent Approvals', icon: ShieldCheck, showBadge: true },
      { page: 'notifications', label: 'Notifications', icon: Bell, showBadge: true },
      { page: 'alerts', label: 'Alerts', icon: AlertTriangle },
      { page: 'audit', label: 'Audit Logs', icon: ScrollText },
      { page: 'security', label: 'Agent Security', icon: ShieldAlert },
      { page: 'policies', label: 'Policies', icon: ShieldCheck },
      { page: 'anomalies', label: 'Anomaly Detection', icon: Brain },
      { page: 'consent', label: 'Consent', icon: FileCheck },
    ],
  },
  {
    id: 'work-management',
    section: 'Work Management',
    items: [{ page: 'projects', label: 'Projects', icon: FolderKanban }],
  },
  {
    id: 'employee',
    section: 'Employee',
    items: [{ page: 'self-portal', label: 'Employee Portal', icon: UserCircle }],
  },
  {
    id: 'tenant-admin',
    section: 'Admin',
    items: [
      // Tenant organization settings — hidden from super_admin in the shells
      // (single authoritative Organizations entry lives in the Control Center).
      { page: 'organization', label: 'Organization', icon: Building2 },
      { page: 'users', label: 'Users & Members', icon: Users },
      { page: 'reports', label: 'Reports', icon: FileText },
      { page: 'daily-report', label: 'Daily Report', icon: FileBarChart },
      // Tenant self-checkout — hidden from the shells (manual-sales model).
      // Page + API remain available by URL for support.
      // { page: 'billing', label: 'Billing & Subscription', icon: CreditCard, href: '/dashboard/billing' },
      { page: 'settings', label: 'Settings', icon: Settings },
      { page: 'branding', label: 'Branding', icon: Palette },
      { page: 'data-infrastructure', label: 'Data Infrastructure', icon: ServerCog },
    ],
  },
  // The Super Admin surface is intentionally Organizations-centric. Overview
  // + Organizations drive the manual sales flow; Packages & Pricing unifies
  // the plan catalog, V1 pricing, and promotional offers; Landing Page
  // manages public content. Subscriptions / manual payments / licenses are
  // managed from each Organization (org detail) — no standalone menus.
  {
    id: 'control-center',
    section: 'Control Center',
    items: [
      { page: 'sa-overview', label: 'Overview', icon: Crown },
      { page: 'super-admin-organizations', label: 'Organizations', icon: Building2 },
      { page: 'sa-packages-pricing', label: 'Packages & Pricing', icon: Package },
      { page: 'sa-purchase-requests', label: 'Purchase Requests', icon: ShoppingBag },
      { page: 'sa-infra-requests', label: 'Infrastructure Requests', icon: ClipboardList },
      { page: 'sa-landing', label: 'Landing Page', icon: Globe },
    ],
  },
];
