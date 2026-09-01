'use client';

import { useState, useMemo } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/ui/empty-state';
import { useAppStore, useAuthStore } from '@/lib/store';
import {
  Bell,
  Check,
  CheckCheck,
  Monitor,
  Clock,
  AlertTriangle,
  Shield,
  Cpu,
  Sparkles,
  AlarmClock,
  Inbox,
  Archive,
  Trash2,
  ArrowRight,
  Brain,
  FileCheck,
  FolderKanban,
  Settings,
  UserPlus,
  ExternalLink,
  X,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// Extended icon map with all 12 types
const typeIcons: Record<string, React.ElementType> = {
  device_offline: Monitor,
  new_employee: UserPlus,
  policy_violation: Shield,
  high_inactivity: Clock,
  license_expiration: AlertTriangle,
  ai_recommendation: Sparkles,
  security: Shield,
  system: Cpu,
  anomaly_detected: Brain,
  consent_update: FileCheck,
  project_deadline: FolderKanban,
  overtime_alert: Clock,
};

const priorityColors: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  high: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400',
  critical: 'bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300',
};

const priorityBorderAccent: Record<string, string> = {
  low: 'border-l-slate-300 dark:border-l-slate-600',
  medium: 'border-l-amber-400',
  high: 'border-l-rose-400',
  critical: 'border-l-rose-500',
};

const typeIconBg: Record<string, string> = {
  device_offline: 'bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-400',
  new_employee: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-400',
  policy_violation: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  high_inactivity: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  license_expiration: 'bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-400',
  ai_recommendation: 'bg-teal-100 text-teal-600 dark:bg-teal-900/40 dark:text-teal-400',
  security: 'bg-rose-100 text-rose-600 dark:bg-rose-900/40 dark:text-rose-400',
  system: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-900/40 dark:text-cyan-400',
  anomaly_detected: 'bg-violet-100 text-violet-600 dark:bg-violet-900/40 dark:text-violet-400',
  consent_update: 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400',
  project_deadline: 'bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-400',
  overtime_alert: 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-400',
};

const typeChipColor: Record<string, string> = {
  device_offline: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400 border-rose-200 dark:border-rose-800',
  new_employee: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
  policy_violation: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 border-amber-200 dark:border-amber-800',
  high_inactivity: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700',
  license_expiration: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400 border-rose-200 dark:border-rose-800',
  ai_recommendation: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-400 border-teal-200 dark:border-teal-800',
  security: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400 border-rose-200 dark:border-rose-800',
  system: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800',
  anomaly_detected: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400 border-violet-200 dark:border-violet-800',
  consent_update: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400 border-blue-200 dark:border-blue-800',
  project_deadline: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400 border-orange-200 dark:border-orange-800',
  overtime_alert: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 border-amber-200 dark:border-amber-800',
};

const entityTypeBadge: Record<string, string> = {
  employee: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400',
  device: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400',
  anomaly: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400',
  project: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400',
  consent: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-400',
};

interface NotifType {
  value: string;
  label: string;
  icon: string;
  color: string;
}

