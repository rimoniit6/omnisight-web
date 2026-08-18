'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  Pause,
  Activity,
  Timer,
  WifiOff,
  Search,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Clock,
  User,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { PresenceDot } from '@/components/ui/presence-dot';
import { EmptyState } from '@/components/ui/empty-state';
import { useCurrentUser } from '@/hooks/use-current-user';
import { AlertTriangle } from 'lucide-react';

// ==================== Types ====================

interface EmployeeBreakStatus {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  avatar: string | null;
  designation: string | null;
  department: { id: string; name: string } | null;
  device: { id: string; name: string; hostname: string; status: string; lastHeartbeat: string } | null;
  status: 'breaking' | 'active' | 'offline';
  isOnBreak: boolean;
  lastActivity: string | null;
  breakTimeToday: number;
}

interface SummaryData {
  totalEmployees: number;
  currentlyOnBreak: number;
  activeNow: number;
  offlineToday: number;
  avgBreakTimeToday: number;
  totalBreakTimeToday: number;
  breakByDepartment: Array<{
    departmentName: string;
    onBreak: number;
    total: number;
    percentage: number;
  }>;
}

interface BreakEvent {
  id: string;
  employeeName: string;
  department: string | null;
  source: string;
  startedAt: string;
  endedAt: string | null;
  active: boolean;
  durationSeconds: number;
}

// ==================== Helpers ====================

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ${diffMin % 60}m ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function getInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

function formatBreakTime(minutes: number): string {
  if (minutes < 1) return '0m';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ==================== Stat Cards ====================

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ElementType;
  accentColor: string;
  bgColor: string;
  subtitle?: string;
  isLoading?: boolean;
}

