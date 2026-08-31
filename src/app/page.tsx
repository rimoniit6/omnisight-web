'use client';

import { useEffect, useState } from 'react';
import { AppSidebar } from '@/components/layout/app-sidebar';
import { AppHeader } from '@/components/layout/app-header';
import { CommandPalette } from '@/components/layout/command-palette';
import { MobileSidebarContent } from '@/components/layout/mobile-sidebar';
import { LoginPage } from '@/components/auth/login-page';
import { CreateOrganizationScreen } from '@/components/auth/create-organization-screen';
import { useAppStore, useAuthStore } from '@/lib/store';
import { useIsMobile } from '@/hooks/use-mobile';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { motion, AnimatePresence } from 'framer-motion';

import dynamic from 'next/dynamic';
import { TourOverlay } from '@/components/onboarding/tour-overlay';

// Dynamic imports to reduce SSR bundle size
const DashboardPage = dynamic(() => import('@/components/dashboard/dashboard-page').then(m => ({ default: m.DashboardPage })), { ssr: false });
const EmployeesPage = dynamic(() => import('@/components/employees/employees-page').then(m => ({ default: m.EmployeesPage })), { ssr: false });
const EmployeeDetailsPage = dynamic(() => import('@/components/employees/employee-details-page').then(m => ({ default: m.EmployeeDetailsPage })), { ssr: false });
const DepartmentsPage = dynamic(() => import('@/components/departments/departments-page').then(m => ({ default: m.DepartmentsPage })), { ssr: false });
const DevicesPage = dynamic(() => import('@/components/devices/devices-page').then(m => ({ default: m.DevicesPage })), { ssr: false });
const ActivitiesPage = dynamic(() => import('@/components/activities/activities-page').then(m => ({ default: m.ActivitiesPage })), { ssr: false });
const AnalyticsPage = dynamic(() => import('@/components/analytics/analytics-page').then(m => ({ default: m.AnalyticsPage })), { ssr: false });
const InsightsPage = dynamic(() => import('@/components/insights/insights-page').then(m => ({ default: m.InsightsPage })), { ssr: false });
const AiProviderPage = dynamic(() => import('@/components/ai-provider/ai-provider-page').then(m => ({ default: m.AiProviderPage })), { ssr: false });
const NotificationsPage = dynamic(() => import('@/components/notifications/notifications-page').then(m => ({ default: m.NotificationsPage })), { ssr: false });
const AlertsPage = dynamic(() => import('@/components/alerts/alerts-page').then(m => ({ default: m.AlertsPage })), { ssr: false });
const AuditPage = dynamic(() => import('@/components/audit/audit-page').then(m => ({ default: m.AuditPage })), { ssr: false });
const SettingsPage = dynamic(() => import('@/components/settings/settings-page').then(m => ({ default: m.SettingsPage })), { ssr: false });
const ReportsPage = dynamic(() => import('@/components/reports/reports-page').then(m => ({ default: m.ReportsPage })), { ssr: false });
const OrganizationPage = dynamic(() => import('@/components/organization/organization-page').then(m => ({ default: m.OrganizationPage })), { ssr: false });
const AgentApprovalsPage = dynamic(() => import('@/components/agent-approvals/agent-approvals-page').then(m => ({ default: m.AgentApprovalsPage })), { ssr: false });
const ScreenshotsPage = dynamic(() => import('@/components/screenshots/screenshots-page').then(m => ({ default: m.ScreenshotsPage })), { ssr: false });
const BreakStatusPage = dynamic(() => import('@/components/break-status/break-status-page').then(m => ({ default: m.BreakStatusPage })), { ssr: false });
const DailyReportPage = dynamic(() => import('@/components/reports/daily-report').then(m => ({ default: m.DailyReportPage })), { ssr: false });
const SecurityPage = dynamic(() => import('@/components/security/security-page').then(m => ({ default: m.SecurityPage })), { ssr: false });
const PoliciesPage = dynamic(() => import('@/components/policies/policies-page').then(m => ({ default: m.PoliciesPage })), { ssr: false });
const LiveMonitorPage = dynamic(() => import('@/components/live-monitor/live-monitor-page').then(m => ({ default: m.LiveMonitorPage })), { ssr: false });
const AnomaliesPage = dynamic(() => import('@/components/anomalies/anomalies-page').then(m => ({ default: m.AnomaliesPage })), { ssr: false });
const ConsentPage = dynamic(() => import('@/components/consent/consent-page').then(m => ({ default: m.ConsentPage })), { ssr: false });
const SelfPortalPage = dynamic(() => import('@/components/self-portal/self-portal-page').then(m => ({ default: m.SelfPortalPage })), { ssr: false });
const ProjectsPage = dynamic(() => import('@/components/projects/projects-page').then(m => ({ default: m.ProjectsPage })), { ssr: false });
const SentimentPage = dynamic(() => import('@/components/sentiment/sentiment-page').then(m => ({ default: m.SentimentPage })), { ssr: false });
const AudioPage = dynamic(() => import('@/components/audio/audio-page').then(m => ({ default: m.AudioPage })), { ssr: false });
const UsersPage = dynamic(() => import('@/components/users/users-page').then(m => ({ default: m.UsersPage })), { ssr: false });
const SuperAdminOrganizationsPage = dynamic(() => import('@/components/super-admin/super-admin-organizations-page').then(m => ({ default: m.SuperAdminOrganizationsPage })), { ssr: false });
const SuperAdminOrganizationDetailPage = dynamic(() => import('@/components/super-admin/super-admin-organization-detail-page').then(m => ({ default: m.SuperAdminOrganizationDetailPage })), { ssr: false });

