'use client';

import { useAppStore, type PageType } from '@/lib/store';
import { useCurrentUser } from '@/hooks/use-current-user';
import { canAccessPage } from '@/lib/navigation';
import {
  LayoutDashboard,
  Users,
  Building2,
  Monitor,
  Activity,
  Camera,
  BarChart3,
  Brain,
  Bot,
  Bell,
  AlertTriangle,
  FileText,
  Settings,
  ScrollText,
  Pause,
  FileBarChart,
  ShieldAlert,
  ShieldCheck,
  FileCheck,
  UserCircle,
  FolderKanban,
  HeartPulse,
  Radio,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import Image from 'next/image';
import { SheetTitle } from '@/components/ui/sheet';

interface NavItem {
  page: PageType;
  label: string;
  icon: React.ElementType;
}

interface NavGroup {
  section: string;
  items: NavItem[];
}

const navGroups: NavGroup[] = [
  {
    section: 'Overview',
    items: [
      { page: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { page: 'employees', label: 'Employees', icon: Users },
      { page: 'departments', label: 'Departments', icon: Building2 },
      { page: 'devices', label: 'Devices', icon: Monitor },
      { page: 'activities', label: 'Activities', icon: Activity },
      { page: 'screenshots', label: 'Screenshots', icon: Camera },
      { page: 'break-status', label: 'Break Monitor', icon: Pause },
      { page: 'live-monitor', label: 'Live Monitor', icon: Radio },
      { page: 'analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    section: 'Intelligence',
    items: [
      { page: 'insights', label: 'AI Insights', icon: Brain },
      { page: 'sentiment', label: 'Sentiment', icon: HeartPulse },
      { page: 'ai-provider', label: 'AI Provider', icon: Bot },
    ],
  },
  {
    section: 'Security',
    items: [
      { page: 'agent-approvals', label: 'Agent Approvals', icon: ShieldCheck },
      { page: 'notifications', label: 'Notifications', icon: Bell },
      { page: 'alerts', label: 'Alerts', icon: AlertTriangle },
      { page: 'audit', label: 'Audit Logs', icon: ScrollText },
      { page: 'security', label: 'Agent Security', icon: ShieldAlert },
      { page: 'policies', label: 'Policies', icon: ShieldCheck },
      { page: 'anomalies', label: 'Anomaly Detection', icon: Brain },
      { page: 'consent', label: 'Consent', icon: FileCheck },
    ],
  },
  {
    section: 'Work Management',
    items: [{ page: 'projects', label: 'Projects', icon: FolderKanban }],
  },
  {
    section: 'Employee',
    items: [{ page: 'self-portal', label: 'Employee Portal', icon: UserCircle }],
  },
  {
    section: 'Admin',
    items: [
      { page: 'organization', label: 'Organization', icon: Building2 },
      { page: 'reports', label: 'Reports', icon: FileText },
      { page: 'daily-report', label: 'Daily Report', icon: FileBarChart },
      { page: 'settings', label: 'Settings', icon: Settings },
    ],
  },
];

interface MobileSidebarContentProps {
  onNavigate: () => void;
}

export function MobileSidebarContent({ onNavigate }: MobileSidebarContentProps) {
  const { currentPage, setCurrentPage } = useAppStore();
  const { user } = useCurrentUser();

  // S-2: role-aware navigation (mirrors the desktop sidebar).
  const role = user?.role ?? null;
  const visibleGroups = navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => canAccessPage(role, item.page)),
    }))
    .filter((group) => group.items.length > 0);

  const handleNavClick = (page: PageType) => {
    setCurrentPage(page);
    onNavigate();
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-background">
      <SheetTitle className="sr-only">Navigation Menu</SheetTitle>

      {/* Logo area */}
      <div className="flex items-center h-16 px-4 border-b border-border">
        <div className="flex items-center gap-3">
          <Image src="/logos/omnisight.svg" alt="OmniSight" width={48} height={48} className="object-contain shrink-0" unoptimized />
          <span className="font-semibold text-lg">OmniSight</span>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {visibleGroups.map((group, gi) => (
          <div key={group.section}>
            {gi > 0 && <div className="my-2 mx-3 h-px bg-border" />}
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/60 px-3 mb-1.5">
              {group.section}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = currentPage === item.page;
                return (
                  <button
                    key={item.page}
                    onClick={() => handleNavClick(item.page)}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-primary/8 text-primary'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    <Icon className="w-[18px] h-[18px] shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* User info block — from database */}
      {user && (
      <div className="px-3 py-3 border-t border-border">
        <div className="flex items-center gap-3 px-2 py-1">
          <Avatar className="h-8 w-8 shrink-0">
            <AvatarFallback className="text-[10px] bg-muted text-muted-foreground font-medium">
              {user.initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{user.name}</p>
            <p className="text-[11px] text-muted-foreground truncate">{user.roleLabel}</p>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
