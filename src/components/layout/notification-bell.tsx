'use client';

import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  CheckCheck,
  ExternalLink,
  MonitorOff,
  UserPlus,
  ShieldAlert,
  Clock,
  Sparkles,
  Lock,
  Settings as SettingsIcon,
  Mail,
  UserCircle,
  Building2,
  Briefcase,
  X,
  Check,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { motion, AnimatePresence } from 'framer-motion';
import { useAppStore } from '@/lib/store';
import { useAuthStore } from '@/lib/store';

interface NotificationItem {
  id: string;
  title: string;
  message: string;
  type: string;
  priority: string;
  status: string;
  createdAt: string;
  // Lead-specific fields (optional, for lead_submission type)
  leadId?: string | null;
  name?: string | null;
  email?: string | null;
  company?: string | null;
  planInterest?: string | null;
}

const priorityColors: Record<string, string> = {
  low: 'bg-blue-400',
  medium: 'bg-amber-400',
  high: 'bg-orange-500',
  critical: 'bg-red-500',
};

const typeIcons: Record<string, React.ElementType> = {
  device_offline: MonitorOff,
  new_employee: UserPlus,
  policy_violation: ShieldAlert,
  high_inactivity: Clock,
  license_expiration: ShieldAlert,
  ai_recommendation: Sparkles,
  security: Lock,
  system: SettingsIcon,
  lead_submission: Mail,
};

const typeIconColors: Record<string, string> = {
  device_offline: 'text-rose-500',
  new_employee: 'text-emerald-500',
  policy_violation: 'text-amber-500',
  high_inactivity: 'text-orange-500',
  license_expiration: 'text-rose-500',
  ai_recommendation: 'text-violet-500',
  security: 'text-red-600',
  system: 'text-slate-500',
  lead_submission: 'text-blue-500',
};

const typeIconBg: Record<string, string> = {
  device_offline: 'bg-rose-50 dark:bg-rose-900/20',
  new_employee: 'bg-emerald-50 dark:bg-emerald-900/20',
  policy_violation: 'bg-amber-50 dark:bg-amber-900/20',
  high_inactivity: 'bg-orange-50 dark:bg-orange-900/20',
  license_expiration: 'bg-rose-50 dark:bg-rose-900/20',
  ai_recommendation: 'bg-violet-50 dark:bg-violet-900/20',
  security: 'bg-red-50 dark:bg-red-900/20',
  system: 'bg-slate-100 dark:bg-slate-800/30',
  lead_submission: 'bg-blue-50 dark:bg-blue-900/20',
};

