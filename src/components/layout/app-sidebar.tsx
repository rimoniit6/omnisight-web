'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useAppStore, type PageType, useAuthStore } from '@/lib/store';
import { useCurrentUser } from '@/hooks/use-current-user';
import { useEffectiveBranding } from '@/hooks/use-effective-branding';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { visibleGroupsFor } from '@/lib/sidebar-nav';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import Image from 'next/image';



interface AppSidebarProps {
  onNavigate?: () => void;
}

export function AppSidebar({ onNavigate }: AppSidebarProps) {
  const { currentPage, setCurrentPage, sidebarOpen, setSidebarOpen } = useAppStore();
  const router = useRouter();
  const { user } = useCurrentUser();
  const authUser = useAuthStore((s) => s.user);
  const organization = useAuthStore((s) => s.organization);
  const displayUser = user || authUser;
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const branding = useEffectiveBranding();

  // S-2: role-aware navigation — a viewer must never see admin-only items.
  // API RBAC remains the security boundary; this is UX filtering only.
  // Platform rule: an org-less super_admin sees ONLY the Control Center;
  // tenant operational groups appear once the SA has an organization context.
  const role = displayUser?.role ?? null;
  const visibleGroups = visibleGroupsFor(role, Boolean(organization));

  // Agent Approvals badge — the pending device claims queue.
  // TanStack Query keys are prefix-matched by the realtime invalidation
  // mapping (src/lib/ws-invalidation.ts: deviceClaimInvalidation), so a
  // claim event refreshes the badge without any manual refetch wiring.
  // `pageSize=1` makes each call a cheap count probe — the endpoint is the
  // same one the approvals page uses, so the badge can never disagree with
  // the list.
  const pendingClaimsQuery = useQuery({
    queryKey: ['device-claims', 'badge-count'],
    queryFn: async () => {
      const res = await fetch('/api/device-claims?status=pending&pageSize=1');
      if (!res.ok) return 0;
      const json = await res.json();
      return json.total ?? json.data?.length ?? 0;
    },
  });
  const pendingApprovals = pendingClaimsQuery.data ?? 0;

  useEffect(() => {
    const fetchCounts = async () => {
      try {
        const notifRes = await fetch('/api/notifications?status=unread&pageSize=1');
        if (notifRes.ok) {
          const json = await notifRes.json();
          setUnreadCount(json.total ?? json.data?.length ?? 0);
        }
      } catch {
        // Silently fail — badges just won't show
      }
    };
    fetchCounts();
  }, []);

  const handleNavClick = (page: PageType, href?: string) => {
    if (href) {
      router.push(href);
      onNavigate?.();
      return;
    }
    setCurrentPage(page);
    onNavigate?.();
  };

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        data-tour-target="sidebar"
        role="complementary"
        aria-label="Sidebar navigation"
        className={cn(
          'h-screen bg-sidebar text-sidebar-foreground flex flex-col transition-all duration-300 ease-in-out sticky top-0 border-r border-sidebar-border shrink-0',
          sidebarOpen ? 'w-[240px]' : 'w-[64px]'
        )}
      >
        {/* Logo area */}
        <div
          className={cn(
            'flex items-center border-b border-sidebar-border',
            sidebarOpen ? 'h-20 px-4' : 'h-[72px] px-2 justify-center'
          )}
        >
          <div className={cn('flex items-center min-w-0', sidebarOpen ? 'gap-3' : 'justify-center')}>
            <div className={cn(
              'flex items-center justify-center shrink-0',
              !sidebarOpen && 'w-12 h-12'
            )}
            style={sidebarOpen ? {
              width: branding.logoWidth && branding.logoWidth > 0 ? branding.logoWidth + 16 : 64,
              height: branding.logoHeight && branding.logoHeight > 0 ? branding.logoHeight + 16 : 64,
            } : undefined}
            >
              {branding.logoType === 'svg' && branding.logoSvg ? (
                <div
                  style={{
                    width: sidebarOpen
                      ? (branding.logoWidth && branding.logoWidth > 0 ? branding.logoWidth : 48)
                      : 48,
                    height: sidebarOpen
                      ? (branding.logoHeight && branding.logoHeight > 0 ? branding.logoHeight : 48)
                      : 48,
                  }}
                  dangerouslySetInnerHTML={{ __html: branding.logoSvg }}
                  className="flex items-center justify-center"
                />
              ) : (
                <Image
                  src={branding.logoUrl}
                  alt={branding.brandName}
                  width={64}
                  height={64}
                  className={cn('object-contain shrink-0', !sidebarOpen && 'w-12 h-12')}
                  unoptimized
                />
              )}
            </div>
            {sidebarOpen && (
              <span className="font-semibold text-lg tracking-tight text-sidebar-foreground truncate">
                {branding.brandName}
              </span>
            )}
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto custom-scrollbar py-2 px-2" aria-label="Main navigation">
          {visibleGroups.map((group, gi) => (
            <div key={group.id}>
              {gi > 0 && <Separator className="my-2 bg-sidebar-border/50" />}
              {sidebarOpen && (
                <p className="text-[11px] uppercase tracking-[0.08em] text-sidebar-foreground/40 font-semibold px-3 mb-1.5">
                  {group.section}
                </p>
              )}
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = currentPage === item.page;
                  const badgeCount =
                    item.page === 'agent-approvals'
                      ? pendingApprovals
                      : unreadCount;
                  const btn = (
                    <button
                      key={item.page}
                      onClick={() => handleNavClick(item.page, item.href)}
                      aria-label={item.label}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'group w-full flex items-center gap-3 px-2.5 py-[7px] rounded-md text-[13px] font-medium transition-colors duration-150',
                        isActive
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground/55 bg-transparent hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
                      )}
                    >
                      <span className="relative shrink-0">
                        <Icon
                          className={cn(
                            'w-[18px] h-[18px] transition-colors',
                            isActive
                              ? 'text-primary'
                              : 'text-sidebar-foreground/50 group-hover:text-sidebar-foreground'
                          )}
                        />
                        {item.showBadge && badgeCount > 0 && (
                          <span className={`absolute -top-1.5 -right-1.5 flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[9px] font-bold text-white ${item.page === 'agent-approvals' ? 'bg-amber-500' : 'bg-rose-500'}`}>
                            {badgeCount > 99 ? '99+' : badgeCount}
                          </span>
                        )}
                      </span>
                      {sidebarOpen && (
                        <span className="truncate flex-1 text-left" aria-hidden={isActive}>{item.label}</span>
                      )}
                      {sidebarOpen && isActive && (
                        <span className="w-1 h-4 rounded-full bg-primary shrink-0" />
                      )}
                    </button>
                  );

                  if (!sidebarOpen) {
                    return (
                      <Tooltip key={item.page}>
                        <TooltipTrigger asChild>{btn}</TooltipTrigger>
                        <TooltipContent side="right" className="text-sm font-medium">
                          {item.label}
                        </TooltipContent>
                      </Tooltip>
                    );
                  }
                  return btn;
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* System Health Indicator — real health check */}
        <SystemHealthIndicator sidebarOpen={sidebarOpen} />

        {/* User info block — from database */}
        {user && (
        <div className="border-t border-sidebar-border px-3 py-3">
          <div className={cn(
            'flex items-center gap-3',
            sidebarOpen ? '' : 'justify-center'
          )}>
            <Avatar className="h-8 w-8 shrink-0">
              <AvatarFallback className="text-[10px] bg-primary/10 text-primary font-semibold">
                {user.initials}
              </AvatarFallback>
            </Avatar>
            {sidebarOpen && (
              <div className="min-w-0">
                <p className="text-sm font-medium text-sidebar-foreground truncate">{displayUser?.name || 'Admin'}</p>
                <p className="text-[11px] text-muted-foreground truncate">{displayUser?.roleLabel || 'Loading...'}</p>
              </div>
            )}
          </div>
        </div>
        )}

        {/* Collapse button */}
        <div className="border-t border-sidebar-border p-2">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={sidebarOpen}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-muted transition-colors duration-150"
          >
            {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            {sidebarOpen && <span className="text-xs">Collapse</span>}
          </button>
        </div>
      </aside>
    </TooltipProvider>
  );
}

function SystemHealthIndicator({ sidebarOpen }: { sidebarOpen: boolean }) {
  const { data: health, isLoading } = useQuery({
    queryKey: ['system-health'],
    queryFn: async () => {
      const res = await fetch('/api/health');
      if (!res.ok) return { status: 'unavailable' };
      const json = await res.json();
      return { status: json.status || 'ok' };
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const status = isLoading ? 'ok' : (health?.status || 'unavailable');
  const colorClass = status === 'ok' ? 'bg-success' : status === 'degraded' ? 'bg-warning' : 'bg-rose-500';
  const label = status === 'ok' ? 'All systems operational' : status === 'degraded' ? 'System degraded' : 'System unavailable';

  if (sidebarOpen) {
    return (
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <span className={`h-2 w-2 rounded-full ${colorClass} shrink-0`} />
          <p className="text-[11px] text-muted-foreground truncate">
            {label}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="px-2 py-1 flex justify-center">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`h-2.5 w-2.5 rounded-full ${colorClass} cursor-default`} />
        </TooltipTrigger>
        <TooltipContent side="right" className="text-sm font-medium">
          {label}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
