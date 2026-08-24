'use client';

import { useState, useCallback, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Brain,
  AlertTriangle,
  ShieldAlert,
  TrendingDown,
  Clock,
  Eye,
  CheckCircle2,
  XCircle,
  Search,
  RefreshCw,
  Activity,
  Users,
  BarChart3,
  Filter,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  CheckCheck,
  ExternalLink,
  BadgeCheck,
  BadgeX,
  Loader2,
  Radar,
  Timer,
  MonitorSmartphone,
  Fingerprint,
  LayoutGrid,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { PresenceDot } from '@/components/ui/presence-dot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { DatePickerWithRange } from '@/components/ui/date-picker-with-range';
import { EmployeeCombobox } from '@/components/employees/employee-combobox';
import { AUTO_DETECTED_TYPES } from '@/lib/anomalies/constants';
import { useAppStore } from '@/lib/store';
import type { DateRange } from 'react-day-picker';
import { toast } from 'sonner';

// ==================== Types ====================

interface AnomalyItem {
  id: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  description: string;
  score: number;
  confidence: number;
  employeeId: string | null;
  deviceId: string | null;
  metadata: string | null;
  aiAnalysis: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  employee?: { id: string; firstName: string; lastName: string; employeeId: string; avatar: string | null; designation: string | null } | null;
  device?: { id: string; name: string; hostname: string | null } | null;
}

interface AnomalyStats {
  total: number;
  bySeverity: { critical: number; high: number; medium: number; low: number };
  byStatus: { detected: number; investigating: number; resolved: number; false_positive: number };
  byType: Record<string, number>;
}

// ==================== Constants ====================

const TYPE_CONFIG: Record<string, { icon: React.ElementType; label: string; color: string; bg: string }> = {
  productivity_drop: { icon: TrendingDown, label: 'Productivity Drop', color: 'text-orange-500', bg: 'bg-orange-100 dark:bg-orange-900/30' },
  excessive_idle: { icon: Timer, label: 'Excessive Idle', color: 'text-amber-500', bg: 'bg-amber-100 dark:bg-amber-900/30' },
  // The persisted type key is `unusual_login` (DB/API compatibility), but the
  // rule actually detects activity OUTSIDE the org's working hours (F-8).
  unusual_login: { icon: Fingerprint, label: 'Off-Hours Activity', color: 'text-violet-500', bg: 'bg-violet-100 dark:bg-violet-900/30' },
  rapid_app_switch: { icon: LayoutGrid, label: 'Rapid App Switch', color: 'text-cyan-500', bg: 'bg-cyan-100 dark:bg-cyan-900/30' },
  overtime_work: { icon: Clock, label: 'Overtime Work', color: 'text-blue-500', bg: 'bg-blue-100 dark:bg-blue-900/30' },
  policy_breach: { icon: ShieldAlert, label: 'Policy Breach', color: 'text-rose-500', bg: 'bg-rose-100 dark:bg-rose-900/30' },
  unusual_screenshot: { icon: MonitorSmartphone, label: 'Unusual Screenshot', color: 'text-pink-500', bg: 'bg-pink-100 dark:bg-pink-900/30' },
  low_activity_spike: { icon: Activity, label: 'Low Activity', color: 'text-slate-500', bg: 'bg-slate-100 dark:bg-slate-800' },
  device_missing: { icon: MonitorSmartphone, label: 'Device Missing', color: 'text-amber-600', bg: 'bg-amber-100 dark:bg-amber-900/30' },
};

const SEVERITY_COLORS: Record<string, { text: string; bg: string; border: string; label: string }> = {
  critical: { text: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-100 dark:bg-rose-900/30', border: 'border-l-rose-500', label: 'Critical' },
  high: { text: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-100 dark:bg-orange-900/30', border: 'border-l-orange-500', label: 'High' },
  medium: { text: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/30', border: 'border-l-amber-500', label: 'Medium' },
  low: { text: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-100 dark:bg-emerald-900/30', border: 'border-l-emerald-500', label: 'Low' },
};

const STATUS_CONFIG: Record<string, { icon: React.ElementType; label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  detected: { icon: Eye, label: 'Detected', variant: 'destructive' },
  investigating: { icon: Search, label: 'Investigating', variant: 'default' },
  resolved: { icon: CheckCircle2, label: 'Resolved', variant: 'secondary' },
  false_positive: { icon: XCircle, label: 'False Positive', variant: 'outline' },
};

// Patch server-confirmed records into every cached ['anomalies'] list entry so
// open UI reflects the new state immediately — no close/reopen required.
function patchAnomaliesCache(
  queryClient: QueryClient,
  updater: (rec: AnomalyItem) => AnomalyItem
) {
  for (const q of queryClient.getQueryCache().findAll({ queryKey: ['anomalies'] })) {
    const state = queryClient.getQueryState<{ data: AnomalyItem[] }>(q.queryKey);
    if (!state?.data?.data) continue;
    queryClient.setQueryData(q.queryKey, {
      ...state.data,
      data: state.data.data.map(updater),
    });
  }
}

// fetch wrapper: only a successful response (res.ok) is treated as success;
// errors carry their HTTP status for precise 401/403/404/409/500 handling.
async function request(url: string, opts: RequestInit) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = new Error(`Request failed: ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ==================== Anomaly Detail Dialog ====================

function AnomalyDetailDialog({ anomalyId, open, onClose }: { anomalyId: string | null; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [newStatus, setNewStatus] = useState('');

  // The dialog fetches its own record by id (authoritative) — it never renders
  // a stale list snapshot that can go out of sync after a mutation.
  const { data: anomaly, isLoading } = useQuery<AnomalyItem>({
    queryKey: ['anomaly-detail', anomalyId],
    queryFn: () => request(`/api/anomalies/${anomalyId}`, {}),
    enabled: open && !!anomalyId,
  });

  const typeConfig = anomaly ? TYPE_CONFIG[anomaly.type] || TYPE_CONFIG.low_activity_spike : TYPE_CONFIG.low_activity_spike;
  const sevConfig = anomaly ? SEVERITY_COLORS[anomaly.severity] || SEVERITY_COLORS.medium : SEVERITY_COLORS.medium;
  const parsedMetadata = anomaly?.metadata ? (() => { try { return JSON.parse(anomaly.metadata); } catch { return null; } })() : null;

  const updateMutation = useMutation({
    mutationFn: async (status: string) =>
      request(`/api/anomalies/${anomalyId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }) as Promise<AnomalyItem>,
    onSuccess: (updated) => {
      // Merge the server-confirmed record into the open dialog AND every
      // cached list entry so the UI reflects it instantly (dialog stays open).
      const current = queryClient.getQueryData<AnomalyItem>(['anomaly-detail', anomalyId]);
      queryClient.setQueryData(['anomaly-detail', anomalyId], current ? { ...current, ...updated } : updated);
      patchAnomaliesCache(queryClient, (rec) =>
        rec.id === updated.id
          ? { ...rec, status: updated.status, resolvedAt: updated.resolvedAt, resolvedBy: updated.resolvedBy }
          : rec
      );
      queryClient.invalidateQueries({ queryKey: ['anomalies'] });
      toast.success(`Anomaly marked as ${updated.status.replace(/_/g, ' ')}`);
      setNewStatus('');
    },
    onError: (err) => {
      const status = (err as { status?: number }).status;
      if (status === 401) toast.error('Your session expired. Please sign in again.');
      else if (status === 403) toast.error("You're not authorized to update this anomaly.");
      else if (status === 404) toast.error('Anomaly not found.');
      else if (status === 409) {
        queryClient.invalidateQueries({ queryKey: ['anomaly-detail', anomalyId] });
        queryClient.invalidateQueries({ queryKey: ['anomalies'] });
        toast.error('The anomaly changed before your action completed. Refreshing the latest status.');
      } else toast.error('Failed to update anomaly');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px] max-h-[85vh] overflow-y-auto">
        {isLoading || !anomaly ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className={`h-8 w-8 rounded-md flex items-center justify-center ${typeConfig.bg}`}>
              <typeConfig.icon className={`h-4 w-4 ${typeConfig.color}`} />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base truncate">{anomaly.title}</DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                {typeConfig.label} · {new Date(anomaly.createdAt).toLocaleString()}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* Badges row */}
          <div className="flex flex-wrap gap-2">
            <Badge variant="destructive" className="text-[10px]">{sevConfig.label}</Badge>
            <Badge variant={STATUS_CONFIG[anomaly.status]?.variant || 'secondary'} className="text-[10px]">
              {STATUS_CONFIG[anomaly.status]?.label || anomaly.status}
            </Badge>
            <Badge variant="outline" className="text-[10px]">Score: {Math.round(anomaly.score)}</Badge>
            <Badge variant="outline" className="text-[10px]">Confidence: {Math.round(anomaly.confidence * 100)}%</Badge>
          </div>

          {/* Score bar */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Anomaly Score</span>
              <span className="font-semibold">{Math.round(anomaly.score)}/100</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <motion.div
                className={`h-full rounded-full ${anomaly.score > 80 ? 'bg-danger' : anomaly.score > 60 ? 'bg-warning' : 'bg-success'}`}
                initial={{ width: 0 }}
                animate={{ width: `${anomaly.score}%` }}
                transition={{ duration: 0.8, ease: 'easeOut' }}
              />
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1">
            <h4 className="text-xs font-medium text-muted-foreground">Description</h4>
            <p className="text-sm leading-relaxed">{anomaly.description}</p>
          </div>

          {/* Employee & Device info (F-22: deep links to the employee/device
              surfaces using the app's store navigation convention) */}
          <div className="grid grid-cols-2 gap-3">
            {anomaly.employee && (
              <div className="space-y-1 p-3 rounded-lg bg-muted/50">
                <span className="text-[10px] text-muted-foreground uppercase font-medium">Employee</span>
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <PresenceDot employeeId={anomaly.employee.id} />
                  <span className="truncate">{anomaly.employee.firstName} {anomaly.employee.lastName}</span>
                </p>
                <p className="text-[10px] text-muted-foreground">{anomaly.employee.employeeId}{anomaly.employee.designation ? ` · ${anomaly.employee.designation}` : ''}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1 h-7 text-[11px]"
                  onClick={() => {
                    const store = useAppStore.getState();
                    store.setCurrentPage('employee-details');
                    store.setPageContext(anomaly.employee!.id);
                    store.setPageContextLabel(`${anomaly.employee!.firstName} ${anomaly.employee!.lastName}`.trim());
                    onClose();
                  }}
                >
                  View employee
                </Button>
              </div>
            )}
            {anomaly.device && (
              <div className="space-y-1 p-3 rounded-lg bg-muted/50">
                <span className="text-[10px] text-muted-foreground uppercase font-medium">Device</span>
                <p className="text-sm font-medium">{anomaly.device.name}</p>
                {anomaly.device.hostname && (
                  <p className="text-[10px] text-muted-foreground">{anomaly.device.hostname}</p>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-1 h-7 text-[11px]"
                  onClick={() => {
                    useAppStore.getState().setCurrentPage('devices');
                    onClose();
                  }}
                >
                  View device
                </Button>
              </div>
            )}
          </div>

          {/* Metadata history chart */}
          {parsedMetadata?.history && Array.isArray(parsedMetadata.history) && (
            <div className="space-y-2">
              <h4 className="text-xs font-medium text-muted-foreground">7-Day Trend</h4>
              <div className="flex items-end gap-1.5 h-16">
                {parsedMetadata.history.slice().reverse().map((item: { date: string; value: number }, i: number) => (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1">
                    <motion.div
                      className={`w-full rounded-t-sm ${item.value > 70 ? 'bg-rose-400' : item.value > 50 ? 'bg-amber-400' : 'bg-emerald-400'}`}
                      initial={{ height: 0 }}
                      animate={{ height: `${(item.value / 100) * 56}px` }}
                      transition={{ delay: i * 0.05, duration: 0.4 }}
                    />
                    <span className="text-[8px] text-muted-foreground">{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI Analysis */}
          {anomaly.aiAnalysis && (
            <div className="space-y-2 p-3 rounded-lg bg-primary/5 border border-primary/10">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <span className="text-xs font-medium text-primary">AI Analysis</span>
              </div>
              <p className="text-xs text-violet-900 dark:text-violet-200 leading-relaxed">{anomaly.aiAnalysis}</p>
            </div>
          )}

          {/* Resolution info */}
          {(anomaly.status === 'resolved' || anomaly.status === 'false_positive') && (
            <div className="text-xs text-muted-foreground space-y-1">
              <p>Resolved by: <span className="font-medium">{anomaly.resolvedBy || 'N/A'}</span></p>
              {anomaly.resolvedAt && <p>Resolved at: {new Date(anomaly.resolvedAt).toLocaleString()}</p>}
            </div>
          )}
        </div>

        {/* Actions */}
        {anomaly.status !== 'resolved' && anomaly.status !== 'false_positive' && (
          <DialogFooter className="gap-2 flex-col sm:flex-row">
            <Select value={newStatus} onValueChange={setNewStatus}>
              <SelectTrigger className="w-full sm:w-[200px] h-9 text-xs">
                <SelectValue placeholder="Change status..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="investigating">
                  <div className="flex items-center gap-2"><Search className="h-3 w-3" /> Investigating</div>
                </SelectItem>
                <SelectItem value="resolved">
                  <div className="flex items-center gap-2"><CheckCircle2 className="h-3 w-3" /> Resolved</div>
                </SelectItem>
                <SelectItem value="false_positive">
                  <div className="flex items-center gap-2"><XCircle className="h-3 w-3" /> False Positive</div>
                </SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={() => updateMutation.mutate(newStatus)}
              disabled={!newStatus || updateMutation.isPending}
            >
              {updateMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Update
            </Button>
          </DialogFooter>
        )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ==================== Anomaly Card ====================

function AnomalyCard({ anomaly, index, selected, onSelect, onViewDetail }: {
  anomaly: AnomalyItem;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onViewDetail: () => void;
}) {
  const typeConfig = TYPE_CONFIG[anomaly.type] || TYPE_CONFIG.low_activity_spike;
  const sevConfig = SEVERITY_COLORS[anomaly.severity] || SEVERITY_COLORS.medium;
  const statusConfig = STATUS_CONFIG[anomaly.status] || STATUS_CONFIG.detected;
  const StatusIcon = statusConfig.icon;
  const TypeIcon = typeConfig.icon;

  return (
    // F-21: the card is a keyboard-accessible action (role=button, Enter/
    // Space) with a visible focus state. Enter/Space only fire when the card
    // itself has focus — never when focus is inside the checkbox or the icon
    // button, so those controls stay independently operable.
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.03, 0.3) }}
      role="button"
      tabIndex={0}
      aria-label={`View anomaly: ${anomaly.title}`}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onViewDetail();
        }
      }}
      className={`falcon-card p-0 cursor-pointer transition-all hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${sevConfig.border} border-l-[3px] ${selected ? 'ring-2 ring-primary/30' : ''}`}
      onClick={onViewDetail}
    >
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          {/* Checkbox + Icon */}
          <div className="flex items-center gap-2 pt-0.5">
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => { e.stopPropagation(); onSelect(); }}
              className="rounded border-muted-foreground/30 h-3.5 w-3.5 cursor-pointer"
            />
            <div className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${typeConfig.bg}`}>
              <TypeIcon className={`h-4 w-4 ${typeConfig.color}`} />
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-sm font-medium truncate max-w-[300px]">{anomaly.title}</h4>
              <Badge variant="destructive" className={`text-[9px] h-4 px-1 ${anomaly.severity === 'critical' ? 'animate-pulse' : ''}`}>
                {sevConfig.label}
              </Badge>
            </div>

            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{anomaly.description}</p>

            {/* Bottom row */}
            <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground/70">
              {anomaly.employee && (
                <span className="flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {anomaly.employee.firstName} {anomaly.employee.lastName}
                </span>
              )}
              <span className="flex items-center gap-1">
                <BarChart3 className="h-3 w-3" />
                Score: {Math.round(anomaly.score)}
              </span>
              <span className="flex items-center gap-1">
                <StatusIcon className="h-3 w-3" />
                {statusConfig.label}
              </span>
              <span className="ml-auto">{new Date(anomaly.createdAt).toLocaleDateString()}</span>
            </div>
          </div>

          {/* Quick actions */}
          <div className="flex flex-col gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onViewDetail}>
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardContent>
    </motion.div>
  );
}

// ==================== Main Page ====================

export function AnomaliesPage() {
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState('');
  const [severityFilter, setSeverityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [detailAnomalyId, setDetailAnomalyId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [showTypes, setShowTypes] = useState(false);
  const [page, setPage] = useState(1);
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Filter/search changes restart pagination at page 1.
  const setFilter = useCallback((setter: (v: string) => void, value: string) => {
    setter(value);
    setPage(1);
  }, []);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['anomalies', typeFilter, severityFilter, statusFilter, search, employeeFilter, dateRange?.from, dateRange?.to, sortBy, sortOrder, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (typeFilter) params.set('type', typeFilter);
      if (severityFilter) params.set('severity', severityFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (search) params.set('search', search);
      // F-20: server-side employee filter, date range and sort (never
      // client-side filtering of a large dataset).
      if (employeeFilter) params.set('employeeId', employeeFilter);
      if (dateRange?.from) params.set('from', dateRange.from.toISOString());
      if (dateRange?.to) params.set('to', dateRange.to.toISOString());
      params.set('sortBy', sortBy);
      params.set('sortOrder', sortOrder);
      params.set('page', String(page));
      params.set('pageSize', '50');
      const res = await fetch(`/api/anomalies?${params}`);
      if (!res.ok) throw new Error('Failed to load anomalies');
      return res.json();
    },
  });

  const anomalies: AnomalyItem[] = useMemo(() => data?.data || [], [data]);
  const stats: AnomalyStats = data?.stats || { total: 0, bySeverity: { critical: 0, high: 0, medium: 0, low: 0 }, byStatus: { detected: 0, investigating: 0, resolved: 0, false_positive: 0 }, byType: {} };
  const totalPages = Math.max(1, data?.totalPages || 1);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === anomalies.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(anomalies.map(a => a.id)));
    }
  }, [anomalies, selectedIds]);

  const viewDetail = useCallback((a: AnomalyItem) => {
    setDetailAnomalyId(a.id);
    setDetailOpen(true);
  }, []);

  // Batch resolve
  const batchMutation = useMutation({
    mutationFn: async (status: string) => {
      const ids = Array.from(selectedIds);
      const res = await fetch('/api/anomalies/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, status }),
      });
      if (!res.ok) throw new Error('Batch update failed');
      return { result: await res.json(), ids, status };
    },
    onSuccess: ({ ids, status, result }) => {
      // Reflect the confirmed status in the open UI immediately, then refetch
      // for authoritative values (resolvedBy/resolvedAt come from the server).
      patchAnomaliesCache(queryClient, (rec) =>
        ids.includes(rec.id) ? { ...rec, status } : rec
      );
      queryClient.invalidateQueries({ queryKey: ['anomalies'] });
      toast.success(
        result.excluded > 0
          ? `${result.updated} anomalies updated (${result.excluded} skipped)`
          : `${result.updated} anomalies updated`
      );
      setSelectedIds(new Set());
    },
    onError: () => toast.error('Batch update failed'),
  });

  // Run detection
  const detectMutation = useMutation({
    mutationFn: async () =>
      request('/api/anomalies/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['anomalies'] });
      toast.success(`Detection complete: ${result.detected} new anomalies found`);
    },
    onError: (err) => {
      const status = (err as { status?: number }).status;
      if (status === 403) toast.error('Anomaly detection is disabled for this organization.');
      else if (status === 401) toast.error('Your session expired. Please sign in again.');
      else toast.error('Detection failed');
    },
  });

  const clearFilters = () => {
    setTypeFilter('');
    setSeverityFilter('');
    setStatusFilter('');
    setSearch('');
    setEmployeeFilter('');
    setDateRange(undefined);
    setSortBy('createdAt');
    setSortOrder('desc');
    setPage(1);
  };
  const hasFilters = typeFilter || severityFilter || statusFilter || search || employeeFilter || dateRange?.from || dateRange?.to || sortBy !== 'createdAt' || sortOrder !== 'desc';

  return (
    <div className="space-y-4" role="region" aria-label="Anomaly Detection">
      {/* Header */}
      <Card className="falcon-card p-0">
        <CardContent className="p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Brain className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-base font-semibold">Anomaly Detection</h2>
                <p className="text-xs text-muted-foreground">Rule-based statistical detection of unusual employee behavior patterns</p>
              </div>
            </div>
            <Button
              onClick={() => detectMutation.mutate()}
              disabled={detectMutation.isPending}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {detectMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Radar className="h-4 w-4 mr-2" />}
              Run Detection
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <Card className="falcon-card p-0">
            <CardContent className="p-3 flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                <Brain className="h-4 w-4 text-violet-600 dark:text-violet-400" />
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">Total Anomalies</p>
                <p className="text-lg font-bold">{stats.total}</p>
              </div>
            </CardContent>
          </Card>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <Card className="falcon-card p-0">
            <CardContent className="p-3 flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
                <ShieldAlert className="h-4 w-4 text-rose-600 dark:text-rose-400" />
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">Critical</p>
                <p className="text-lg font-bold text-rose-600">{stats.bySeverity.critical}</p>
              </div>
            </CardContent>
          </Card>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <Card className="falcon-card p-0">
            <CardContent className="p-3 flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                <AlertTriangle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">Pending</p>
                <p className="text-lg font-bold text-orange-600">{stats.byStatus.detected + stats.byStatus.investigating}</p>
              </div>
            </CardContent>
          </Card>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
          <Card className="falcon-card p-0">
            <CardContent className="p-3 flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">Resolved</p>
                <p className="text-lg font-bold text-emerald-600">{stats.byStatus.resolved}</p>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Severity Distribution Bar */}
      <Card className="falcon-card p-0">
        <CardContent className="p-3">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="text-muted-foreground">Severity Distribution</span>
            <span className="text-muted-foreground">{stats.total} total</span>
          </div>
          <div className="flex h-3 rounded-full overflow-hidden bg-muted">
            {stats.total > 0 && Object.entries(stats.bySeverity)
              .filter(([, count]) => count > 0)
              .map(([sev, count]) => (
                <motion.div
                  key={sev}
                  className={`h-full ${SEVERITY_COLORS[sev]?.bg.replace('/30', '')}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${(count / stats.total) * 100}%` }}
                  transition={{ duration: 0.6, ease: 'easeOut' }}
                  title={`${SEVERITY_COLORS[sev]?.label}: ${count}`}
                />
              ))}
          </div>
          <div className="flex items-center gap-4 mt-2 text-[10px] text-muted-foreground">
            {Object.entries(SEVERITY_COLORS).map(([sev, config]) => (
              <span key={sev} className="flex items-center gap-1">
                <div className={`h-2 w-2 rounded-full ${config.bg} ${config.text}`} />
                {config.label}: {stats.bySeverity[sev as keyof typeof stats.bySeverity]}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Toolbar */}
      <Card className="falcon-card p-0">
        <CardContent className="p-3">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input placeholder="Search anomalies..." value={search} onChange={(e) => setFilter(setSearch, e.target.value)} className="pl-8 h-8 text-xs" />
            </div>
            {/* F-20: server-side employee filter (server-search combobox) */}
            <EmployeeCombobox
              value={employeeFilter || null}
              onValueChange={(v) => setFilter(setEmployeeFilter, (v as string) ?? '')}
              placeholder="All Employees"
              allowClear
              clearLabel="All Employees"
              size="sm"
              className="w-full sm:w-[180px]"
              ariaLabel="Filter by employee"
            />
            {/* F-20: server-side date range on anomaly createdAt */}
            <DatePickerWithRange
              date={dateRange}
              onDateChange={(d) => {
                setDateRange(d);
                setPage(1);
              }}
              className="w-full sm:w-auto"
            />
            {/* F-20: server-side sort (whitelisted keys) */}
            <Select value={`${sortBy}:${sortOrder}`} onValueChange={(v) => {
              const [by, order] = v.split(':');
              setSortBy(by);
              setSortOrder((order as 'asc' | 'desc') || 'desc');
              setPage(1);
            }}>
              <SelectTrigger className="h-8 text-xs w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="createdAt:desc">Newest first</SelectItem>
                <SelectItem value="createdAt:asc">Oldest first</SelectItem>
                <SelectItem value="score:desc">Highest score</SelectItem>
                <SelectItem value="score:asc">Lowest score</SelectItem>
              </SelectContent>
            </Select>
            <Select value={typeFilter || 'all'} onValueChange={(v) => setFilter(setTypeFilter, v === 'all' ? '' : v)}>
              <SelectTrigger className="h-8 text-xs w-[140px]">
                <SelectValue placeholder="All Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {Object.entries(TYPE_CONFIG).map(([key, cfg]) => (
                  <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={severityFilter || 'all'} onValueChange={(v) => setFilter(setSeverityFilter, v === 'all' ? '' : v)}>
              <SelectTrigger className="h-8 text-xs w-[120px]">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Severity</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter || 'all'} onValueChange={(v) => setFilter(setStatusFilter, v === 'all' ? '' : v)}>
              <SelectTrigger className="h-8 text-xs w-[130px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="detected">Detected</SelectItem>
                <SelectItem value="investigating">Investigating</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
                <SelectItem value="false_positive">False Positive</SelectItem>
              </SelectContent>
            </Select>
            {hasFilters && (
              <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearFilters}>
                <XCircle className="h-3 w-3 mr-1" /> Clear
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setShowTypes(!showTypes)}>
              <Filter className="h-3 w-3 mr-1" /> Types {showTypes ? <ChevronUp className="h-3 w-3 ml-1" /> : <ChevronDown className="h-3 w-3 ml-1" />}
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Type Summary (collapsible) */}
      <AnimatePresence>
        {showTypes && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <Card className="falcon-card p-0">
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground mb-2 font-medium">Anomaly Types Reference</p>
                {/* F-11: only the four engine rules are auto-detected — the
                    remaining types are supported (manual creation / agent
                    reporting / historical records) but never auto-generated.
                    The panel states exactly that instead of implying all 8
                    are automatically detected. */}
                <p className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400 mb-1">Automatically detected</p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-3">
                  {AUTO_DETECTED_TYPES.map((key) => {
                    const cfg = TYPE_CONFIG[key];
                    if (!cfg) return null;
                    return (
                      <div key={key} className="flex items-center gap-2 p-2 rounded-md bg-emerald-50 dark:bg-emerald-900/20">
                        <div className={`h-7 w-7 rounded flex items-center justify-center ${cfg.bg}`}>
                          <cfg.icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                        </div>
                        <div>
                          <p className="text-[11px] font-medium">{cfg.label}</p>
                          <p className="text-[10px] text-muted-foreground">{stats.byType[key] || 0} detected</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] font-medium text-muted-foreground mb-1">Supported (manual / agent-reported)</p>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                  {Object.entries(TYPE_CONFIG)
                    .filter(([key]) => !AUTO_DETECTED_TYPES.includes(key as (typeof AUTO_DETECTED_TYPES)[number]))
                    .map(([key, cfg]) => (
                      <div key={key} className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
                        <div className={`h-7 w-7 rounded flex items-center justify-center ${cfg.bg}`}>
                          <cfg.icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                        </div>
                        <div>
                          <p className="text-[11px] font-medium">{cfg.label}</p>
                          <p className="text-[10px] text-muted-foreground">{stats.byType[key] || 0} detected</p>
                        </div>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Batch actions bar */}
      {selectedIds.size > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Card className="falcon-card p-0 border-violet-300 dark:border-violet-700">
            <CardContent className="p-3 flex items-center gap-3 flex-wrap">
              <span className="text-xs font-medium text-violet-600 dark:text-violet-400">
                {selectedIds.size} selected
              </span>
              <div className="flex-1" />
              <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={toggleSelectAll}>
                <CheckCheck className="h-3 w-3 mr-1" />
                {selectedIds.size === anomalies.length ? 'Deselect All' : 'Select All'}
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => batchMutation.mutate('resolved')} disabled={batchMutation.isPending}>
                <BadgeCheck className="h-3 w-3 mr-1 text-emerald-500" /> Resolve
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => batchMutation.mutate('false_positive')} disabled={batchMutation.isPending}>
                <BadgeX className="h-3 w-3 mr-1 text-slate-500" /> False Positive
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Anomaly List */}
      {isError ? (
        // F-19: an API/auth/server failure is NOT "no anomalies" — show a
        // distinct error state with a retry action.
        <Card className="falcon-card p-0">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="h-8 w-8 mx-auto mb-2 text-rose-500" />
            <p className="text-sm font-medium">Failed to load anomalies</p>
            <p className="text-xs text-muted-foreground mt-1">Check your connection or sign in again, then retry.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 h-8 text-xs"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-3 w-3 mr-1 ${isFetching ? 'animate-spin' : ''}`} /> Retry
            </Button>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      ) : anomalies.length === 0 ? (
        <EmptyState
          icon={Brain}
          title="No anomalies detected"
          description="Detection runs on demand against recent activity data — click Run Detection to scan for unusual patterns."
          action={detectMutation.isPending ? undefined : { label: 'Run Detection', onClick: () => detectMutation.mutate() }}
        />
      ) : (
        <div className="space-y-2">
          {anomalies.map((anomaly, idx) => (
            <AnomalyCard
              key={anomaly.id}
              anomaly={anomaly}
              index={idx}
              selected={selectedIds.has(anomaly.id)}
              onSelect={() => toggleSelect(anomaly.id)}
              onViewDetail={() => viewDetail(anomaly)}
            />
          ))}
        </div>
      )}

      {/* Pagination */}
      {!isLoading && anomalies.length > 0 && totalPages > 1 && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">
            Page {page} of {totalPages} · {data?.total ?? 0} anomalies
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-7 text-[11px]" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronLeft className="h-3 w-3 mr-1" /> Previous
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-[11px]" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
        </div>
      )}

      <AnomalyDetailDialog
        anomalyId={detailAnomalyId}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setDetailAnomalyId(null);
        }}
      />
    </div>
  );
}