function formatTimeAgo(dateStr: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function NotificationDetailPanel({
  notif,
  onClose,
  onMarkRead,
}: {
  notif: NotificationItem;
  onClose: () => void;
  onMarkRead: (id: string, isLead: boolean) => void;
}) {
  const isLead = notif.type === 'lead_submission';
  return (
    <div className="fixed inset-y-0 right-0 w-[360px] max-w-[90vw] bg-background border-l border-border shadow-xl z-50 overflow-y-auto">
      <div className="sticky top-0 bg-background border-b border-border px-4 py-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Notification Details</h2>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ScrollArea className="h-[calc(100%-64px)]">
        <div className="p-4 space-y-4">
          {/* Type icon + title */}
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <Bell className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium">
                {isLead
                  ? `${notif.name || 'Requester'}${notif.company ? ` (${notif.company})` : ''}`
                  : notif.title}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {formatTimeAgo(notif.createdAt)}
              </p>
            </div>
          </div>

          {/* Lead-specific details */}
          {isLead && (
            <>
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  Requester Information
                </p>
                <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <UserCircle className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="font-medium">{notif.name || '—'}</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span>{notif.email || '—'}</span>
                  </div>
                  {notif.company && (
                    <div className="flex items-center gap-2 text-sm">
                      <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                      <span>{notif.company}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  Request Details
                </p>
                <div className="bg-muted/50 rounded-lg p-3 space-y-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Briefcase className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-muted-foreground">Interested in:</span>
                    <Badge>{notif.planInterest || '—'}</Badge>
                  </div>
                  {notif.message && (
                    <div className="pt-2 border-t border-border">
                      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide mb-1">
                        Message
                      </p>
                      <p className="text-sm text-foreground whitespace-pre-wrap">
                        {notif.message}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {/* Regular notification details */}
          {!isLead && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                Message
              </p>
              <p className="text-sm text-foreground">{notif.message}</p>
            </div>
          )}

          {/* Status */}
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              Status
            </p>
            <Badge variant="secondary" className="text-xs">
              {isLead ? 'New Lead Submission' : notif.status}
            </Badge>
          </div>

          {/* Mark as Read action */}
          {notif.status === 'unread' && (
            <Button
              className="w-full h-9 text-sm"
              onClick={() => onMarkRead(notif.id, isLead)}
            >
              <Check className="w-4 h-4 mr-2" />
              Mark as Read
            </Button>
          )}

          {!isLead && notif.status !== 'unread' && (
            <p className="text-xs text-muted-foreground text-center py-2">
              This notification has been read.
            </p>
          )}

          {isLead && notif.status !== 'new' && (
            <p className="text-xs text-muted-foreground text-center py-2">
              This lead has been processed.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export function NotificationBell() {
  const { setCurrentPage } = useAppStore();
  const queryClient = useQueryClient();
  const authUser = useAuthStore((s) => s.user);
  const isSuperAdmin = authUser?.role === 'super_admin';
  const [notifOpen, setNotifOpen] = useState(false);
  const [selectedNotif, setSelectedNotif] = useState<NotificationItem | null>(null);

  // Determine which API to use based on role
  const isPlatformMode = isSuperAdmin;

  // Lightweight count polling
  const { data: countData } = useQuery({
    queryKey: ['notification-count', isPlatformMode],
    queryFn: async () => {
      const url = isPlatformMode
        ? '/api/super-admin/notifications/count'
        : '/api/notifications/count';
      const res = await fetch(url);
      return res.json();
    },
    refetchInterval: 30000,
  });

  // Full notification list for dropdown
  const { data: notifData } = useQuery({
    queryKey: ['notifications-dropdown', isPlatformMode],
    queryFn: async () => {
      let url: string;
      if (isPlatformMode) {
        // Super Admin: get unified notifications + leads
        url = '/api/super-admin/notifications?includeLeads=true&status=unread&pageSize=5';
      } else {
        url = '/api/notifications?status=unread&pageSize=5';
      }
      const res = await fetch(url);
      const json = await res.json();
      return {
        notifications: (json.data || []) as NotificationItem[],
      };
    },
    enabled: notifOpen,
    refetchInterval: notifOpen ? 15000 : false,
  });

  const unreadCount = countData?.unread ?? 0;
  const recentNotifs = notifData?.notifications ?? [];

  const markReadMutation = useMutation({
    mutationFn: async ({ id, isLead }: { id: string; isLead: boolean }) => {
      const url = isPlatformMode
        ? '/api/super-admin/notifications'
        : '/api/notifications';
      const body: Record<string, unknown> = { id };
      if (isLead) {
        body.leadStatus = 'CONTACTED';
      } else {
        body.status = 'read';
      }
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to mark as read');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notifications-dropdown', true] });
      queryClient.invalidateQueries({ queryKey: ['notifications-dropdown', false] });
      queryClient.invalidateQueries({ queryKey: ['notification-count', true] });
      queryClient.invalidateQueries({ queryKey: ['notification-count', false] });
      setSelectedNotif((prev) => {
        if (prev && prev.id === prev.id) {
          return { ...prev, status: isPlatformMode ? (prev.type === 'lead_submission' ? 'contacted' : 'read') : 'read' };
        }
        return prev;
      });
    },
  });

  const markAllRead = useCallback(async () => {
    const url = isPlatformMode
      ? '/api/super-admin/notifications'
      : '/api/notifications';
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markAllRead: true }),
    });
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    // Invalidate both platform and tenant notification query keys
    queryClient.invalidateQueries({ queryKey: ['notifications-dropdown', true] });
    queryClient.invalidateQueries({ queryKey: ['notifications-dropdown', false] });
    queryClient.invalidateQueries({ queryKey: ['notification-count', true] });
    queryClient.invalidateQueries({ queryKey: ['notification-count', false] });
  }, [queryClient, isPlatformMode]);

  const handleViewAll = () => {
    setNotifOpen(false);
    if (isSuperAdmin) {
      // Super Admin: navigate to the Control Center overview
      setCurrentPage('sa-overview');
    } else {
      setCurrentPage('notifications');
    }
  };

  const handleNotifClick = (notif: NotificationItem) => {
    setSelectedNotif(notif);
    setNotifOpen(true);
  };

  const handleMarkRead = (id: string, isLead: boolean) => {
    markReadMutation.mutate({ id, isLead });
  };

  const handleClosePanel = () => {
    setSelectedNotif(null);
  };

  return (
    <>
      {selectedNotif && (
        <NotificationDetailPanel
          notif={selectedNotif}
          onClose={handleClosePanel}
          onMarkRead={handleMarkRead}
        />
      )}
      <Popover open={notifOpen} onOpenChange={(open) => {
        setNotifOpen(open);
        if (!open) setSelectedNotif(null);
      }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 relative"
          aria-label="Notifications"
        >
          <motion.span
            animate={unreadCount > 0 ? { scale: [1, 1.15, 1] } : { scale: 1 }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
            className="relative flex"
          >
            <Bell className="w-4 h-4" />
            {unreadCount > 0 && (
              <span className="absolute inset-0 rounded-full bg-emerald-400/20 animate-ping" />
            )}
          </motion.span>
          {unreadCount > 0 && (
            <Badge className="absolute -top-1 -right-1 h-5 min-w-5 rounded-full p-0 flex items-center justify-center text-[10px] bg-emerald-500 text-white border-2 border-card">
              {unreadCount > 99 ? '99+' : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-0 bg-popover border-emerald-500/20 overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-emerald-500" />
            <span className="font-semibold text-sm">Notifications</span>
            {unreadCount > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                {unreadCount} new
              </Badge>
            )}
          </div>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-primary hover:text-primary hover:bg-primary/10"
              onClick={() => markAllRead()}
            >
              <CheckCheck className="w-3.5 h-3.5 mr-1" />
              Mark all read
            </Button>
          )}
        </div>

        {/* Notification list with AnimatePresence */}
        {recentNotifs.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <Bell className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>No unread notifications</p>
          </div>
        ) : (
          <ScrollArea className="max-h-72">
            <div className="divide-y divide-border">
              <AnimatePresence initial={false}>
                {recentNotifs.map((notif, idx) => {
                  const TypeIcon = typeIcons[notif.type] || Bell;
                  const iconColor = typeIconColors[notif.type] || 'text-muted-foreground';
                  const iconBg = typeIconBg[notif.type] || 'bg-muted';
                  // For lead submissions, show requester info in the notification
                  const leadName = notif.name || '';
                  const leadCompany = notif.company || '';
                  return (
                    <motion.div
                      key={notif.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      transition={{ duration: 0.15, delay: idx * 0.04 }}
                      className="flex items-start gap-3 px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer"
                      onClick={() => handleNotifClick(notif)}
                      style={{ cursor: 'pointer' }}
                    >
                      {/* Type icon */}
                      <div className={`h-8 w-8 rounded-lg ${iconBg} flex items-center justify-center shrink-0`}>
                        <TypeIcon className={`w-3.5 h-3.5 ${iconColor}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium truncate">
                            {notif.type === 'lead_submission'
                              ? `${leadName}${leadCompany ? ` (${leadCompany})` : ''}`
                              : notif.title}
                          </p>
                          <span className={`h-2 w-2 rounded-full shrink-0 ${priorityColors[notif.priority] || priorityColors.medium}`} />
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                          {notif.type === 'lead_submission'
                            ? `New ${notif.planInterest || 'plan'} interest from ${leadName}${notif.email ? ` — ${notif.email}` : ''}`
                            : notif.message}
                        </p>
                        <p className="text-[10px] text-muted-foreground/70 mt-1">{formatTimeAgo(notif.createdAt)}</p>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </ScrollArea>
        )}

        {/* Footer */}
        <Separator />
        <div className="flex items-center justify-center px-4 py-2.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-primary hover:text-primary hover:bg-primary/10"
            onClick={handleViewAll}
          >
            View all notifications
            <ExternalLink className="w-3 h-3 ml-1.5" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
    </>
  );
}