function StatCard({ label, value, icon: Icon, accentColor, bgColor, subtitle, isLoading }: StatCardProps) {
  return (
    <Card className="falcon-card p-0">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={`h-10 w-10 rounded-lg ${bgColor} flex items-center justify-center shrink-0`}>
            <Icon className={`h-5 w-5 ${accentColor}`} />
          </div>
          <div className="min-w-0 flex-1">
            {isLoading ? (
              <>
                <Skeleton className="h-3 w-16 mb-1.5" />
                <Skeleton className="h-6 w-10 mb-1" />
                {subtitle && <Skeleton className="h-3 w-24" />}
              </>
            ) : (
              <>
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
                <p className={`text-2xl font-bold ${accentColor} leading-tight`}>
                  {value}
                </p>
                {subtitle && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>
                )}
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ==================== Status Badge ====================

function StatusBadge({ status }: { status: 'breaking' | 'active' | 'offline' }) {
  if (status === 'breaking') {
    return (
      <Badge className="bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800">
        <Pause className="h-3 w-3 mr-0.5" />
        On Break
      </Badge>
    );
  }
  if (status === 'active') {
    return (
      <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800">
        <Activity className="h-3 w-3 mr-0.5" />
        Active
      </Badge>
    );
  }
  return (
    <Badge className="bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700">
      <WifiOff className="h-3 w-3 mr-0.5" />
      Offline
    </Badge>
  );
}

// ==================== Table Skeleton ====================

function TableSkeleton() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <TableRow key={i} className={i % 2 === 1 ? 'bg-muted/30' : ''}>
          <TableCell>
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div>
                <Skeleton className="h-4 w-28 mb-1" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          </TableCell>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-5 w-16 rounded-md" /></TableCell>
          <TableCell><Skeleton className="h-4 w-16" /></TableCell>
          <TableCell><Skeleton className="h-4 w-14" /></TableCell>
          <TableCell><Skeleton className="h-8 w-20 rounded-md" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}

// ==================== Department Break Bars ====================

function DepartmentBreakBars({ data, isLoading }: { data: SummaryData['breakByDepartment']; isLoading: boolean }) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-4 w-28" />
            <div className="flex-1">
              <Skeleton className="h-4 w-full rounded-full" />
            </div>
            <Skeleton className="h-4 w-12" />
          </div>
        ))}
      </div>
    );
  }

  if (data.length === 0) return null;

  return (
    <div className="space-y-3">
      {data.map((dept) => (
        <div key={dept.departmentName} className="flex items-center gap-3">
          <span className="text-xs font-medium text-foreground w-28 truncate shrink-0">
            {dept.departmentName}
          </span>
          <div className="flex-1">
            <div className="h-4 w-full rounded-full bg-muted/50 overflow-hidden">
              <motion.div
                className="h-full rounded-full bg-amber-500"
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(dept.percentage, 100)}%` }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
              />
            </div>
          </div>
          <div className="text-xs text-muted-foreground w-auto shrink-0 text-right">
            <span className="font-medium text-amber-600 dark:text-amber-400">{dept.onBreak}</span>
            <span className="text-muted-foreground"> / {dept.total}</span>
            <span className="ml-1.5">({dept.percentage}%)</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ==================== Main Page ====================

export function BreakStatusPage() {
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  // API RBAC is the security boundary; this is UX only — a viewer/manager must
  // not see admin-only mutation buttons they cannot use.
  const isAdmin = !!user && ['admin', 'owner', 'super_admin'].includes(user.role);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    employee: EmployeeBreakStatus | null;
    action: 'start' | 'end';
  }>({ open: false, employee: null, action: 'start' });
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce search
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearchDebounced(search), 300);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [search]);

  // Fetch summary stats
  const { data: summary, isLoading: summaryLoading, isError: summaryError } = useQuery<SummaryData>({
    queryKey: ['break-summary'],
    queryFn: async () => {
      const res = await fetch('/api/break-status/summary');
      if (!res.ok) throw new Error('Failed to fetch summary');
      return res.json();
    },
    refetchInterval: autoRefresh ? 30000 : false,
  });

  // Fetch employee break status
  const { data: statusData, isLoading: statusLoading, isError: statusError, dataUpdatedAt } = useQuery<{
    data: EmployeeBreakStatus[];
    total: number;
    currentlyOnBreak: number;
    totalPages: number;
  }>({
    queryKey: ['break-status', statusFilter, searchDebounced, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('status', statusFilter);
      params.set('page', String(page));
      params.set('pageSize', '50');
      if (searchDebounced) params.set('search', searchDebounced);
      const res = await fetch(`/api/break-status?${params}`);
      if (!res.ok) throw new Error('Failed to fetch status');
      return res.json();
    },
    refetchInterval: autoRefresh ? 30000 : false,
  });

  // Counter for "last updated X seconds ago" — anchored to react-query's
  // dataUpdatedAt (server fetch time) instead of manual state, so no
  // setState-in-effect is needed when fresh data arrives.
  useEffect(() => {
    if (!dataUpdatedAt) return;
    const interval = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - dataUpdatedAt) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [dataUpdatedAt]);

  // Fetch break history from the CANONICAL break-history endpoint (BreakSession
  // rows — org-scoped, org-timezone day window, paginated). Audit logs are an
  // audit trail only and are no longer the history source.
  const { data: historyData } = useQuery<{ data: BreakEvent[]; total: number }>({
    queryKey: ['break-history'],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('pageSize', '50');
      const res = await fetch(`/api/break-status/history?${params}`);
      if (!res.ok) throw new Error('Failed to fetch history');
      return res.json();
    },
    refetchInterval: autoRefresh ? 30000 : false,
  });

  // Toggle break handler
  const handleToggle = useCallback(async (employee: EmployeeBreakStatus) => {
    setTogglingId(employee.id);
    try {
      setConfirmDialog({ open: false, employee: null, action: 'start' });

      const res = await fetch(`/api/break-status/${employee.id}/toggle`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to toggle break');

      const result = await res.json();
      toast.success(result.message);

      // Invalidate queries to refresh data
      await queryClient.invalidateQueries({ queryKey: ['break-status'] });
      await queryClient.invalidateQueries({ queryKey: ['break-summary'] });
      await queryClient.invalidateQueries({ queryKey: ['break-history'] });
    } catch {
      toast.error('Failed to toggle break mode');
    } finally {
      setTogglingId(null);
    }
  }, [queryClient]);

  const openConfirmDialog = (employee: EmployeeBreakStatus, action: 'start' | 'end') => {
    setConfirmDialog({ open: true, employee, action });
  };

  const employees = statusData?.data || [];

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Break Monitor</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Track and manage employee break &amp; privacy status in real-time
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            <span>Last updated: {secondsAgo < 1 ? 'just now' : `${secondsAgo}s ago`}</span>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="auto-refresh"
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
              className="data-[state=checked]:bg-emerald-600"
            />
            <label htmlFor="auto-refresh" className="text-xs font-medium text-muted-foreground cursor-pointer">
              Auto-refresh
            </label>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['break-status'] });
              queryClient.invalidateQueries({ queryKey: ['break-summary'] });
              queryClient.invalidateQueries({ queryKey: ['break-history'] });
            }}
            className="h-8"
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Error state — never silently render "no data" when the API failed */}
      {(statusError || summaryError) && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 dark:bg-rose-900/20 dark:border-rose-800 px-4 py-3 text-sm text-rose-700 dark:text-rose-400">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>Failed to load break data. The server may be unavailable — showing nothing would be misleading.</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['break-status'] });
              queryClient.invalidateQueries({ queryKey: ['break-summary'] });
              queryClient.invalidateQueries({ queryKey: ['break-history'] });
            }}
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Retry
          </Button>
        </div>
      )}

      {/* Summary Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="On Break"
          value={summary?.currentlyOnBreak ?? '—'}
          icon={Pause}
          accentColor="text-amber-600 dark:text-amber-400"
          bgColor="bg-amber-100 dark:bg-amber-900/20"
          subtitle={`${summary?.totalEmployees ?? 0} total employees`}
          isLoading={summaryLoading}
        />
        <StatCard
          label="Active Now"
          value={summary?.activeNow ?? '—'}
          icon={Activity}
          accentColor="text-emerald-600 dark:text-emerald-400"
          bgColor="bg-emerald-100 dark:bg-emerald-900/20"
          subtitle="Activity in last 5 min"
          isLoading={summaryLoading}
        />
        <StatCard
          label="Avg Break Today"
          value={summary ? formatBreakTime(summary.avgBreakTimeToday) : '—'}
          icon={Timer}
          accentColor="text-sky-600 dark:text-sky-400"
          bgColor="bg-sky-100 dark:bg-sky-900/20"
          subtitle={`Total: ${summary ? formatBreakTime(summary.totalBreakTimeToday) : '—'}`}
          isLoading={summaryLoading}
        />
        <StatCard
          label="Offline Today"
          value={summary?.offlineToday ?? '—'}
          icon={WifiOff}
          accentColor="text-slate-600 dark:text-slate-400"
          bgColor="bg-slate-100 dark:bg-slate-800/50"
          subtitle="No activity today"
          isLoading={summaryLoading}
        />
      </div>

      {/* Department Break Overview */}
      <Card className="falcon-card p-0">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold">Department Break Overview</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Break percentage by department
              </p>
            </div>
          </div>
          <DepartmentBreakBars
            data={summary?.breakByDepartment || []}
            isLoading={summaryLoading}
          />
        </CardContent>
      </Card>

      {/* Employee Break Status Table */}
      <Card className="falcon-card p-0">
        <CardContent className="p-4">
          {/* Filter bar */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 mb-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or ID..."
                className="pl-9 h-9"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              />
            </div>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
              <SelectTrigger className="w-[160px] h-9">
                <SelectValue placeholder="Filter status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="breaking">On Break</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="offline">Offline</SelectItem>
              </SelectContent>
            </Select>
            <div className="text-xs text-muted-foreground ml-auto">
              {statusData ? `${statusData.total} employee${statusData.total !== 1 ? 's' : ''}` : '...'}
            </div>
          </div>

          {/* Table */}
          <div className="rounded-md border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="text-xs font-semibold">Employee</TableHead>
                  <TableHead className="text-xs font-semibold">Department</TableHead>
                  <TableHead className="text-xs font-semibold hidden md:table-cell">Device</TableHead>
                  <TableHead className="text-xs font-semibold">Status</TableHead>
                  <TableHead className="text-xs font-semibold hidden sm:table-cell">Last Activity</TableHead>
                  <TableHead className="text-xs font-semibold hidden lg:table-cell">Break Time</TableHead>
                  <TableHead className="text-xs font-semibold text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {statusLoading ? (
                  <TableSkeleton />
                ) : statusError ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10">
                      <div className="flex flex-col items-center gap-3 text-center">
                        <AlertTriangle className="h-8 w-8 text-rose-500/60" />
                        <p className="text-sm text-rose-600 dark:text-rose-400">
                          Could not load break status data.
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => queryClient.invalidateQueries({ queryKey: ['break-status'] })}
                        >
                          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                          Retry
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : employees.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <EmptyState
                        icon={Pause}
                        title="No employees found"
                        description={
                          search
                            ? `No employees match "${search}" with the current filter.`
                            : 'No break status data available.'
                        }
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  <AnimatePresence mode="popLayout">
                    {employees.map((emp, index) => (
                      <motion.tr
                        key={emp.id}
                        layout
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -8 }}
                        transition={{ duration: 0.2, delay: index * 0.02 }}
                        className={`border-b transition-colors hover:bg-muted/50 ${index % 2 === 1 ? 'bg-muted/30' : ''}`}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <Avatar className="h-8 w-8">
                              <AvatarFallback className="text-[10px] bg-primary/10 text-primary font-semibold">
                                {getInitials(emp.firstName, emp.lastName)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="flex items-center gap-1.5 text-sm font-medium truncate">
                                <PresenceDot employeeId={emp.id} />
                                <span className="truncate">{emp.firstName} {emp.lastName}</span>
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {emp.employeeId}
                              </p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {emp.department?.name || '—'}
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="text-sm text-muted-foreground">
                            {emp.device?.name || (
                              <span className="text-slate-400">No device</span>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={emp.status} />
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <span className="text-xs text-muted-foreground">
                            {formatRelativeTime(emp.lastActivity)}
                          </span>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <span className="text-xs text-muted-foreground">
                            {formatBreakTime(emp.breakTimeToday)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          {!isAdmin ? (
                            <span className="text-xs text-muted-foreground">View only</span>
                          ) : emp.status === 'breaking' ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs text-primary border-primary/30 hover:bg-primary/10 hover:text-primary"
                              disabled={togglingId === emp.id}
                              onClick={() => openConfirmDialog(emp, 'end')}
                            >
                              {togglingId === emp.id ? (
                                <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                              ) : (
                                <Activity className="h-3 w-3 mr-1" />
                              )}
                              End Break
                            </Button>
                          ) : emp.status === 'active' ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs text-amber-600 border-amber-300 hover:bg-amber-50 hover:text-amber-700"
                              disabled={togglingId === emp.id}
                              onClick={() => openConfirmDialog(emp, 'start')}
                            >
                              {togglingId === emp.id ? (
                                <RefreshCw className="h-3 w-3 mr-1 animate-spin" />
                              ) : (
                                <Pause className="h-3 w-3 mr-1" />
                              )}
                              Force Break
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </motion.tr>
                    ))}
                  </AnimatePresence>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination — server-side (validated page/pageSize) */}
          {statusData && statusData.totalPages > 1 && (
            <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
              <span>
                Page {page} of {statusData.totalPages} · {statusData.total} employees
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={page >= statusData.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Break History Panel */}
      <Card className="falcon-card p-0">
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger className="w-full">
            <div className="flex items-center justify-between p-4 hover:bg-muted/30 transition-colors rounded-t-xl">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">Break History</h3>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  Today
                </Badge>
              </div>
              {historyOpen ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </div>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-4 pb-4 border-t border-border">
              {historyData && historyData.data && historyData.data.length > 0 ? (
                <div className="mt-3 space-y-2 max-h-72 overflow-y-auto custom-scrollbar">
                  {historyData.data.map((event) => {
                    const isActive = event.active;
                    return (
                      <div
                        key={event.id}
                        className={`flex items-center gap-2.5 py-2 px-3 rounded-md text-xs ${
                          isActive
                            ? 'bg-amber-50 dark:bg-amber-900/15 border border-amber-100 dark:border-amber-800/30'
                            : 'bg-emerald-50 dark:bg-emerald-900/15 border border-emerald-100 dark:border-emerald-800/30'
                        }`}
                      >
                        <div
                          className={`h-5 w-5 rounded-full flex items-center justify-center shrink-0 ${
                            isActive
                              ? 'bg-amber-200 dark:bg-amber-800/40'
                              : 'bg-emerald-200 dark:bg-emerald-800/40'
                          }`}
                        >
                          {isActive ? (
                            <Pause className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                          ) : (
                            <Activity className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                          )}
                        </div>
                        <span className="flex-1 text-muted-foreground truncate">
                          {event.employeeName}
                          {event.department ? ` · ${event.department}` : ''}
                          {' · '}
                          {isActive ? 'Break in progress' : 'Break ended'}
                        </span>
                        <span className="text-muted-foreground shrink-0 tabular-nums">
                          {event.durationSeconds > 0 ? formatBreakTime(Math.round(event.durationSeconds / 60)) : '—'}
                        </span>
                        <span className="text-muted-foreground shrink-0 tabular-nums">
                          {formatTime(event.startedAt)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-3 py-6 text-center">
                  <User className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
                  <p className="text-sm text-muted-foreground">No break events today</p>
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </Card>

      {/* Confirmation Dialog */}
      <AlertDialog
        open={confirmDialog.open}
        onOpenChange={(open) => {
          if (!open) setConfirmDialog({ open: false, employee: null, action: 'start' });
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmDialog.action === 'start'
                ? 'Force Start Break Mode'
                : 'Force End Break Mode'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDialog.action === 'start' ? (
                <>
                  You are about to <span className="font-semibold text-amber-600">force start break mode</span> for{' '}
                  <span className="font-semibold">
                    {confirmDialog.employee?.firstName} {confirmDialog.employee?.lastName}
                  </span>{' '}
                  ({confirmDialog.employee?.employeeId}). This will pause monitoring for this employee
                  and create an audit log entry.
                </>
              ) : (
                <>
                  You are about to <span className="font-semibold text-primary">force end break mode</span> for{' '}
                  <span className="font-semibold">
                    {confirmDialog.employee?.firstName} {confirmDialog.employee?.lastName}
                  </span>{' '}
                  ({confirmDialog.employee?.employeeId}). This will resume monitoring for this employee
                  and create an audit log entry.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDialog.employee && handleToggle(confirmDialog.employee)}
              className={
                confirmDialog.action === 'start'
                  ? 'bg-amber-600 hover:bg-amber-700 text-white'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white'
              }
            >
              {confirmDialog.action === 'start' ? 'Start Break' : 'End Break'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
