'use client';

import { useAppStore, useAuthStore } from '@/lib/store';
import { useCurrentUser } from '@/hooks/use-current-user';
import { useWebSocket } from '@/components/providers/websocket-provider';
import { Search, Sun, Moon, LogOut, Settings, Menu, ChevronRight, Home, Wifi, WifiOff, KeyRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { useTheme } from 'next-themes';
import { NotificationBell } from './notification-bell';
import { ChangePasswordDialog } from '@/components/auth/change-password-dialog';
import { AvatarUpload } from '@/components/upload/avatar-upload';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { OrgSwitcher } from './org-switcher';

const pageLabels: Record<string, string> = {
  dashboard: 'Dashboard',
  employees: 'Employees',
  'employee-details': 'Employee',
  departments: 'Departments',
  devices: 'Devices',
  activities: 'Activities',
  screenshots: 'Screenshots',
  'break-status': 'Break Monitor',
  'live-monitor': 'Live Monitor',
  analytics: 'Analytics',
  insights: 'AI Insights',
  sentiment: 'Sentiment',
  'ai-provider': 'AI Provider',
  notifications: 'Notifications',
  alerts: 'Alerts',
  audit: 'Audit Logs',
  security: 'Agent Security',
  policies: 'Policies',
  anomalies: 'Anomaly Detection',
  consent: 'Consent',
  projects: 'Projects',
  'self-portal': 'Employee Portal',
  reports: 'Reports',
  organization: 'Organization',
  users: 'Users & Members',
  'daily-report': 'Daily Report',
  settings: 'Settings',
  'agent-approvals': 'Agent Approvals',
  'super-admin-organizations': 'Organizations',
  'super-admin-organization-detail': 'Organization Detail',
  'sa-overview': 'Overview',
  'sa-packages': 'Packages',
  'sa-create-organization': 'Provision Organization',
  'sa-landing': 'Landing Page',
  'sa-audit': 'Audit Logs',
  'data-infrastructure': 'Data Infrastructure',
  'sa-infra-requests': 'Infrastructure Requests',
};

interface AppHeaderProps {
  onMobileMenuToggle?: () => void;
  isMobile?: boolean;
}

export function AppHeader({ onMobileMenuToggle, isMobile }: AppHeaderProps) {
  const { currentPage, pageContext, pageContextLabel, setCurrentPage, setCommandPaletteOpen } = useAppStore();
  const { theme, setTheme } = useTheme();
  const { user } = useCurrentUser();
  const { isConnected, serverInfo } = useWebSocket();
  const authUser = useAuthStore((s) => s.user);
  const authLogout = useAuthStore((s) => s.logout);
  const token = useAuthStore((s) => s.token);
  const router = useRouter();

  const handleLogout = async () => {
    try {
      if (token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      // Ignore network errors on logout
    }
    authLogout();
    toast.success('Logged out successfully');
    router.refresh();
  };

  const displayUser = user || authUser;

  // ── Role-aware header (SUPER_ADMIN ≠ tenant operator) ────────────────
  // The Super Admin is a control-plane operator: tenant controls that make
  // sense for organization users (notifications bell, live-monitor shortcut,
  // tenant Settings) must not render for them. Server-side authorization
  // remains authoritative — this is UX correctness, not a security gate.
  const isSuperAdmin = authUser?.role === 'super_admin';

  return (
    <header className="h-14 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 flex items-center justify-between px-4 md:px-6 sticky top-0 z-30 border-b border-border" role="banner">
      {/* ── Left side: hamburger + title + breadcrumb ── */}
      <div className="flex items-center gap-3 min-w-0">
        {/* Hamburger menu — mobile only */}
        {isMobile && onMobileMenuToggle && (
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={onMobileMenuToggle}
            aria-label="Open navigation menu"
          >
            <Menu className="w-5 h-5" />
          </Button>
        )}

        <div className="flex flex-col min-w-0">
          {/* Page title */}
          <h1 className="text-base font-semibold text-foreground leading-tight truncate" id="page-title">
            {pageLabels[currentPage] || 'Dashboard'}
          </h1>

          {/* Breadcrumb — simple muted style. SUPER ADMIN: the breadcrumb
              hierarchy ("Home › Control Center — Overview") duplicated the
              sidebar navigation and competed with the page title, so the SA
              header shows the single page title + optional context crumb
              only. Tenant users keep the full breadcrumb (Home → page). */}
          <nav className="flex items-center gap-0.5 mt-0.5" aria-label="Breadcrumb">
            {authUser?.role !== 'super_admin' && (
              <button
                onClick={() => setCurrentPage('dashboard')}
                className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <Home className="w-2.5 h-2.5" />
                <span>Home</span>
              </button>
            )}

            {authUser?.role !== 'super_admin' && currentPage !== 'dashboard' && (
              <>
                <ChevronRight className="w-2.5 h-2.5 text-muted-foreground/50" />
                <button
                  onClick={() =>
                    currentPage === 'employee-details'
                      ? setCurrentPage('employees')
                      : setCurrentPage(currentPage)
                  }
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {currentPage === 'employee-details' ? 'Employees' : pageLabels[currentPage] || 'Dashboard'}
                </button>
              </>
            )}

            {pageContext && (
              <>
                <ChevronRight className="w-2.5 h-2.5 text-muted-foreground/50" />
                {/* Context crumb: show the human-readable label (e.g. the
                    employee's name) — NEVER the raw internal DB id. */}
                <span className="text-xs text-muted-foreground capitalize truncate max-w-[24ch]">
                  {pageContextLabel || pageContext.replace(/-/g, ' ')}
                </span>
              </>
            )}
            {authUser?.role === 'super_admin' && pageContext && (
              <span className="text-xs text-muted-foreground">— Control Center</span>
            )}
          </nav>
        </div>
      </div>

      {/* ── Right side: search + actions + user ── */}
      <div className="flex items-center gap-2 md:gap-3">
        {/* Prominent search bar — desktop only */}
        <div data-tour-target="search" className="hidden md:block">
          <Button
            variant="outline"
            size="sm"
            className="h-9 w-[260px] rounded-lg bg-muted/60 border-border justify-start text-muted-foreground font-normal hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
            onClick={() => setCommandPaletteOpen(true)}
          >
            <Search className="w-4 h-4 mr-2 text-muted-foreground/70" />
            <span className="flex-1 text-left">Search...</span>
            <kbd className="hidden lg:inline-flex items-center gap-0.5 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              Ctrl K
            </kbd>
          </Button>
        </div>

        {/* Search button — mobile only */}
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 md:hidden"
          onClick={() => setCommandPaletteOpen(true)}
          aria-label="Search"
        >
          <Search className="w-4 h-4" />
        </Button>

        {/* Theme toggle */}
        <div data-tour-target="theme-toggle">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
          </Button>
        </div>

        {/* WebSocket Connection Status — tenant operational shortcut and
            device/employee counts are hidden from the Super Admin (control-
            plane operator); they see connection state only. */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 relative"
              aria-label="Connection status"
            >
              {isConnected ? (
                <Wifi className="w-4 h-4 text-emerald-500" />
              ) : (
                <WifiOff className="w-4 h-4 text-rose-400" />
              )}
              <span className={cn(
                'absolute top-1.5 right-1.5 h-2 w-2 rounded-full',
                isConnected ? 'bg-emerald-500' : 'bg-rose-500'
              )} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-0">
            <div className="px-4 py-3 border-b">
              <div className="flex items-center gap-2">
                {isConnected ? (
                  <Wifi className="w-4 h-4 text-emerald-500" />
                ) : (
                  <WifiOff className="w-4 h-4 text-rose-500" />
                )}
                <span className="font-semibold text-sm">
                  {isConnected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
            </div>
            <div className="px-4 py-2 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Status</span>
                <Badge className={cn(
                  'text-[9px] h-4 px-1.5 border',
                  isConnected
                    ? 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400'
                    : 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400'
                )}>
                  {isConnected ? 'LIVE' : 'OFFLINE'}
                </Badge>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Devices</span>
                <span className="font-medium">{serverInfo?.deviceCount ?? '—'}</span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Employees</span>
                <span className="font-medium">{serverInfo?.employeeCount ?? '—'}</span>
              </div>
            </div>
            {!isSuperAdmin && (
              <div className="px-4 py-2 border-t">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-xs text-primary hover:text-primary hover:bg-primary/10"
                  onClick={() => setCurrentPage('live-monitor')}
                >
                  Open Live Monitor →
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>

        {/* Notifications — tenant-scoped (organizationId-scoped API); the
            Super Admin is a control-plane operator with no tenant context,
            so the bell does not render for them. */}
        {!isSuperAdmin && (
          <div data-tour-target="notifications">
            <NotificationBell />
          </div>
        )}

        {/* Organization Switcher — only shown for multi-org users */}
        <OrgSwitcher />

        {/* Divider — desktop only */}
        <div className="hidden md:block h-6 w-px bg-border mx-1" />

        {/* User avatar + dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-9 px-2 gap-2 rounded-full">
              <AvatarUpload
                currentAvatar={displayUser?.avatar || null}
                entityId={displayUser?.id || ''}
                entityType="user"
                name={displayUser?.name || 'Admin'}
                size="sm"
                editable
              />
              <span className="hidden lg:inline text-sm font-medium text-foreground">{displayUser?.name?.split(' ')[0] || 'Admin'}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {/* Tenant organization Settings — NOT part of the Super Admin
                experience (control-plane operator, no tenant config). */}
            {!isSuperAdmin && (
              <DropdownMenuItem onClick={() => setCurrentPage('settings')}>
                <Settings className="mr-2 h-4 w-4" />
                Settings
              </DropdownMenuItem>
            )}
            {!isSuperAdmin && <DropdownMenuSeparator />}
            <ChangePasswordDialog>
              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                <KeyRound className="mr-2 h-4 w-4" />
                Change Password
              </DropdownMenuItem>
            </ChangePasswordDialog>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleLogout}>
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
