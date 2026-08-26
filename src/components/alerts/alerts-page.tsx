'use client';

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertTriangle, CheckCircle2, XCircle, Info, AlertOctagon, Eye, LayoutGrid, Clock, ShieldAlert, ArrowUpRight, ChevronRight } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { QuickStats, type QuickStat } from '@/components/ui/quick-stats';
import { EmptyState } from '@/components/ui/empty-state';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';

interface AlertItem {
  id: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  type: string;
  source: string | null;
  createdAt: string;
}

const severityConfig: Record<string, { icon: React.ElementType; color: string; bg: string; borderAccent: string }> = {
  info: { icon: Info, color: 'text-teal-600 dark:text-teal-400', bg: 'bg-teal-50 dark:bg-teal-900/20', borderAccent: 'border-l-teal-400' },
  warning: { icon: AlertTriangle, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20', borderAccent: 'border-l-amber-400' },
  error: { icon: XCircle, color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20', borderAccent: 'border-l-rose-500' },
  critical: { icon: AlertOctagon, color: 'text-red-700 dark:text-red-400', bg: 'bg-red-50 dark:bg-red-900/20', borderAccent: 'border-l-red-600' },
};

const severityBarColors: Record<string, string> = {
  info: 'bg-teal-500',
  warning: 'bg-amber-500',
  error: 'bg-rose-500',
  critical: 'bg-red-600',
};

const severityBarBg: Record<string, string> = {
  info: 'bg-teal-100 dark:bg-teal-900/30',
  warning: 'bg-amber-100 dark:bg-amber-900/30',
  error: 'bg-rose-100 dark:bg-rose-900/30',
  critical: 'bg-red-100 dark:bg-red-900/30',
};

const SEVERITY_ORDER = ['info', 'warning', 'error', 'critical'] as const;

type SeverityLevel = typeof SEVERITY_ORDER[number];

function getNextSeverity(current: string): SeverityLevel | null {
  const idx = SEVERITY_ORDER.indexOf(current as SeverityLevel);
  if (idx < 0 || idx >= SEVERITY_ORDER.length - 1) return null;
  return SEVERITY_ORDER[idx + 1];
}

function getTimeDisplay(createdAt: string) {
  const now = Date.now();
  const created = new Date(createdAt).getTime();
  const diffMs = now - created;
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffHours / 24;

  if (diffHours < 1) {
    return { text: 'Just now', className: 'text-emerald-600 dark:text-emerald-400' };
  }
  if (diffHours < 24) {
    return { text: `${Math.floor(diffHours)} hours ago`, className: 'text-amber-600 dark:text-amber-400' };
  }
  return { text: `${Math.floor(diffDays)} days ago`, className: 'text-rose-600 dark:text-rose-400' };
}

function SeverityPathIndicator({ severity }: { severity: string }) {
  const currentIdx = SEVERITY_ORDER.indexOf(severity as SeverityLevel);
  const nextSev = getNextSeverity(severity);

  return (
    <div className="flex items-center gap-1 mt-2">
      <span className="text-[10px] text-muted-foreground mr-1">Severity:</span>
      {SEVERITY_ORDER.map((sev, idx) => {
        const isCurrent = idx === currentIdx;
        const isPast = idx < currentIdx;
        const isNext = nextSev === sev;
        const config = severityConfig[sev];
        const Icon = config.icon;
        return (
          <div key={sev} className="flex items-center gap-1">
            <div
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-medium transition-all ${
                isCurrent
                  ? `${config.bg} ${config.color} ring-1 ring-current/20`
                  : isPast
                    ? 'bg-muted/50 text-muted-foreground/40 line-through'
                    : isNext
                      ? `${config.bg} ${config.color} opacity-50 animate-pulse`
                      : 'bg-muted/30 text-muted-foreground/30'
              }`}
            >
              <Icon className="w-2.5 h-2.5" />
              <span className="capitalize hidden sm:inline">{sev}</span>
            </div>
            {idx < SEVERITY_ORDER.length - 1 && (
              <ChevronRight className={`w-2.5 h-2.5 ${idx < currentIdx ? 'text-muted-foreground/30' : 'text-muted-foreground/50'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AlertsPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [viewMode, setViewMode] = useState<'card' | 'timeline'>('card');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [escalateTarget, setEscalateTarget] = useState<AlertItem | null>(null);
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();

  // N-3: server-paginated + server-side stats — never loads the whole table
  // into the client. Stats (byStatus/bySeverity) come from DB groupBy.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['alerts', statusFilter, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter);
      params.set('page', String(page));
      params.set('pageSize', '50');
      const res = await fetch(`/api/alerts?${params}`);
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      return res.json();
    },
    placeholderData: (prev) => prev,
  });

  const updateStatus = async (id: string, status: string) => {
    try {
      const res = await fetch('/api/alerts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, status }) });
      if (!res.ok) throw new Error(`Failed to update alert`);
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      toast.success(`Alert ${status}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update alert');
    }
  };

  const escalateAlert = async (alert: AlertItem) => {
    const next = getNextSeverity(alert.severity);
    if (!next) return;
    try {
      const res = await fetch('/api/alerts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: alert.id, severity: next }),
      });
      if (!res.ok) throw new Error('Failed to escalate alert');
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      toast.success(`Alert escalated to ${next}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to escalate alert');
    }
    setEscalateTarget(null);
  };

  const alerts: AlertItem[] = data?.data || [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;
  // Server-side stats (N-3) — DB groupBy, never a full-table client scan.
  const byStatus = (data?.stats?.byStatus as Record<string, number>) || {};
  const bySeverity = (data?.stats?.bySeverity as Record<string, number>) || {};
  const pendingCount = byStatus.pending ?? 0;
  const acknowledgedCount = byStatus.acknowledged ?? 0;
  const resolvedCount = byStatus.resolved ?? 0;
  const criticalCount = bySeverity.critical ?? 0;

  const alertStats: QuickStat[] = [
    { label: 'Pending', value: pendingCount, icon: AlertTriangle, color: 'amber' },
    { label: 'Acknowledged', value: acknowledgedCount, icon: Eye, color: 'blue' },
    { label: 'Resolved', value: resolvedCount, icon: CheckCircle2, color: 'emerald' },
    { label: 'Critical', value: criticalCount, icon: ShieldAlert, color: 'rose' },
  ];

  // Severity distribution (N-3) — from the server-side groupBy.
  const severityDist = ['info', 'warning', 'error', 'critical'].map((sev) => ({
    severity: sev,
    count: bySeverity[sev] ?? 0,
  }));
  const totalForPct = (byStatus.pending ?? 0) + (byStatus.acknowledged ?? 0) + (byStatus.resolved ?? 0) + (byStatus.archived ?? 0) || 1;

  const allSelected = alerts.length > 0 && alerts.every((a) => selectedIds.has(a.id));

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(alerts.map((a) => a.id)));
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const handleBulkResolve = useCallback(async () => {
    try {
      const ids = Array.from(selectedIds);
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch('/api/alerts', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, status: 'resolved' }),
          })
        )
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length;
      const failed = ids.length - succeeded;
      if (failed > 0) {
        toast.warning(`${succeeded} resolved, ${failed} failed`);
      } else {
        toast.success(`${succeeded} alert(s) resolved`);
      }
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    } catch {
      toast.error('Failed to resolve alerts');
    }
  }, [selectedIds, queryClient]);

  const handleBulkAcknowledge = useCallback(async () => {
    try {
      const ids = Array.from(selectedIds);
      const results = await Promise.allSettled(
        ids.map((id) =>
          fetch('/api/alerts', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, status: 'acknowledged' }),
          })
        )
      );
      const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value.ok).length;
      const failed = ids.length - succeeded;
      if (failed > 0) {
        toast.warning(`${succeeded} acknowledged, ${failed} failed`);
      } else {
        toast.success(`${succeeded} alert(s) acknowledged`);
      }
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    } catch {
      toast.error('Failed to acknowledge alerts');
    }
  }, [selectedIds, queryClient]);

  const canEscalate = (alert: AlertItem) => {
    return (alert.status === 'pending' || alert.status === 'acknowledged') && getNextSeverity(alert.severity) !== null;
  };

  const renderAlertActions = (alert: AlertItem) => {
    const nextSev = getNextSeverity(alert.severity);
    return (
      <div className="flex items-center gap-3 mt-2 flex-wrap">
        <span className={`text-[10px] font-medium ${getTimeDisplay(alert.createdAt).className}`}>{getTimeDisplay(alert.createdAt).text}</span>
        {alert.status === 'pending' && (
          <Button size="sm" variant="ghost" className="h-6 text-[10px] text-amber-600 hover:text-amber-700 p-0" onClick={() => updateStatus(alert.id, 'acknowledged')}>
            <AlertTriangle className="w-3 h-3 mr-1" /> Acknowledge
          </Button>
        )}
        {canEscalate(alert) && nextSev && (
          <Button size="sm" variant="ghost" className="h-6 text-[10px] text-orange-600 hover:text-orange-700 p-0" onClick={() => setEscalateTarget(alert)}>
            <ArrowUpRight className="w-3 h-3 mr-1" /> Escalate to {nextSev}
          </Button>
        )}
        {alert.status !== 'resolved' && alert.status !== 'archived' && (
          <Button size="sm" variant="ghost" className="h-6 text-[10px] text-primary hover:text-primary p-0" onClick={() => updateStatus(alert.id, 'resolved')}>
            <CheckCircle2 className="w-3 h-3 mr-1" /> Resolve
          </Button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4" role="region" aria-label="Alerts">
      {/* Quick Stats */}
      <QuickStats stats={alertStats} />

      {/* Severity Distribution */}
      {(byStatus.pending ?? 0) + (byStatus.acknowledged ?? 0) + (byStatus.resolved ?? 0) + (byStatus.archived ?? 0) > 0 && (
        <Card className="border shadow-sm">
          <CardContent className="p-4">
            <h3 className="text-xs font-medium text-muted-foreground mb-3">Severity Distribution</h3>
            <div className="space-y-2">
              {severityDist.map((item) => {
                const pct = Math.round((item.count / totalForPct) * 100);
                return (
                  <div key={item.severity} className="flex items-center gap-3">
                    <span className="text-xs font-medium w-16 capitalize shrink-0">{item.severity}</span>
                    <div className={`flex-1 h-3 rounded-full ${severityBarBg[item.severity]} overflow-hidden`}>
                      <div
                        className={`h-full rounded-full ${severityBarColors[item.severity]} transition-all duration-500`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground w-8 text-right shrink-0">{item.count}</span>
                    <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters + View Toggle */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          {alerts.length > 0 && (
            <>
              <Checkbox
                checked={allSelected}
                onCheckedChange={toggleAll}
                aria-label="Select all alerts"
              />
              <span className="text-xs text-muted-foreground">Select all</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center border rounded-md overflow-hidden">
            <Button
              variant={viewMode === 'card' ? 'default' : 'ghost'}
              size="sm"
              className="h-8 px-3 rounded-none text-xs"
              onClick={() => setViewMode('card')}
            >
              <LayoutGrid className="w-3.5 h-3.5 mr-1" /> Card
            </Button>
            <Button
              variant={viewMode === 'timeline' ? 'default' : 'ghost'}
              size="sm"
              className="h-8 px-3 rounded-none text-xs"
              onClick={() => setViewMode('timeline')}
            >
              <Clock className="w-3.5 h-3.5 mr-1" /> Timeline
            </Button>
          </div>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="w-40"><SelectValue placeholder="All Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="acknowledged">Acknowledged</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isError ? (
        // N-8: API failure is NOT an empty state — explicit error + retry.
        <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
          <div className="h-10 w-10 rounded-lg bg-rose-100 dark:bg-rose-900/40 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-rose-600 dark:text-rose-400" />
          </div>
          <div>
            <p className="text-sm font-medium">Failed to load alerts</p>
            <p className="text-xs text-muted-foreground mt-0.5">Something went wrong while fetching alerts. Try again.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : isLoading ? (
        <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 bg-muted/30 rounded animate-pulse" />)}</div>
      ) : alerts.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No alerts"
          description="You're all caught up! No alerts matching your filters."
        />
      ) : viewMode === 'card' ? (
        <div className="space-y-2">
          <AnimatePresence mode="popLayout">
            {alerts.map((alert, idx) => {
              const sc = severityConfig[alert.severity] || severityConfig.warning;
              const Icon = sc.icon;
              const isSelected = selectedIds.has(alert.id);
              return (
                <motion.div
                  key={alert.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  transition={{ duration: 0.2, delay: idx * 0.03 }}
                >
                  <Card className={`border shadow-sm border-l-4 ${sc.borderAccent} ${isSelected ? 'ring-2 ring-emerald-500/30' : ''}`}>
                    <CardContent className="p-3 md:p-4 flex items-start gap-3">
                      <div className="flex items-start gap-3 pt-0.5 shrink-0">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleOne(alert.id)}
                          aria-label={`Select alert: ${alert.title}`}
                        />
                      </div>
                      <div className={`h-8 w-8 md:h-9 md:w-9 rounded-lg ${sc.bg} flex items-center justify-center shrink-0`}>
                        <Icon className={`w-4 h-4 ${sc.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="text-sm font-semibold">{alert.title}</h3>
                          <Badge className={sc.bg + ' ' + sc.color + ' border-0 text-[10px] h-4 px-1.5'} variant="secondary">{alert.severity}</Badge>
                          <Badge variant="outline" className="text-[10px] h-4 px-1.5">{alert.status}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">{alert.description}</p>
                        <SeverityPathIndicator severity={alert.severity} />
                        {renderAlertActions(alert)}
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      ) : (
        <div className="relative pl-8">
          <div className="absolute left-3 top-2 bottom-2 w-px bg-border" />
          <AnimatePresence mode="popLayout">
            {alerts.map((alert, idx) => {
              const sc = severityConfig[alert.severity] || severityConfig.warning;
              const Icon = sc.icon;
              const isSelected = selectedIds.has(alert.id);
              return (
                <motion.div
                  key={alert.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.2, delay: idx * 0.04 }}
                  className="relative mb-4 last:mb-0"
                >
                  {/* Dot on timeline */}
                  <div className={`absolute -left-8 top-4 h-6 w-6 rounded-full ${sc.bg} flex items-center justify-center z-10 border-2 border-background`}>
                    <div className={`w-2.5 h-2.5 rounded-full ${severityBarColors[alert.severity] || 'bg-muted-foreground'}`} />
                  </div>
                  {/* Card content */}
                  <Card className={`border shadow-sm ${isSelected ? 'ring-2 ring-emerald-500/30' : ''}`}>
                    <CardContent className="p-3 md:p-4">
                      <div className="flex items-start gap-3">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleOne(alert.id)}
                          aria-label={`Select alert: ${alert.title}`}
                          className="mt-1 shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Icon className={`w-4 h-4 ${sc.color} shrink-0`} />
                            <h3 className="text-sm font-semibold">{alert.title}</h3>
                            <Badge className={sc.bg + ' ' + sc.color + ' border-0 text-[10px] h-4 px-1.5'} variant="secondary">{alert.severity}</Badge>
                            <Badge variant="outline" className="text-[10px] h-4 px-1.5">{alert.status}</Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">{alert.description}</p>
                          <SeverityPathIndicator severity={alert.severity} />
                          {renderAlertActions(alert)}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* Server pagination (N-3) */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => { setPage((p) => Math.max(1, p - 1)); setSelectedIds(new Set()); }}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">Page {page} of {totalPages} · {total} total</span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= totalPages}
            onClick={() => { setPage((p) => p + 1); setSelectedIds(new Set()); }}
          >
            Next
          </Button>
        </div>
      )}

      {/* Floating bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-card border shadow-lg rounded-full px-4 py-2 animate-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm font-medium text-foreground">
            {selectedIds.size} selected
          </span>
          <div className="w-px h-5 bg-border" />
          <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-amber-600 hover:text-amber-700" onClick={handleBulkAcknowledge}>
            <AlertTriangle className="w-3.5 h-3.5" /> Acknowledge All
          </Button>
          <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-primary hover:text-primary" onClick={handleBulkResolve}>
            <CheckCircle2 className="w-3.5 h-3.5" /> Resolve All
          </Button>
        </div>
      )}

      {/* Escalation Confirmation Dialog */}
      <AlertDialog open={!!escalateTarget} onOpenChange={(open) => { if (!open) setEscalateTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ArrowUpRight className="w-5 h-5 text-orange-500" />
              Escalate Alert
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Are you sure you want to escalate this alert?
                </p>
                {escalateTarget && (
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1">
                    <p className="text-sm font-medium">{escalateTarget.title}</p>
                    <p className="text-xs text-muted-foreground">{escalateTarget.description}</p>
                    <div className="flex items-center gap-2 mt-2">
                      <Badge className={`${severityConfig[escalateTarget.severity]?.bg || ''} ${severityConfig[escalateTarget.severity]?.color || ''} border-0 text-[10px]`} variant="secondary">
                        {escalateTarget.severity}
                      </Badge>
                      <ChevronRight className="w-3 h-3 text-muted-foreground" />
                      <Badge className={`${severityConfig[getNextSeverity(escalateTarget.severity) || 'warning']?.bg || ''} ${severityConfig[getNextSeverity(escalateTarget.severity) || 'warning']?.color || ''} border-0 text-[10px]`} variant="secondary">
                        {getNextSeverity(escalateTarget.severity)}
                      </Badge>
                    </div>
                  </div>
                )}
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Escalation will change the severity level of this alert and may trigger additional notifications.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-orange-600 hover:bg-orange-700 text-white"
              onClick={() => escalateTarget && escalateAlert(escalateTarget)}
            >
              Escalate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
