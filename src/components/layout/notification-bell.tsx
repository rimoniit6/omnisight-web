'use client';

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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

interface NotificationItem {
  id: string;
  title: string;
  message: string;
  type: string;
  priority: string;
  status: string;
  createdAt: string;
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

export function NotificationBell() {
  const { setCurrentPage } = useAppStore();
  const queryClient = useQueryClient();
  const [notifOpen, setNotifOpen] = useState(false);

  // Lightweight count polling
  const { data: countData } = useQuery({
    queryKey: ['notification-count'],
    queryFn: async () => {
      const res = await fetch('/api/notifications/count');
      return res.json();
    },
    refetchInterval: 30000,
  });

  // Full notification list for dropdown
  const { data: notifData } = useQuery({
    queryKey: ['notifications-dropdown'],
    queryFn: async () => {
      const res = await fetch('/api/notifications?status=unread&pageSize=5');
      const json = await res.json();
      return {
        notifications: json.data as NotificationItem[],
      };
    },
    enabled: notifOpen,
    refetchInterval: notifOpen ? 15000 : false,
  });

  const unreadCount = countData?.unread ?? 0;
  const recentNotifs = notifData?.notifications ?? [];

  const markAllRead = useCallback(async () => {
    await fetch('/api/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markAllRead: true }),
    });
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    queryClient.invalidateQueries({ queryKey: ['notifications-dropdown'] });
    queryClient.invalidateQueries({ queryKey: ['notification-count'] });
  }, [queryClient]);

  const handleViewAll = () => {
    setNotifOpen(false);
    setCurrentPage('notifications');
  };

  return (
    <Popover open={notifOpen} onOpenChange={setNotifOpen}>
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
                  return (
                    <motion.div
                      key={notif.id}
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      transition={{ duration: 0.15, delay: idx * 0.04 }}
                      className="flex items-start gap-3 px-4 py-3 hover:bg-muted/50 transition-colors cursor-default"
                    >
                      {/* Type icon */}
                      <div className={`h-8 w-8 rounded-lg ${iconBg} flex items-center justify-center shrink-0`}>
                        <TypeIcon className={`w-3.5 h-3.5 ${iconColor}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium truncate">{notif.title}</p>
                          <span className={`h-2 w-2 rounded-full shrink-0 ${priorityColors[notif.priority] || priorityColors.medium}`} />
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{notif.message}</p>
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
  );
}