const pageComponents: Record<string, React.ComponentType> = {
  dashboard: DashboardPage,
  employees: EmployeesPage,
  'employee-details': EmployeeDetailsPage,
  departments: DepartmentsPage,
  devices: DevicesPage,
  activities: ActivitiesPage,
  analytics: AnalyticsPage,
  insights: InsightsPage,
  'ai-provider': AiProviderPage,
  notifications: NotificationsPage,
  alerts: AlertsPage,
  audit: AuditPage,
  settings: SettingsPage,
  reports: ReportsPage,
  organization: OrganizationPage,
  'agent-approvals': AgentApprovalsPage,
  screenshots: ScreenshotsPage,
  'break-status': BreakStatusPage,
  'daily-report': DailyReportPage,
  'security': SecurityPage,
  'policies': PoliciesPage,
  'live-monitor': LiveMonitorPage,
  'anomalies': AnomaliesPage,
  'consent': ConsentPage,
  'self-portal': SelfPortalPage,
  projects: ProjectsPage,
  sentiment: SentimentPage,
  audio: AudioPage,
  users: UsersPage,
  'super-admin-organizations': SuperAdminOrganizationsPage,
  'super-admin-organization-detail': SuperAdminOrganizationDetailPage,
};

function AppLayout() {
  const { currentPage, mobileOpen, setMobileOpen } = useAppStore();
  const isMobile = useIsMobile();
  const PageComponent = pageComponents[currentPage] || DashboardPage;

  return (
    <div className='h-screen overflow-hidden flex flex-col'>
      {/* Skip to main content link for keyboard users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:bg-primary focus:text-primary-foreground focus:px-4 focus:py-2 focus:rounded-md focus:outline-none"
      >
        Skip to main content
      </a>
      <div className='flex flex-1 min-h-0'>
        {!isMobile && <AppSidebar />}
        <div className='flex-1 flex flex-col min-w-0'>
          <AppHeader isMobile={isMobile} onMobileMenuToggle={() => setMobileOpen(true)} />
          <main id="main-content" role="main" aria-label="Main content" className='flex-1 p-4 md:p-6 overflow-y-auto min-h-0'>
            <AnimatePresence mode="wait">
              <motion.div
                key={currentPage}
                initial={{ opacity: 0, y: 8, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.99 }}
                transition={{ type: 'spring', stiffness: 300, damping: 28, duration: 0.3 }}
              >
                <PageComponent />
              </motion.div>
            </AnimatePresence>
          </main>
          <footer className='py-3 px-4 md:px-6 text-center text-xs text-muted-foreground'>
            <div className='flex flex-col items-center gap-1'>
              <span>© 2026 OmniSight v1.0.0</span>
              <div className='hidden md:flex items-center gap-2' suppressHydrationWarning>
                <FooterLink page='dashboard'>Dashboard</FooterLink><span>·</span>
                <FooterLink page='employees'>Employees</FooterLink><span>·</span>
                <FooterLink page='settings'>Settings</FooterLink>
              </div>
            </div>
          </footer>
        </div>
      </div>
      <CommandPalette />
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-72 p-0">
          <MobileSidebarContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
      {!isMobile && <TourOverlay />}
    </div>
  );
}

export default function Home() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    useAuthStore.getState().hydrate();
    const id = setTimeout(() => setMounted(true), 0);
    return () => clearTimeout(id);
  }, []);

  // Multi-tab sync: re-hydrate auth state from the fresh httpOnly cookie
  // when the user returns to this tab. If another tab switched organizations,
  // the cookie was updated server-side and this tab needs to pick up the new
  // session state to avoid stale-token P2-01 mismatches.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        useAuthStore.getState().hydrate();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  // First render: loading skeleton (to avoid hydration mismatch)
  if (!mounted) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="h-16 w-16 rounded-2xl bg-primary mx-auto mb-4 animate-pulse" />
          <div className="h-5 w-32 bg-muted rounded mx-auto mb-2 animate-pulse" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  // After hydration, check auth state
  return <AuthGuard />;
}

function AuthGuard() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hydrated = useAuthStore((s) => s._hydrated);
  const user = useAuthStore((s) => s.user);
  const organization = useAuthStore((s) => s.organization);
  const organizationCount = useAuthStore((s) => s.organizationCount);

  // Wait for cookie-session hydration before deciding login vs app.
  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="h-16 w-16 rounded-2xl bg-primary mx-auto mb-4 animate-pulse" />
          <div className="h-5 w-32 bg-muted rounded mx-auto mb-2 animate-pulse" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return <LoginPage />;

  // Fresh-deployment bootstrap: an org-less Super Admin must create the first
  // organization ONLY when zero organizations exist in the database.
  // When organizations already exist, the Super Admin can enter the application
  // directly and use the Organization Switcher for operational context.
  if (user?.role === 'super_admin' && !organization && organizationCount !== null && organizationCount === 0) {
    return <CreateOrganizationScreen />;
  }

  return <AppLayout />;
}

function FooterLink({ page, children }: { page: 'dashboard' | 'employees' | 'settings'; children: React.ReactNode }) {
  const { setCurrentPage } = useAppStore();
  return (
    <button className='hover:text-foreground transition-colors' onClick={() => setCurrentPage(page)}>
      {children}
    </button>
  );
}