export function NotificationsPage() {
  const [tab, setTab] = useState('all');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [showPreferences, setShowPreferences] = useState(false);
  const queryClient = useQueryClient();
  const { setCurrentPage, setPageContext, setSelectedEmployeeId } = useAppStore();
  // Viewers are read-only: batch mutation controls (mark read/archive/delete)
  // are hidden — the server enforces 403 regardless.
  const canMutate = useAuthStore((s) => s.user)?.role !== 'viewer';

  // Fetch notification type registry
  const { data: typesData } = useQuery<{ types: NotifType[] }>({
    queryKey: ['notification-types'],
    queryFn: async () => {
      const res = await fetch('/api/notifications/types');
      return res.json();
    },
  });

  // Build query params — page included so pagination and filters compose.
  const queryParams = useMemo(() => {
    const params: string[] = [];
    if (tab !== 'all') params.push(`status=${tab}`);
    if (selectedTypes.size > 0) params.push(`type=${Array.from(selectedTypes).join(',')}`);
    if (searchQuery.trim()) params.push(`search=${encodeURIComponent(searchQuery.trim())}`);
    params.push(`page=${page}`);
    params.push('pageSize=10');
    return `?${params.join('&')}`;
  }, [tab, selectedTypes, searchQuery, page]);

  // N-8: explicit error state — an API failure must never render as "no
  // notifications". isError + refetch gives the user a retry path.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['notifications', tab, Array.from(selectedTypes).sort().join(','), searchQuery, page],
    queryFn: async () => {
      const res = await fetch(`/api/notifications${queryParams}`);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      return res.json();
    },
    placeholderData: (prev) => prev,
  });

  // Batch mutation
  const batchMutation = useMutation<{ affected: number }, Error, { action: string; ids: string[] }>({
    mutationFn: async ({ action, ids }: { action: string; ids: string[] }) => {
      const res = await fetch('/api/notifications/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ids }),
      });
      const json = (await res.json()) as { affected: number };
      return json;
    },
    onSuccess: (_data: { affected: number }, variables) => {
      // N-8: invalidate the page list AND the bell's count/dropdown queries so
      // the badge updates immediately after a mutation.
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notification-count'] });
      queryClient.invalidateQueries({ queryKey: ['notifications-dropdown'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setSelectedIds(new Set());
      const label = variables.action === 'mark_read' ? 'marked as read' : variables.action === 'archive' ? 'archived' : 'deleted';
      toast.success(`${_data.affected} notification${_data.affected > 1 ? 's' : ''} ${label}`);
    },
  });

  const notifications = data?.data || [];
  const total = data?.total || 0;
  const unreadCount = data?.unreadCount ?? 0;
  const stats = useMemo(() => data?.stats || { byType: {}, byPriority: {}, recentCount: 0 }, [data]);

  const typeRegistry = useMemo(() => {
    const map: Record<string, NotifType> = {};
    typesData?.types?.forEach((t) => { map[t.value] = t; });
    return map;
  }, [typesData]);

  // Compute stat cards
  const statCards = useMemo(() => {
    const entries = Object.entries((stats.byType || {}) as Record<string, number>);
    const mostCommonType = entries.length > 0
      ? entries.reduce((a, b) => (b[1] > a[1] ? b : a), entries[0])
      : null;
    return {
      unreadCount,
      recentCount: stats.recentCount || 0,
      mostCommonType: mostCommonType
        ? { type: mostCommonType[0], count: mostCommonType[1], label: typeRegistry[mostCommonType[0]]?.label || mostCommonType[0] }
        : null,
    };
  }, [stats, unreadCount, typeRegistry]);

  // N-8: shared invalidation for every read/archive mutation — the page list,
  // the bell count, the dropdown and the dashboard badge all refresh together.
  const invalidateNotificationQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    queryClient.invalidateQueries({ queryKey: ['notification-count'] });
    queryClient.invalidateQueries({ queryKey: ['notifications-dropdown'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const markAllRead = async () => {
    try {
      const res = await fetch('/api/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markAllRead: true }),
      });
      if (!res.ok) throw new Error('Failed to mark all as read');
      invalidateNotificationQueries();
      toast.success('All notifications marked as read');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to mark all as read');
    }
  };

  const markRead = async (id: string) => {
    try {
      const res = await fetch('/api/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: 'read' }),
      });
      if (!res.ok) throw new Error('Failed to mark as read');
      invalidateNotificationQueries();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to mark as read');
    }
  };

  const archiveNotification = async (id: string) => {
    try {
      const res = await fetch('/api/notifications', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archive: true, id }),
      });
      if (!res.ok) throw new Error('Failed to archive notification');
      invalidateNotificationQueries();
      toast.success('Notification archived');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to archive notification');
    }
  };

  const handleNotificationClick = async (notif: { id: string; actionUrl?: string; status: string; entityType?: string; entityId?: string }) => {
    if (notif.status === 'unread') {
      try {
        const res = await fetch('/api/notifications', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: notif.id, status: 'read' }),
        });
        if (res.ok) invalidateNotificationQueries();
      } catch { /* ignore — non-critical */ }
    }
    if (notif.actionUrl || notif.entityType) {
      // M-14: support all entity types for navigation
      const entityType = notif.entityType || '';
      const entityId = notif.entityId || '';
      switch (entityType) {
        case 'employee':
          if (entityId) {
            setSelectedEmployeeId(entityId);
            setCurrentPage('employees');
            setPageContext(`view:${entityId}`);
          } else {
            setCurrentPage('employees');
          }
          break;
        case 'device':
          setCurrentPage('devices');
          break;
        case 'anomaly':
          setCurrentPage('anomalies');
          break;
        case 'project':
          setCurrentPage('projects');
          if (entityId) setPageContext(`project:${entityId}`);
          break;
        case 'consent':
          setCurrentPage('consent');
          break;
        case 'alert':
          setCurrentPage('alerts');
          break;
        case 'report':
          setCurrentPage('reports');
          break;
        case 'screenshot':
          setCurrentPage('screenshots');
          break;
        case 'policy':
          setCurrentPage('policies');
          break;
        default: {
          // Fallback: parse actionUrl if present
          const url = notif.actionUrl || '';
          if (url.startsWith('/employees')) setCurrentPage('employees');
          else if (url.startsWith('/devices')) setCurrentPage('devices');
          else if (url.startsWith('/anomalies')) setCurrentPage('anomalies');
          else if (url.startsWith('/projects')) setCurrentPage('projects');
          else if (url.startsWith('/consent')) setCurrentPage('consent');
          else if (url.startsWith('/alerts')) setCurrentPage('alerts');
          else if (url.startsWith('/reports')) setCurrentPage('reports');
          else if (url.startsWith('/screenshots')) setCurrentPage('screenshots');
          else if (url.startsWith('/policies')) setCurrentPage('policies');
          else setCurrentPage('employees');
        }
      }
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === notifications.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(notifications.map((n: { id: string }) => n.id)));
    }
  };

  const toggleTypeFilter = (type: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
    setPage(1);
  };

  const handleBatchAction = (action: string) => {
    if (selectedIds.size === 0) return;
    batchMutation.mutate({ action, ids: Array.from(selectedIds) });
  };

  // ── Persisted org-level preferences (N-6) ────────────────────────────────
  // Notifications are organization-wide; the admin toggles a type org-wide.
  // The server persists the choice and every producer honors it.
  const { data: prefsData, isLoading: prefsLoading } = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: async () => {
      const res = await fetch('/api/notifications/preferences');
      return res.json();
    },
    enabled: showPreferences,
  });
  // Server truth derived during render; local state holds only in-flight
  // optimistic overrides until the server confirms (no setState-in-effect).
  const prefsMap = useMemo(() => {
    const m: Record<string, boolean> = {};
    for (const p of prefsData?.preferences ?? []) m[p.notificationType] = p.enabled;
    return m;
  }, [prefsData]);
  const [prefOverrides, setPrefOverrides] = useState<Record<string, boolean>>({});
  const isPrefEnabled = (type: string) => prefOverrides[type] ?? prefsMap[type] ?? true;

  const savePreference = async (type: string, enabled: boolean) => {
    setPrefOverrides((prev) => ({ ...prev, [type]: enabled }));
    try {
      const res = await fetch('/api/notifications/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationType: type, enabled }),
      });
      if (!res.ok) {
        toast.error('Failed to save preference');
        setPrefOverrides((prev) => {
          const next = { ...prev };
          delete next[type]; // revert to server value
          return next;
        });
      } else {
        toast.success('Preference saved');
        queryClient.invalidateQueries({ queryKey: ['notification-preferences'] });
      }
    } catch {
      toast.error('Failed to save preference');
      setPrefOverrides((prev) => {
        const next = { ...prev };
        delete next[type]; // revert to server value
        return next;
      });
    }
  };

  const tabs = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread' },
    { key: 'read', label: 'Read' },
  ];

  const emptyMessages: Record<string, { title: string; description: string }> = {
    all: { title: 'No notifications yet', description: 'All caught up! Notifications are organization-wide and appear here when there are updates.' },
    unread: { title: 'No unread notifications', description: 'All notifications have been read. Nice work staying on top of things!' },
    read: { title: 'No read notifications', description: 'Read notifications for this organization will appear here.' },
  };

  return (
    <div className='space-y-4' role='region' aria-label='Notifications'>
      {/* ===== Stat Cards ===== */}
      <div className='grid grid-cols-1 sm:grid-cols-3 gap-3'>
        <Card className='border-emerald-200 dark:border-emerald-800'>
          <CardContent className='p-3 flex items-center gap-3'>
            <div className='h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center'>
              <Bell className='w-4 h-4 text-emerald-600 dark:text-emerald-400' />
            </div>
            <div>
              <p className='text-xs text-muted-foreground'>Unread</p>
              <p className='text-lg font-bold text-emerald-700 dark:text-emerald-400'>{statCards.unreadCount}</p>
            </div>
          </CardContent>
        </Card>
        <Card className='border-teal-200 dark:border-teal-800'>
          <CardContent className='p-3 flex items-center gap-3'>
            <div className='h-9 w-9 rounded-lg bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center'>
              <AlarmClock className='w-4 h-4 text-teal-600 dark:text-teal-400' />
            </div>
            <div>
              <p className='text-xs text-muted-foreground'>Last 24h</p>
              <p className='text-lg font-bold text-teal-700 dark:text-teal-400'>{statCards.recentCount}</p>
            </div>
          </CardContent>
        </Card>
        <Card className='border-violet-200 dark:border-violet-800'>
          <CardContent className='p-3 flex items-center gap-3'>
            <div className='h-9 w-9 rounded-lg bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center'>
              <Sparkles className='w-4 h-4 text-violet-600 dark:text-violet-400' />
            </div>
            <div>
              <p className='text-xs text-muted-foreground'>Most Common Type</p>
              <p className='text-sm font-semibold text-violet-700 dark:text-violet-400 truncate'>
                {statCards.mostCommonType ? `${statCards.mostCommonType.label} (${statCards.mostCommonType.count})` : 'N/A'}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ===== Header with Tabs, Search, Preferences Toggle ===== */}
      <div className='flex items-center justify-between flex-wrap gap-3'>
        <div className='flex items-center gap-3 flex-wrap'>
          <div className='flex gap-1 bg-muted rounded-lg p-1'>
            {tabs.map((t) => (
              <Button key={t.key} variant={tab === t.key ? 'default' : 'ghost'} size='sm' className='h-8 text-xs' onClick={() => { setTab(t.key); setPage(1); setSelectedIds(new Set()); }}>
                {t.label}
                {t.key === 'unread' && unreadCount > 0 && (
                  <span className='ml-1.5 inline-flex items-center justify-center w-4.5 h-4.5 rounded-full bg-white/20 text-[10px] font-bold leading-none px-1'>{unreadCount}</span>
                )}
              </Button>
            ))}
          </div>
          {unreadCount > 0 && (
            <div className='inline-flex items-center gap-1.5 bg-emerald-100 dark:bg-emerald-900/40 rounded-full px-3 py-1.5 notification-bounce'>
              <Bell className='w-3 h-3 text-emerald-600 dark:text-emerald-400' />
              <span className='text-xs font-semibold text-emerald-700 dark:text-emerald-400'>{unreadCount} unread</span>
            </div>
          )}
        </div>
        <div className='flex items-center gap-2'>
          <Button
            variant={showPreferences ? 'default' : 'outline'}
            size='sm'
            onClick={() => setShowPreferences(!showPreferences)}
            className={cn(showPreferences && 'bg-violet-600 hover:bg-violet-700 border-violet-600')}
          >
            <Settings className='w-3.5 h-3.5 mr-1.5' />
            Preferences
          </Button>
          <Button
            variant='outline'
            size='sm'
            onClick={markAllRead}
            disabled={unreadCount === 0}
            className={cn(
              'border-emerald-300 dark:border-emerald-700',
              unreadCount > 0
                ? 'text-primary hover:bg-primary/10 hover:text-primary'
                : 'text-muted-foreground'
            )}
          >
            <CheckCheck className='w-3.5 h-3.5 mr-1.5' /> Mark All Read
          </Button>
        </div>
      </div>

      {/* ===== Preferences Panel ===== */}
      <AnimatePresence>
        {showPreferences && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <Card className='border-violet-200 dark:border-violet-800 overflow-hidden'>
              <CardContent className='p-4'>
                <div className='flex items-center justify-between mb-3'>
                  <div>
                    <h3 className='text-sm font-semibold'>Notification Preferences</h3>
                    <p className='text-xs text-muted-foreground mt-0.5'>Toggle which notification types are enabled</p>
                  </div>
                  <Button size='sm' variant='ghost' onClick={() => setShowPreferences(false)}>
                    <X className='w-4 h-4' />
                  </Button>
                </div>
                <div className='grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2'>
                  {prefsLoading ? (
                    <div className='col-span-full text-xs text-muted-foreground'>Loading preferences…</div>
                  ) : (
                    (prefsData?.preferences || []).map((t: { notificationType: string; label: string; active: boolean; enabled: boolean }) => (
                      <div
                        key={t.notificationType}
                        className={cn(
                          'flex items-center justify-between rounded-lg border px-3 py-2 transition-colors',
                          isPrefEnabled(t.notificationType)
                            ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/20'
                            : 'border-muted bg-muted/30 opacity-60'
                        )}
                      >
                        <div className='flex items-center gap-2'>
                          <div className={cn('h-6 w-6 rounded flex items-center justify-center', typeIconBg[t.notificationType] || 'bg-muted text-muted-foreground')}>
                            {(() => { const Icon = typeIcons[t.notificationType] || Bell; return <Icon className='w-3 h-3' />; })()}
                          </div>
                          <div>
                            <span className='text-xs font-medium'>{t.label}</span>
                            <span className={cn('ml-2 text-[9px] uppercase tracking-wide rounded px-1 py-0.5', t.active ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400' : 'bg-muted text-muted-foreground')}>
                              {t.active ? 'Active' : 'Planned'}
                            </span>
                          </div>
                        </div>
                        <Switch
                          checked={isPrefEnabled(t.notificationType)}
                          onCheckedChange={(on) => savePreference(t.notificationType, on)}
                          className='scale-75'
                        />
                      </div>
                    ))
                  )}
                </div>
                <p className='text-[10px] text-muted-foreground mt-2'>
                  Notifications are organization-wide. Disabling a type stops new notifications of that type for the whole organization.
                  "Planned" types have no automatic producer yet.
                </p>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ===== Type Filter Chips ===== */}
      {typesData?.types && (
        <div className='flex items-center gap-1.5 flex-wrap'>
          <span className='text-xs text-muted-foreground font-medium mr-1'>Type:</span>
          <button
            onClick={() => setSelectedTypes(new Set())}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
              selectedTypes.size === 0
                ? 'bg-foreground text-background border-foreground'
                : 'bg-muted text-muted-foreground border-muted hover:bg-muted/80'
            )}
          >
            All
          </button>
          {typesData.types.map((t) => {
            const count = (stats.byType || {})[t.value] || 0;
            if (count === 0) return null;
            const isActive = selectedTypes.has(t.value);
            return (
              <button
                key={t.value}
                onClick={() => toggleTypeFilter(t.value)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
                  isActive
                    ? typeChipColor[t.value] || 'bg-foreground text-background border-foreground'
                    : 'bg-muted text-muted-foreground border-muted hover:bg-muted/80'
                )}
              >
                <span>{t.label}</span>
                <span className={cn('ml-0.5 rounded-full px-1.5 py-0 text-[9px] font-bold',
                  isActive ? 'bg-white/30 dark:bg-black/20' : 'bg-muted-foreground/10'
                )}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* ===== Search ===== */}
      <div className='relative max-w-sm'>
        <input
          type='text'
          placeholder='Search notifications...'
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className='w-full h-8 rounded-md border border-input bg-background px-3 py-1 text-xs ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} aria-label='Clear search' className='absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground'>
            <X className='w-3 h-3' />
          </button>
        )}
      </div>

      {/* ===== Batch Action Bar (admin+ only — the batch API enforces this) ===== */}
      {canMutate && selectedIds.size > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className='flex items-center gap-2 p-2.5 border rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800'
        >
          <span className='text-xs font-semibold text-emerald-700 dark:text-emerald-400 mr-2'>
            {selectedIds.size} selected
          </span>
          <div className='flex items-center gap-1.5 ml-auto'>
            <Button size='sm' variant='outline' className='h-7 text-[11px]' onClick={() => handleBatchAction('mark_read')}>
              <CheckCheck className='w-3 h-3 mr-1' /> Mark Read
            </Button>
            <Button size='sm' variant='outline' className='h-7 text-[11px]' onClick={() => handleBatchAction('archive')}>
              <Archive className='w-3 h-3 mr-1' /> Archive
            </Button>
            <Button size='sm' variant='outline' className='h-7 text-[11px] text-rose-600 border-rose-200 hover:bg-rose-50 hover:text-rose-700 dark:border-rose-800 dark:hover:bg-rose-950/30' onClick={() => handleBatchAction('delete')}>
              <Trash2 className='w-3 h-3 mr-1' /> Delete
            </Button>
          </div>
          <Button size='sm' variant='ghost' className='h-7 text-[11px] ml-1' onClick={() => setSelectedIds(new Set())}>
            <X className='w-3 h-3 mr-1' /> Clear
          </Button>
        </motion.div>
      )}

      {/* ===== Notification List ===== */}
      {isError ? (
        // N-8: an API failure is NOT an empty state — show an explicit error
        // with a retry action instead of "All caught up!".
        <div className='flex flex-col items-center justify-center gap-3 py-10 text-center'>
          <div className='h-10 w-10 rounded-lg bg-rose-100 dark:bg-rose-900/40 flex items-center justify-center'>
            <AlertTriangle className='w-5 h-5 text-rose-600 dark:text-rose-400' />
          </div>
          <div>
            <p className='text-sm font-medium'>Failed to load notifications</p>
            <p className='text-xs text-muted-foreground mt-0.5'>Something went wrong while fetching notifications. Try again.</p>
          </div>
          <Button size='sm' variant='outline' onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : isLoading ? (
        <div className='space-y-3'>{Array.from({ length: 4 }).map((_, i) => <div key={i} className='h-20 bg-muted/30 rounded-lg animate-pulse' />)}</div>
      ) : notifications.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title={emptyMessages[tab]?.title || 'No notifications'}
          description={emptyMessages[tab]?.description || 'No notifications to display.'}
        />
      ) : (
        <AnimatePresence>
          <div className='space-y-2 list-enter scroll-indicator'>
            {notifications.map((notif: {
              id: string; title: string; message: string; type: string; priority: string;
              status: string; createdAt: string; actionUrl?: string; entityType?: string; entityId?: string;
            }, idx: number) => {
              const TypeIcon = typeIcons[notif.type] || Bell;
              const iconBg = typeIconBg[notif.type] || 'bg-muted text-muted-foreground';
              const isExpanded = expandedIds.has(notif.id);
              const lines = notif.message.split('\n');
              const isLong = lines.length > 2 || notif.message.length > 120;
              const displayMessage = isLong && !isExpanded ? lines.slice(0, 2).join('\n') : notif.message;
              const isActionable = !!notif.actionUrl;
              const isSelected = selectedIds.has(notif.id);

              return (
                <motion.div
                  key={notif.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2, delay: idx * 0.03 }}
                >
                  <Card className={cn(
                    'list-item-interactive border shadow-sm transition-all border-l-4 group relative overflow-hidden',
                    priorityBorderAccent[notif.priority] || 'border-l-muted',
                    notif.status === 'unread' && 'bg-emerald-50/30 dark:bg-emerald-950/10',
                    isSelected && 'ring-2 ring-emerald-500/30 ring-offset-1',
                    isActionable && 'cursor-pointer'
                  )}>
                    <CardContent className='p-4 flex items-start gap-3'>
                      {/* Checkbox (hidden for read-only roles) */}
                      {canMutate && (
                        <div className='pt-1' onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleSelect(notif.id)}
                          />
                        </div>
                      )}

                      {/* Type icon */}
                      <div className={cn('h-9 w-9 rounded-lg flex items-center justify-center shrink-0 transition-transform duration-200 group-hover:scale-110', iconBg)}>
                        <TypeIcon className='w-4 h-4' />
                      </div>

                      {/* Content */}
                      <div className='flex-1 min-w-0'>
                        <div className='flex items-center gap-2 flex-wrap'>
                          {/* N-8: actionable cards use a REAL button (keyboard-
                              accessible) instead of a clickable div. The nested
                              action buttons stay siblings, so no button-in-button. */}
                          {isActionable ? (
                            <button
                              type='button'
                              className={cn('text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded', notif.status === 'unread' ? 'font-semibold' : 'font-medium')}
                              onClick={() => handleNotificationClick(notif)}
                            >
                              {notif.title}
                            </button>
                          ) : (
                            <h3 className={cn('text-sm', notif.status === 'unread' ? 'font-semibold' : 'font-medium')}>{notif.title}</h3>
                          )}
                          <Badge className={cn('text-[10px] h-4 px-1.5 border-0', priorityColors[notif.priority] || '')}>{notif.priority}</Badge>
                          <Badge variant='outline' className='text-[10px] h-4 px-1.5'>{typeRegistry[notif.type]?.label || notif.type.replace(/_/g, ' ')}</Badge>
                          {notif.entityType && (
                            <Badge className={cn('text-[10px] h-4 px-1.5 border-0 capitalize', entityTypeBadge[notif.entityType] || 'bg-muted text-muted-foreground')}>
                              {notif.entityType}
                            </Badge>
                          )}
                          {isActionable && (
                            <ArrowRight className='w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity' />
                          )}
                        </div>
                        <p className='text-xs text-muted-foreground mt-1 whitespace-pre-line text-clamp-2'>{displayMessage}</p>
                        {isLong && (
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleExpand(notif.id); }}
                            className='text-[10px] text-primary hover:text-primary mt-0.5 font-medium'
                          >
                            {isExpanded ? 'Show less' : 'Show more'}
                          </button>
                        )}
                        <div className='flex items-center gap-3 mt-2 flex-wrap'>
                          <span className='text-[10px] text-muted-foreground'>{formatDistanceToNow(new Date(notif.createdAt), { addSuffix: true })}</span>

                          {/* Quick action buttons */}
                          <div className='flex items-center gap-1' onClick={(e) => e.stopPropagation()}>
                            {notif.status === 'unread' && (
                              <Button size='sm' variant='ghost' className='h-6 text-[10px] text-primary hover:text-primary p-0' onClick={() => markRead(notif.id)}>
                                <Check className='w-3 h-3 mr-1' /> Mark Read
                              </Button>
                            )}
                            <Button size='sm' variant='ghost' className='h-6 text-[10px] text-muted-foreground hover:text-foreground p-0' onClick={() => archiveNotification(notif.id)}>
                              <Archive className='w-3 h-3 mr-1' /> Archive
                            </Button>
                            {notif.entityId && notif.entityType && !isActionable && (() => {
                                // M-14: map entity types to navigation destinations
                                const navigateToEntity = (type: string, id: string) => {
                                  switch (type) {
                                    case 'employee':
                                      setSelectedEmployeeId(id);
                                      setCurrentPage('employees');
                                      setPageContext(`view:${id}`);
                                      break;
                                    case 'device':
                                      setCurrentPage('devices');
                                      break;
                                    case 'anomaly':
                                      setCurrentPage('anomalies');
                                      break;
                                    case 'project':
                                      setCurrentPage('projects');
                                      setPageContext(`project:${id}`);
                                      break;
                                    case 'consent':
                                      setCurrentPage('consent');
                                      break;
                                    case 'alert':
                                      setCurrentPage('alerts');
                                      break;
                                    case 'report':
                                      setCurrentPage('reports');
                                      break;
                                    case 'screenshot':
                                      setCurrentPage('screenshots');
                                      break;
                                    case 'policy':
                                      setCurrentPage('policies');
                                      break;
                                    default:
                                      setCurrentPage('employees');
                                  }
                                };
                                const isSupportedType = ['employee', 'device', 'anomaly', 'project', 'consent', 'alert', 'report', 'screenshot', 'policy'].includes(notif.entityType!);
                                return isSupportedType ? (
                                  <Button size='sm' variant='ghost' className='h-6 text-[10px] text-blue-600 hover:text-blue-700 p-0' onClick={() => navigateToEntity(notif.entityType!, notif.entityId!)}>
                                    <ExternalLink className='w-3 h-3 mr-1' /> View
                                  </Button>
                                ) : null;
                              })()}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        </AnimatePresence>
      )}

      {/* ===== Bottom Select All Bar ===== */}
      {notifications.length > 0 && (
        <div className='flex items-center gap-3 p-3 border rounded-lg bg-muted/30'>
          {canMutate && (
            <Checkbox
              checked={selectedIds.size === notifications.length && notifications.length > 0}
              onCheckedChange={selectAll}
            />
          )}
          <span className='text-xs text-muted-foreground'>
            {canMutate
              ? (selectedIds.size > 0 ? `${selectedIds.size} of ${notifications.length} selected` : `Select all ${notifications.length} notifications`)
              : `${notifications.length} notifications`}
          </span>
          <span className='ml-auto text-xs text-muted-foreground'>{total} total</span>
        </div>
      )}

      {/* N-8: server-side pagination controls (preserves filters). */}
      {data && data.totalPages > 1 && (
        <div className='flex items-center justify-center gap-3 pt-1'>
          <Button
            size='sm'
            variant='outline'
            disabled={page <= 1}
            onClick={() => { setPage((p) => Math.max(1, p - 1)); setSelectedIds(new Set()); }}
          >
            Previous
          </Button>
          <span className='text-xs text-muted-foreground'>Page {page} of {data.totalPages}</span>
          <Button
            size='sm'
            variant='outline'
            disabled={page >= data.totalPages}
            onClick={() => { setPage((p) => p + 1); setSelectedIds(new Set()); }}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
