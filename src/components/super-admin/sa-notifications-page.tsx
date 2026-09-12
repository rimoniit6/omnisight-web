'use client';

import { useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { useAppStore } from '@/lib/store';
import { useAuthStore } from '@/lib/store';
import {
  Bell,
  Check,
  CheckCheck,
  Mail,
  UserCircle,
  Building2,
  Briefcase,
  X,
  Archive,
  ExternalLink,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { PageHeader, PageTransition, LoadingBlock, ErrorState } from '@/components/super-admin/ui';

interface UnifiedItem {
  id: string;
  title: string;
  message: string;
  type: string;
  priority: string;
  status: string;
  createdAt: string;
  leadId?: string | null;
  name?: string | null;
  email?: string | null;
  company?: string | null;
  planInterest?: string | null;
  actionUrl?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

const priorityColors: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  high: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400',
  critical: 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300',
};

const typeIcons: Record<string, React.ElementType> = {
  security: Shield,
  anomaly_detected: Brain,
  new_employee: UserPlus,
  policy_violation: Shield,
  lead_submission: Mail,
};

export function SuperAdminNotificationsPage() {
  const [tab, setTab] = useState<'all' | 'unread' | 'read'>('all');
  const queryClient = useQueryClient();
  const { setCurrentPage } = useAppStore();
  const authUser = useAuthStore((s) => s.user);
  const isSuperAdmin = authUser?.role === 'super_admin';

  const fetchNotifications = async () => {
    const params = new URLSearchParams();
    if (tab !== 'all') params.set('status', tab);
    params.set('includeLeads', 'true');
    params.set('page', '1');
    params.set('pageSize', '50');

    const res = await fetch(`/api/super-admin/notifications?${params}`);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json();
  };

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['sa-notifications', tab],
    queryFn: fetchNotifications,
  });

  const items = data?.data || [];
  const total = data?.pagination?.total || 0;
  const unreadCount = data?.unreadCount || 0;

  // Separate leads from notifications
  const leads = items.filter((item) => item.type === 'lead_submission');
  const notifications = items.filter((item) => item.type !== 'lead_submission');

  const markReadMutation = useMutation({
    mutationFn: async ({ id, isLead }: { id: string; isLead: boolean }) => {
      const body: Record<string, unknown> = { id };
      if (isLead) {
        body.leadStatus = 'CONTACTED';
      } else {
        body.status = 'read';
      }
      const res = await fetch('/api/super-admin/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to mark as read');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sa-notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notification-count', true] });
      queryClient.invalidateQueries({ queryKey: ['notifications-dropdown', true] });
      toast.success('Marked as read');
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/super-admin/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markAllRead: true }),
      });
      if (!res.ok) throw new Error('Failed to mark all as read');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sa-notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notification-count', true] });
      queryClient.invalidateQueries({ queryKey: ['notifications-dropdown', true] });
      toast.success('All notifications marked as read');
    },
  });

  const handleMarkRead = (item: UnifiedItem) => {
    markReadMutation.mutate({ id: item.id, isLead: item.type === 'lead_submission' });
  };

  const handleLeadAction = (leadId: string, action: 'contacted' | 'ignored') => {
    const body: Record<string, unknown> = { id: leadId, leadStatus: action === 'contacted' ? 'CONTACTED' : 'IGNORED' };
    fetch('/api/super-admin/notifications', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((res) => {
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['sa-notifications'] });
        queryClient.invalidateQueries({ queryKey: ['notification-count', true] });
        toast.success(`Lead ${action === 'contacted' ? 'marked as contacted' : 'ignored'}`);
      }
    });
  };

  const tabs = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'read', label: 'Read' },
  ];

  if (isLoading) return <LoadingBlock label="Loading notifications…" />;
  if (isError || !data) return <ErrorState onRetry={() => refetch()} />;

  return (
    <PageTransition>
      <PageHeader
        eyebrow="Control Center"
        title="Notifications"
        description="Platform notifications and landing page requests."
      />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Card className="border-emerald-200 dark:border-emerald-800">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
              <Bell className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Unread</p>
              <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400">{unreadCount}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-blue-200 dark:border-blue-800">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
              <Mail className="w-4 h-4 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Landing Requests</p>
              <p className="text-lg font-bold text-blue-700 dark:text-blue-400">{leads.length}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-violet-200 dark:border-violet-800">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
              <Bell className="w-4 h-4 text-violet-600 dark:text-violet-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="text-lg font-bold text-violet-700 dark:text-violet-400">{total}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs + Mark all */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {tabs.map((t) => (
            <Button
              key={t.key}
              variant={tab === t.key ? 'default' : 'ghost'}
              size="sm"
              className="h-8 text-xs"
              onClick={() => setTab(t.key as typeof tab)}
            >
              {t.label}
              {t.key === 'unread' && unreadCount > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center w-4.5 h-4.5 rounded-full bg-white/20 text-[10px] font-bold leading-none px-1">
                  {unreadCount}
                </span>
              )}
            </Button>
          ))}
        </div>
        {unreadCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => markAllReadMutation.mutate()}
            className="border-emerald-300 dark:border-emerald-700 text-primary hover:bg-primary/10"
          >
            <CheckCheck className="w-3.5 h-3.5 mr-1.5" /> Mark All Read
          </Button>
        )}
      </div>

      {/* Content */}
      <div className="space-y-4">
        {/* Landing Requests section */}
        {leads.length > 0 && tab !== 'read' && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              Landing Page Requests
            </h3>
            <div className="space-y-2">
              {leads.map((lead) => (
                <Card
                  key={lead.id}
                  className={cn(
                    'border-l-4 transition-all',
                    lead.status === 'new' ? 'border-l-emerald-400 bg-emerald-50/20 dark:bg-emerald-950/10' : 'border-l-emerald-200'
                  )}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="h-9 w-9 rounded-lg bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center shrink-0">
                          <Mail className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium text-sm text-foreground truncate">
                              {lead.name || 'Requester'}
                            </p>
                            <Badge className="text-[10px] h-4 px-1.5 border-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                              {lead.status === 'new' ? 'New' : lead.status}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                              {lead.planInterest}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {lead.email}
                            {lead.company ? ` · ${lead.company}` : ''}
                          </p>
                          {lead.message && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2 whitespace-pre-wrap">
                              {lead.message}
                            </p>
                          )}
                          <p className="text-[10px] text-muted-foreground/70 mt-1">
                            {formatDistanceToNow(new Date(lead.createdAt), { addSuffix: true })}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {lead.status === 'new' && (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-[10px] text-emerald-600 hover:text-emerald-700"
                              onClick={() => handleLeadAction(lead.id, 'contacted')}
                            >
                              <Check className="w-3 h-3 mr-1" /> Contacted
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-[10px] text-rose-600 hover:text-rose-700"
                              onClick={() => handleLeadAction(lead.id, 'ignored')}
                            >
                              <X className="w-3 h-3 mr-1" /> Ignore
                            </Button>
                          </>
                        )}
                        {lead.status !== 'new' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-[10px] text-muted-foreground"
                            onClick={() => handleMarkRead(lead)}
                          >
                            <Check className="w-3 h-3 mr-1" /> Marked
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* System Notifications section */}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            System Notifications
          </h3>
          {notifications.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="No system notifications"
              description="No system notifications to display."
            />
          ) : (
            <div className="space-y-2">
              {notifications.map((notif) => {
                const TypeIcon = typeIcons[notif.type] || Bell;
                const isUnread = notif.status === 'unread';
                return (
                  <Card
                    key={notif.id}
                    className={cn(
                      'border-l-4 transition-all',
                      isUnread ? 'border-l-emerald-400 bg-emerald-50/20 dark:bg-emerald-950/10' : 'border-l-muted'
                    )}
                  >
                    <CardContent className="p-4 flex items-start gap-3">
                      <div className={cn(
                        'h-9 w-9 rounded-lg flex items-center justify-center shrink-0',
                        priorityColors[notif.priority] || priorityColors.medium
                      )}>
                        <TypeIcon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className={cn('text-sm', isUnread ? 'font-semibold' : 'font-medium')}>
                            {notif.title}
                          </p>
                          <Badge className={cn('text-[10px] h-4 px-1.5 border-0', priorityColors[notif.priority] || '')}>
                            {notif.priority}
                          </Badge>
                          {notif.entityType && (
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5 capitalize">
                              {notif.entityType}
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2 whitespace-pre-wrap">
                          {notif.message}
                        </p>
                        <p className="text-[10px] text-muted-foreground/70 mt-1">
                          {formatDistanceToNow(new Date(notif.createdAt), { addSuffix: true })}
                        </p>
                        <div className="flex items-center gap-1 mt-2">
                          {isUnread && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 text-[10px] text-primary hover:text-primary p-0"
                              onClick={() => handleMarkRead(notif)}
                            >
                              <Check className="w-3 h-3 mr-1" /> Mark Read
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-[10px] text-muted-foreground hover:text-foreground p-0"
                            onClick={() => {}}
                          >
                            <Archive className="w-3 h-3 mr-1" /> Archive
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </PageTransition>
  );
}
