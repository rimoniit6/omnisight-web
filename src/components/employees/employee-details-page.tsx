'use client';

import { useQuery, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { useMemo, useState, useEffect } from 'react';
import { type DateRange } from 'react-day-picker';
import { subDays, format } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { EmployeeDialog } from './employee-dialog';
import { PresenceDot } from '@/components/ui/presence-dot';
import { ManageProjectsDialog } from './manage-projects-dialog';
import { AgentAccountCard } from './agent-account-card';
import { KeyboardActivityPanel } from './telemetry/keyboard-activity-panel';
import { LocationPanel } from './telemetry/location-panel';
import { WebcamPanel } from './telemetry/webcam-panel';
import { WebsiteDomainsPanel } from './telemetry/website-domains-panel';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { DatePickerWithRange } from '@/components/ui/date-picker-with-range';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  Mail,
  Phone,
  Calendar,
  Building2,
  Monitor,
  Clock,
  CheckCircle2,
  AlertTriangle,
  MinusCircle,
  Timer,
  TrendingUp,
  TrendingDown,
  AppWindow,
  Globe,
  ArrowLeft,
  Edit2,
  Archive,
  Download,
  Activity,
  Coffee,
  Wifi,
  WifiOff,
  Briefcase,
  Hash,
  FileText,
  Bell,
  AlertOctagon,
  Zap,
  Users,
  FolderKanban,
  Plus,
  UserMinus,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useAppStore } from '@/lib/store';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import { useTheme } from 'next-themes';
import { exportToCSV } from '@/lib/csv-export';
import { PdfDownloadButton } from '@/components/reports/pdf-download-button';
import { consumePendingEmployeeTab } from '@/lib/employee-details-tab';
import { isHeartbeatFresh } from '@/lib/presence';

const PIE_COLORS = ['var(--success)', 'var(--warning)', 'var(--danger)'];

const statusConfig: Record<string, { label: string; class: string; icon: typeof CheckCircle2 }> = {
  active: { label: 'Active', class: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300', icon: CheckCircle2 },
  inactive: { label: 'Inactive', class: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300', icon: MinusCircle },
  archived: { label: 'Archived', class: 'bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400', icon: Archive },
};

const deviceStatusColors: Record<string, string> = {
  online: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  offline: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  maintenance: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  inactive: 'bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400',
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatHours(seconds: number): string {
  return (seconds / 3600).toFixed(1);
}

function ScoreRing({ percentage, size = 120, strokeWidth = 10, label }: { percentage: number; size?: number; strokeWidth?: number; label?: string }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (circumference * percentage) / 100;

  const color = percentage >= 70 ? 'var(--success)' : percentage >= 40 ? 'var(--warning)' : 'var(--danger)';

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <defs>
            <linearGradient id={`ringGradient-${size}`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor={color} />
              <stop offset="100%" stopColor={color === 'var(--success)' ? 'var(--info)' : color === 'var(--warning)' ? 'var(--warning)' : 'var(--danger)'} />
            </linearGradient>
          </defs>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--muted)" strokeWidth={strokeWidth} opacity={0.3} />
          <circle
            cx={size / 2} cy={size / 2} r={radius} fill="none"
            stroke={`url(#ringGradient-${size})`}
            strokeWidth={strokeWidth} strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(0.4, 0, 0.2, 1)' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold" style={{ color }}>{percentage}%</span>
        </div>
      </div>
      {label && <p className="text-xs text-muted-foreground mt-2 font-medium">{label}</p>}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, subValue, color = 'emerald', trend }: {
  icon: typeof Timer; label: string; value: string; subValue?: string; color?: string; trend?: 'up' | 'down' | 'neutral';
}) {
  const colorClasses: Record<string, string> = {
    emerald: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400',
    teal: 'bg-teal-50 text-teal-600 dark:bg-teal-900/20 dark:text-teal-400',
    cyan: 'bg-cyan-50 text-cyan-600 dark:bg-cyan-900/20 dark:text-cyan-400',
    amber: 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400',
    rose: 'bg-rose-50 text-rose-600 dark:bg-rose-900/20 dark:text-rose-400',
    slate: 'bg-slate-50 text-slate-600 dark:bg-slate-900/20 dark:text-slate-400',
  };

  return (
    <div className="relative overflow-hidden group p-4 rounded-xl border bg-card hover:shadow-md transition-all duration-300">
      <div className="absolute top-0 right-0 w-20 h-20 -translate-y-1/2 translate-x-1/2 rounded-full bg-gradient-to-br from-primary/5 to-transparent group-hover:scale-150 transition-transform duration-500" />
      <div className="flex items-start gap-3 relative">
        <div className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${colorClasses[color] || colorClasses.emerald}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground font-medium">{label}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className="text-lg font-bold leading-tight">{value}</p>
            {trend && (
              <span className={`inline-flex items-center text-xs ${trend === 'up' ? 'text-emerald-600' : trend === 'down' ? 'text-rose-600' : 'text-muted-foreground'}`}>
                {trend === 'up' ? <TrendingUp className="w-3 h-3" /> : trend === 'down' ? <TrendingDown className="w-3 h-3" /> : null}
              </span>
            )}
          </div>
          {subValue && <p className="text-[11px] text-muted-foreground mt-0.5">{subValue}</p>}
        </div>
      </div>
    </div>
  );
}

function MiniBar({ label, value, max, color = 'bg-emerald-500', duration }: {
  label: string; value: number; max: number; color?: string; duration?: string;
}) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate max-w-[60%]">{label}</span>
        {duration && <span className="text-muted-foreground">{duration}</span>}
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function EmployeeDetailsPage() {
  const pageContext = useAppStore((s) => s.pageContext);
  const setCurrentPage = useAppStore((s) => s.setCurrentPage);
  const setPageContextLabel = useAppStore((s) => s.setPageContextLabel);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const queryClient = useQueryClient();

  const employeeId = pageContext;

  // Controlled tab state — initialized from the deep-link slot (set by the
  // Employee Portal telemetry cards) so a summary surface can open this page
  // on the exact tab it links to. Falls back to 'overview'.
  const [activeTab, setActiveTab] = useState<string>(() => consumePendingEmployeeTab() ?? 'overview');

  // Edit / Manage-Projects dialogs live on this page (the old flow dispatched
  // a custom event that only EmployeesPage listened to — dead code while the
  // details page is mounted, so Edit never worked).
  const [editOpen, setEditOpen] = useState(false);
  const [manageProjectsOpen, setManageProjectsOpen] = useState(false);

  // Date range state
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => ({
    from: subDays(new Date(), 6),
    to: new Date(),
  }));

  // Render pulse (60s): forces freshness-derived UI — "Last heartbeat: X
  // ago", online/offline badges, break-status attributes — to recompute even
  // when the 60s fallback refetch returns byte-identical data. React Query's
  // structural sharing keeps the data reference stable and React bails out of
  // the re-render, which would otherwise leave relative timestamps frozen at
  // their first-render value while the agent is offline. Same cadence as the
  // refetch below, zero network.
  const [, setPulse] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setPulse((x) => x + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['employee-details', employeeId, dateRange?.from?.toISOString(), dateRange?.to?.toISOString()],
    queryFn: async () => {
      if (!employeeId) return null;
      const params = new URLSearchParams();
      if (dateRange?.from) params.set('from', format(dateRange.from, 'yyyy-MM-dd'));
      if (dateRange?.to) params.set('to', format(dateRange.to, 'yyyy-MM-dd'));
      const res = await fetch(`/api/employees/${employeeId}/detail?${params}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!employeeId,
    // Bounded freshness fallback (mounted only): WebSocket transitions
    // (employee-presence / device-status / activity-ping) are the fast path;
    // this caps staleness at 60s for live fields like device status even if a
    // realtime event was missed. Never refetches in the background.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const emp = data?.employee;
  const range = data?.range;
  const allTime = data?.allTime;
  const dailyProductivity = data?.dailyProductivity || [];
  const hourlyDistribution = data?.hourlyDistribution || [];
  const topApplications = data?.topApplications || [];
  const topWebsites = data?.topWebsites || [];
  const alerts = data?.alerts || [];
  const notifications = data?.notifications || [];

  // ── Paginated activity timeline ─────────────────────────────────────────
  // The COMPLETE dataset stays reachable page by page (never a silent cap),
  // with the same org-local date range as the rest of the detail view. The
  // dedicated endpoint shares the NULL-safe internal-agent exclusion, so the
  // timeline totals agree with the summary stats.
  const fromStr = dateRange?.from ? format(dateRange.from, 'yyyy-MM-dd') : undefined;
  const toStr = dateRange?.to ? format(dateRange.to, 'yyyy-MM-dd') : undefined;
  interface EmployeeActivitiesPage {
    data: Array<Record<string, unknown>>;
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }
  const {
    data: activitiesData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetching: activitiesLoading,
  } = useInfiniteQuery<EmployeeActivitiesPage>({
    queryKey: ['employee-activities', employeeId, fromStr, toStr],
    queryFn: async ({ pageParam }) => {
      if (!employeeId) return { data: [], total: 0, page: 1, pageSize: 50, totalPages: 0 };
      const params = new URLSearchParams({ page: String(pageParam), pageSize: '50' });
      if (fromStr) params.set('from', fromStr);
      if (toStr) params.set('to', toStr);
      const res = await fetch(`/api/employees/${employeeId}/activities?${params}`);
      if (!res.ok) return { data: [], total: 0, page: pageParam, pageSize: 50, totalPages: 0 };
      return res.json();
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.totalPages && lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
    enabled: !!employeeId,
  });

  const activities = useMemo(
    () => (activitiesData?.pages ?? []).flatMap((p) => p.data ?? []),
    [activitiesData]
  );
  const activitiesTotal = activitiesData?.pages?.[0]?.total ?? 0;

  // Projects the employee is (or was) assigned to.
  const { data: projectsData } = useQuery<{ data: Array<Record<string, unknown>> }>({
    queryKey: ['employee-projects', employeeId],
    queryFn: async () => {
      if (!employeeId) return { data: [] };
      const res = await fetch(`/api/employees/${employeeId}/projects`);
      if (!res.ok) return { data: [] };
      return res.json();
    },
    enabled: !!employeeId,
  });
  const memberships = projectsData?.data || [];
  const activeMemberships = memberships.filter((m) => !m.leftAt);
  const pastMemberships = memberships.filter((m) => m.leftAt);

  // Keep the header breadcrumb human-readable: the employee's name (fallback:
  // email) — never the raw internal DB id.
  useEffect(() => {
    if (!emp) return;
    setPageContextLabel(`${emp.firstName} ${emp.lastName}`.trim() || emp.email || '');
  }, [emp, setPageContextLabel]);

  const handleEmployeeSaved = () => {
    // Refresh detail, project membership, list, and any project views.
    queryClient.invalidateQueries({ queryKey: ['employee-details'] });
    queryClient.invalidateQueries({ queryKey: ['employee-projects'] });
    queryClient.invalidateQueries({ queryKey: ['employees'] });
    queryClient.invalidateQueries({ queryKey: ['employee-statistics'] });
    queryClient.invalidateQueries({ queryKey: ['project-members'] });
  };

  const handleProjectsSaved = () => {
    queryClient.invalidateQueries({ queryKey: ['employee-projects'] });
    queryClient.invalidateQueries({ queryKey: ['employee-details'] });
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    queryClient.invalidateQueries({ queryKey: ['project-members'] });
  };

  // Computed values
  const productivePct = range?.productivityScore || 0;
  const totalTime = range?.totalDuration || 1;

  const pieData = useMemo(() => [
    { name: 'Productive', value: Math.round((range?.productiveTime || 0) / 60), color: PIE_COLORS[0] },
    { name: 'Neutral', value: Math.round((range?.neutralTime || 0) / 60), color: PIE_COLORS[1] },
    { name: 'Unproductive', value: Math.round((range?.unproductiveTime || 0) / 60), color: PIE_COLORS[2] },
  ], [range]);

  const chartTextColor = isDark ? '#a1a1aa' : '#71717a';
  const chartGridColor = isDark ? '#27272a' : '#e4e4e7';

  const handleExport = async () => {
    if (!emp) return;
    // Export the COMPLETE selected dataset — loop every page of the paginated
    // timeline endpoint (never just the loaded pages / a hardcoded slice).
    const collected: Array<Record<string, unknown>> = [];
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages && page <= 500) {
      const params = new URLSearchParams({ page: String(page), pageSize: '100' });
      if (fromStr) params.set('from', fromStr);
      if (toStr) params.set('to', toStr);
      const res = await fetch(`/api/employees/${emp.id}/activities?${params}`);
      if (!res.ok) break;
      const body = await res.json();
      collected.push(...(body.data ?? []));
      totalPages = body.totalPages ?? 1;
      page += 1;
    }
    const exportData = collected.map((a: Record<string, unknown>) => ({
      'Timestamp': a.timestamp ? format(new Date(a.timestamp as string), 'yyyy-MM-dd HH:mm') : '',
      'Type': a.type || '',
      'Application': a.applicationName || '',
      'Title': a.title || '',
      'URL': a.url || '',
      'Category': a.category || '',
      'Duration (minutes)': Math.round((a.duration as number) / 60),
      'Device': (a.device as Record<string, string>)?.name || '',
    }));
    exportToCSV(exportData, `employee-${emp.firstName}-${emp.lastName}-activities`);
    toast.success(`Activity data exported (${exportData.length} rows)`);
  };

  const handleArchive = async () => {
    if (!emp) return;
    try {
      await fetch(`/api/employees/${emp.id}`, { method: 'DELETE' });
      toast.success('Employee archived');
      setCurrentPage('employees');
    } catch {
      toast.error('Failed to archive employee');
    }
  };

  // Redirect if no employeeId
  useEffect(() => {
    if (!employeeId) {
      setCurrentPage('employees');
    }
  }, [employeeId, setCurrentPage]);

  if (!employeeId) return null;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
    );
  }

  if (isError || !emp) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-4">
        <AlertOctagon className="w-12 h-12 text-muted-foreground" />
        <p className="text-muted-foreground">Employee not found or failed to load.</p>
        <Button variant="outline" onClick={() => setCurrentPage('employees')}>
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Employees
        </Button>
      </div>
    );
  }

  const sc = statusConfig[emp.status] || statusConfig.active;
  const StatusIcon = sc.icon;

  return (
    <div className="space-y-6">
      {/* Breadcrumb / Back */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <Button variant="ghost" size="sm" onClick={() => setCurrentPage('employees')} className="text-muted-foreground hover:text-foreground -ml-2">
          <ArrowLeft className="w-4 h-4 mr-1.5" />
          Back to Employees
        </Button>
      </motion.div>

      {/* Employee Header Card */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
      >
        <Card className="overflow-hidden border-0 shadow-lg">
          <div className="relative">
            {/* Gradient banner */}
            <div className="h-28 bg-gradient-to-r from-primary to-primary/80" />
            <div className="absolute inset-0 h-28 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGNpcmNsZSBjeD0iMjAiIGN5PSIyMCIgcj0iMSIgZmlsbD0icmdiYSgyNTUsMjU1LDI1NSwwLjEpIi8+PC9zdmc+')] opacity-50" />
            
            <div className="px-6 pb-4 -mt-12 relative">
              <div className="flex flex-col sm:flex-row items-start gap-4">
                {/* Avatar */}
                <Avatar className="h-24 w-24 border-4 border-background shadow-lg ring-2 ring-emerald-500/20">
                  {emp.avatar ? (
                    <AvatarImage src={emp.avatar} alt={`${emp.firstName} ${emp.lastName}`} />
                  ) : null}
                  <AvatarFallback className="text-2xl bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-bold">
                    {emp.firstName[0]}{emp.lastName[0]}
                  </AvatarFallback>
                </Avatar>

                {/* Info */}
                <div className="flex-1 min-w-0 pt-2">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                    <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight">
                      <PresenceDot employeeId={emp.id} className="h-2.5 w-2.5" />
                      {emp.firstName} {emp.lastName}
                    </h1>
                    <Badge className={`${sc.class} gap-1.5`} variant="outline">
                      <StatusIcon className="w-3.5 h-3.5" />
                      {sc.label}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-sm text-muted-foreground">
                    {emp.designation && (
                      <span className="flex items-center gap-1.5">
                        <Briefcase className="w-3.5 h-3.5" />
                        {emp.designation}
                      </span>
                    )}
                    {emp.department?.name && (
                      <span className="flex items-center gap-1.5">
                        <Building2 className="w-3.5 h-3.5" />
                        {emp.department.name}
                      </span>
                    )}
                    {emp.organization?.name && (
                      <span className="flex items-center gap-1.5">
                        <Users className="w-3.5 h-3.5" />
                        {emp.organization.name}
                      </span>
                    )}
                    <span className="flex items-center gap-1.5">
                      <Hash className="w-3.5 h-3.5" />
                      {emp.employeeId}
                    </span>
                    {emp.tenureMonths > 0 && (
                      <span className="flex items-center gap-1.5">
                        <Calendar className="w-3.5 h-3.5" />
                        {emp.tenureMonths} month{emp.tenureMonths !== 1 ? 's' : ''} tenure
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2 shrink-0 pt-2 sm:pt-2">
                  <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                    <Edit2 className="w-3.5 h-3.5 mr-1.5" /> Edit
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleExport}>
                    <Download className="w-3.5 h-3.5 mr-1.5" /> Export
                  </Button>
                  <PdfDownloadButton
                    endpoint="/api/reports/pdf/employee"
                    body={{ employeeId: emp.id }}
                    filename={`employee-report-${emp.firstName}-${emp.lastName}-${format(new Date(), 'yyyy-MM-dd')}.pdf`}
                    label="PDF Report"
                  />
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={handleArchive}>
                    <Archive className="w-3.5 h-3.5 mr-1.5" /> Archive
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </motion.div>

      {/* Date Range Picker + Quick Stats */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.1 }}
        className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
      >
        <div className="flex items-center gap-3">
          <DatePickerWithRange
            date={dateRange}
            onDateChange={setDateRange}
            className="w-[280px]"
          />
          {range && (
            <span className="text-xs text-muted-foreground hidden sm:inline-flex">
              {range.activeDays} active day{range.activeDays !== 1 ? 's' : ''} · {range.totalActivities} activities
            </span>
          )}
        </div>
      </motion.div>

      {/* Key Stats Grid */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.15 }}
        className="grid grid-cols-2 md:grid-cols-4 gap-3"
      >
        <StatCard
          icon={Timer}
          label="Total Hours"
          value={`${formatHours(range?.totalDuration || 0)}h`}
          subValue={`${formatHours(allTime?.totalDuration || 0)}h all time`}
          color="emerald"
        />
        <StatCard
          icon={TrendingUp}
          label="Productivity"
          value={`${productivePct}%`}
          subValue={range ? `${formatDuration(range.productiveTime)} productive` : undefined}
          color={productivePct >= 70 ? 'emerald' : productivePct >= 40 ? 'amber' : 'rose'}
          trend={productivePct >= 50 ? 'up' : 'down'}
        />
        <StatCard
          icon={Activity}
          label="Avg Daily"
          value={`${range?.avgDailyHours || 0}h`}
          subValue={`${range?.activeSessionCount || 0} sessions`}
          color="teal"
        />
        <StatCard
          icon={Calendar}
          label="Active Days"
          value={`${range?.activeDays || 0}`}
          subValue={dateRange?.from && dateRange?.to ? `of ${Math.ceil((dateRange.to.getTime() - dateRange.from.getTime()) / (1000*60*60*24)) + 1} days` : undefined}
          color="cyan"
        />
      </motion.div>

      {/* Main Content Tabs */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.2 }}
      >
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          <div className="flex items-center overflow-x-auto pb-1 -mx-2 px-2">
            <TabsList className="w-auto">
              <TabsTrigger value="overview" className="px-4">Overview</TabsTrigger>
              <TabsTrigger value="activity" className="px-4">Activity</TabsTrigger>
              <TabsTrigger value="apps" className="px-4">Apps & Websites</TabsTrigger>
              <TabsTrigger value="timeline" className="px-4">Timeline</TabsTrigger>
              <TabsTrigger value="keyboard" className="px-4">Keyboard</TabsTrigger>
              <TabsTrigger value="location" className="px-4">Location</TabsTrigger>
              <TabsTrigger value="webcam" className="px-4">Webcam</TabsTrigger>
              <TabsTrigger value="devices" className="px-4">Devices</TabsTrigger>
              <TabsTrigger value="alerts" className="px-4">Alerts</TabsTrigger>
            </TabsList>
          </div>

          {/* Overview Tab */}
          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Productivity Score */}
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Productivity Score</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col items-center py-4">
                  <ScoreRing percentage={productivePct} label="Selected Period" />
                  <div className="w-full mt-6 space-y-2">
                    <MiniBar label="Productive" value={range?.productiveTime || 0} max={totalTime} color="bg-emerald-500" duration={formatDuration(range?.productiveTime || 0)} />
                    <MiniBar label="Neutral" value={range?.neutralTime || 0} max={totalTime} color="bg-amber-500" duration={formatDuration(range?.neutralTime || 0)} />
                    <MiniBar label="Unproductive" value={range?.unproductiveTime || 0} max={totalTime} color="bg-rose-500" duration={formatDuration(range?.unproductiveTime || 0)} />
                  </div>
                </CardContent>
              </Card>

              {/* Daily Productivity Chart */}
              <Card className="lg:col-span-2 border-0 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Daily Productivity Trend</CardTitle>
                  <CardDescription className="text-xs">Minutes per category by day</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dailyProductivity} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} />
                        <XAxis dataKey="date" tick={{ fontSize: 10, fill: chartTextColor }} stroke={chartGridColor} />
                        <YAxis tick={{ fontSize: 10, fill: chartTextColor }} stroke={chartGridColor} />
                        <Tooltip
                          contentStyle={{
                            background: isDark ? '#18181b' : '#ffffff',
                            border: `1px solid ${chartGridColor}`,
                            borderRadius: '8px',
                            fontSize: '12px',
                          }}
                        />
                        <Legend iconType="circle" wrapperStyle={{ fontSize: '11px' }} />
                        <Bar dataKey="productive" stackId="1" fill="#10b981" name="Productive" radius={[0, 0, 0, 0]} animationBegin={200} animationDuration={800} />
                        <Bar dataKey="neutral" stackId="1" fill="#f59e0b" name="Neutral" animationBegin={400} animationDuration={800} />
                        <Bar dataKey="unproductive" stackId="1" fill="#f43f5e" name="Unproductive" radius={[4, 4, 0, 0]} animationBegin={600} animationDuration={800} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Hourly Distribution */}
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Hourly Activity Pattern</CardTitle>
                  <CardDescription className="text-xs">Activity distribution by hour of day</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={hourlyDistribution} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                        <defs>
                          <linearGradient id="hourGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                            <stop offset="100%" stopColor="#10b981" stopOpacity={0.05} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} />
                        <XAxis dataKey="hour" tick={{ fontSize: 9, fill: chartTextColor }} stroke={chartGridColor} interval={2} />
                        <YAxis tick={{ fontSize: 10, fill: chartTextColor }} stroke={chartGridColor} />
                        <Tooltip contentStyle={{ background: isDark ? '#18181b' : '#ffffff', border: `1px solid ${chartGridColor}`, borderRadius: '8px', fontSize: '12px' }} />
                        <Area type="monotone" dataKey="total" stroke="#10b981" fill="url(#hourGrad)" name="Total (sec)" animationDuration={800} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* Category Pie */}
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">Category Breakdown</CardTitle>
                  <CardDescription className="text-xs">Time distribution by productivity category</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-6">
                    <div className="h-40 w-40 shrink-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={pieData}
                            cx="50%"
                            cy="50%"
                            innerRadius={40}
                            outerRadius={70}
                            paddingAngle={4}
                            dataKey="value"
                            animationBegin={300}
                            animationDuration={800}
                          >
                            {pieData.map((entry, index) => (
                              <Cell key={`cell-${index}`} fill={entry.color} />
                            ))}
                          </Pie>
                          <Tooltip contentStyle={{ background: isDark ? '#18181b' : '#ffffff', border: `1px solid ${chartGridColor}`, borderRadius: '8px', fontSize: '12px' }} />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="flex-1 space-y-3">
                      {pieData.map((item) => (
                        <div key={item.name} className="flex items-center gap-3">
                          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: item.color }} />
                          <div className="flex-1">
                            <p className="text-sm font-medium">{item.name}</p>
                            <p className="text-xs text-muted-foreground">{item.value} minutes</p>
                          </div>
                          <span className="text-sm font-bold">{totalTime > 0 ? Math.round((item.value * 60 / totalTime) * 100) : 0}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Contact & Personal Info */}
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Personal Information</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <InfoItem icon={Mail} label="Email" value={emp.email} />
                  <InfoItem icon={Phone} label="Phone" value={emp.phone || '—'} />
                  <InfoItem icon={Calendar} label="Join Date" value={emp.joinDate ? format(new Date(emp.joinDate), 'MMM dd, yyyy') : '—'} />
                  <InfoItem icon={Building2} label="Department" value={emp.department?.name || '—'} />
                  <InfoItem icon={Hash} label="Employee ID" value={emp.employeeId} />
                  <InfoItem icon={Briefcase} label="Designation" value={emp.designation || '—'} />
                  <InfoItem icon={Users} label="Organization" value={emp.organization?.name || '—'} />
                  <InfoItem icon={Users} label="Status" value={<Badge className={sc.class} variant="outline"><StatusIcon className="w-3 h-3 mr-1" />{sc.label}</Badge>} />
                  <InfoItem icon={Clock} label="Created" value={format(new Date(emp.createdAt), 'MMM dd, yyyy')} />
                </div>
              </CardContent>
            </Card>

            {/* Agent Account Card */}
            <AgentAccountCard employeeId={emp.id} />

            {/* Projects */}
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <FolderKanban className="w-4 h-4 text-primary" /> Projects
                    </CardTitle>
                    <span className="text-xs text-muted-foreground">
                      {activeMemberships.length} active · {pastMemberships.length} past
                    </span>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => setManageProjectsOpen(true)}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Manage Projects
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {activeMemberships.length === 0 && pastMemberships.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 gap-2">
                    <FolderKanban className="w-8 h-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No projects assigned to this employee</p>
                    <Button variant="outline" size="sm" onClick={() => setManageProjectsOpen(true)}>
                      <Plus className="w-3.5 h-3.5 mr-1" /> Assign Projects
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {activeMemberships.map((m) => {
                      const project = (m.project as Record<string, unknown>) || {};
                      const pStatus = String(project.status || 'active');
                      const pColor = String(project.color || '#10b981');
                      return (
                        <div key={m.id as string} className="flex items-center gap-4 p-3 rounded-xl border hover:bg-muted/30 transition-colors">
                          <div
                            className="h-10 w-10 rounded-lg flex items-center justify-center shrink-0"
                            style={{ backgroundColor: `${pColor}1a`, color: pColor }}
                          >
                            <FolderKanban className="w-5 h-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-sm font-semibold truncate">{String(project.name || 'Unknown project')}</p>
                              <Badge variant="secondary" className="text-[10px] h-5 px-1.5 capitalize">{pStatus.replace('_', ' ')}</Badge>
                              {m.role ? (
                                <Badge variant="outline" className="text-[10px] h-5 px-1.5 capitalize">{String(m.role)}</Badge>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
                              {m.joinedAt ? (
                                <span className="flex items-center gap-1">
                                  <Calendar className="w-3 h-3" /> Joined {format(new Date(m.joinedAt as string), 'MMM dd, yyyy')}
                                </span>
                              ) : null}
                              {(m.totalHours as number) > 0 ? (
                                <span className="flex items-center gap-1">
                                  <Clock className="w-3 h-3" /> {(m.totalHours as number).toFixed(1)}h logged
                                </span>
                              ) : null}
                              {(m.hoursPerWeek as number) > 0 ? (
                                <span className="flex items-center gap-1">
                                  <Users className="w-3 h-3" /> {(m.hoursPerWeek as number)}h/wk
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {pastMemberships.length > 0 && (
                      <div className="pt-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Past Projects</p>
                        <div className="space-y-2">
                          {pastMemberships.map((m) => {
                            const project = (m.project as Record<string, unknown>) || {};
                            return (
                              <div key={m.id as string} className="flex items-center gap-3 p-3 rounded-xl border border-dashed bg-muted/20 opacity-70">
                                <UserMinus className="w-4 h-4 text-muted-foreground shrink-0" />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium truncate">{String(project.name || 'Unknown project')}</p>
                                  <p className="text-xs text-muted-foreground mt-0.5">
                                    {m.leftAt ? `Left ${format(new Date(m.leftAt as string), 'MMM dd, yyyy')}` : 'Past assignment'}
                                  </p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Activity Tab */}
          <TabsContent value="activity" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Top Applications */}
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <AppWindow className="w-4 h-4" /> Top Applications
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {topApplications.length > 0 ? topApplications.map((app: Record<string, unknown>, idx: number) => (
                    <div key={idx} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium truncate max-w-[60%]">{app.name as string}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">{app.duration as number} min</span>
                          <span className="font-bold text-emerald-600 dark:text-emerald-400">{String(app.percentage)}%</span>
                        </div>
                      </div>
                      <Progress value={app.percentage as number} className="h-1.5" />
                    </div>
                  )) : (
                    <p className="text-sm text-muted-foreground text-center py-4">No application data</p>
                  )}
                </CardContent>
              </Card>

              {/* Top Websites */}
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Globe className="w-4 h-4" /> Top Websites
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {topWebsites.length > 0 ? topWebsites.map((site: Record<string, unknown>, idx: number) => (
                    <div key={idx} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium truncate max-w-[60%]">{site.name as string}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">{site.duration as number} min</span>
                          <span className="font-bold text-teal-600 dark:text-teal-400">{String(site.percentage)}%</span>
                        </div>
                      </div>
                      <Progress value={site.percentage as number} className="h-1.5" />
                    </div>
                  )) : (
                    <p className="text-sm text-muted-foreground text-center py-4">No website data</p>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Productivity score ring and comparison */}
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Period Performance Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col md:flex-row items-center gap-8">
                  <ScoreRing percentage={productivePct} size={140} strokeWidth={12} label="Period Score" />
                  <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-4">
                    <MiniStat icon={CheckCircle2} label="Productive" value={formatDuration(range?.productiveTime || 0)} color="text-emerald-600 dark:text-emerald-400" />
                    <MiniStat icon={MinusCircle} label="Neutral" value={formatDuration(range?.neutralTime || 0)} color="text-amber-600 dark:text-amber-400" />
                    <MiniStat icon={AlertTriangle} label="Unproductive" value={formatDuration(range?.unproductiveTime || 0)} color="text-rose-600 dark:text-rose-400" />
                    <MiniStat icon={Timer} label="Total Hours" value={formatHours(range?.totalDuration || 0) + 'h'} color="text-slate-600 dark:text-slate-400" />
                    <MiniStat icon={Activity} label="Activities" value={String(range?.totalActivities || 0)} color="text-teal-600 dark:text-teal-400" />
                    <MiniStat icon={Zap} label="Active Days" value={String(range?.activeDays || 0)} color="text-cyan-600 dark:text-cyan-400" />
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Apps & Websites Tab */}
          <TabsContent value="apps" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <AppWindow className="w-4 h-4 text-emerald-500" /> Application Usage
                  </CardTitle>
                  <CardDescription className="text-xs">Time spent in applications</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={topApplications} layout="vertical" margin={{ top: 5, right: 20, left: 5, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} />
                        <XAxis type="number" tick={{ fontSize: 10, fill: chartTextColor }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: chartTextColor }} width={100} />
                        <Tooltip contentStyle={{ background: isDark ? '#18181b' : '#ffffff', border: `1px solid ${chartGridColor}`, borderRadius: '8px', fontSize: '12px' }} />
                        <Bar dataKey="duration" fill="#10b981" name="Minutes" radius={[0, 4, 4, 0]} animationDuration={800} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Globe className="w-4 h-4 text-teal-500" /> Website Usage
                  </CardTitle>
                  <CardDescription className="text-xs">Time spent on websites</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={topWebsites} layout="vertical" margin={{ top: 5, right: 20, left: 5, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke={chartGridColor} />
                        <XAxis type="number" tick={{ fontSize: 10, fill: chartTextColor }} />
                        <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: chartTextColor }} width={100} />
                        <Tooltip contentStyle={{ background: isDark ? '#18181b' : '#ffffff', border: `1px solid ${chartGridColor}`, borderRadius: '8px', fontSize: '12px' }} />
                        <Bar dataKey="duration" fill="#14b8a6" name="Minutes" radius={[0, 4, 4, 0]} animationDuration={800} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
            {/* Websites detail (domain-only table) below the app charts */}
            <div className="mt-4">
              {emp ? <WebsiteDomainsPanel employeeId={emp.id} /> : null}
            </div>
          </TabsContent>

          {/* Keyboard Activity Tab */}
        <TabsContent value="keyboard" className="space-y-4">
          {emp ? <KeyboardActivityPanel employeeId={emp.id} /> : null}
        </TabsContent>

        {/* Location Tab */}
        <TabsContent value="location" className="space-y-4">
          {emp ? <LocationPanel employeeId={emp.id} /> : null}
        </TabsContent>

        {/* Webcam Tab — explicit operator control, never auto-starts */}
        <TabsContent value="webcam" className="space-y-4">
          {emp ? <WebcamPanel employeeId={emp.id} /> : null}
        </TabsContent>

        {/* Timeline Tab */}
        <TabsContent value="timeline" className="space-y-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-sm font-medium">Activity Timeline</CardTitle>
                    <CardDescription className="text-xs">
                      {activities.length} of {activitiesTotal} activities in selected period
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[500px]">
                  <div className="space-y-1 relative">
                    {/* Timeline line */}
                    <div className="absolute left-[15px] top-2 bottom-2 w-px bg-border" />

                    {activitiesLoading && activities.length === 0 ? (
                      <div className="py-10 text-center text-sm text-muted-foreground">Loading activities…</div>
                    ) : activities.length > 0 ? activities.map((act: Record<string, unknown>, _idx: number) => {
                      const catClass = act.category === 'productive'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                        : act.category === 'unproductive'
                        ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
                      const TypeIcon = act.type === 'application' ? AppWindow
                        : act.type === 'website' ? Globe
                        : act.type === 'idle' ? Coffee
                        : act.type === 'work_session' ? Activity
                        : FileText;
                      return (
                        <div key={act.id as string} className="flex items-start gap-3 p-2 rounded-lg hover:bg-muted/30 transition-colors group relative">
                          {/* Dot */}
                          <div className={`h-[30px] w-[30px] rounded-full flex items-center justify-center shrink-0 z-10 border-2 border-background shadow-sm ${catClass}`}>
                            <TypeIcon className="w-3.5 h-3.5" />
                          </div>
                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-medium truncate">{String(act.applicationName || act.title || act.url || 'Unknown')}</p>
                              <span className="text-xs text-muted-foreground shrink-0">
                                {act.timestamp ? formatDistanceToNow(new Date(act.timestamp as string), { addSuffix: true }) : ''}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                              <Badge variant="secondary" className={`text-[9px] h-4 px-1.5 ${catClass}`}>
                                {act.category as string}
                              </Badge>
                              <span className="flex items-center gap-0.5">
                                <Clock className="w-2.5 h-2.5" /> {formatDuration(act.duration as number)}
                              </span>
                              {(act.device as Record<string, string>)?.name && (
                                <span className="flex items-center gap-0.5">
                                  <Monitor className="w-2.5 h-2.5" /> {(act.device as Record<string, string>).name}
                                </span>
                              )}
                              {act.timestamp ? (
                                <span>{format(new Date(act.timestamp as string), 'HH:mm')}</span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    }) : (
                      <div className="flex flex-col items-center justify-center py-12 gap-2">
                        <FileText className="w-8 h-8 text-muted-foreground/40" />
                        <p className="text-sm text-muted-foreground">No activities found in the selected period</p>
                        <p className="text-xs text-muted-foreground">Try adjusting the date range</p>
                      </div>
                    )}
                    {activities.length < activitiesTotal && hasNextPage && (
                      <div className="flex justify-center pt-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => fetchNextPage()}
                          disabled={isFetchingNextPage}
                        >
                          {isFetchingNextPage ? 'Loading…' : 'Load more'}
                        </Button>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Devices Tab */}
          <TabsContent value="devices" className="space-y-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Assigned Devices</CardTitle>
                <CardDescription className="text-xs">{emp.devices?.length || 0} devices assigned</CardDescription>
              </CardHeader>
              <CardContent>
                {emp.devices && emp.devices.length > 0 ? (
                  <div className="space-y-3">
                    {emp.devices.map((dev: Record<string, unknown>) => {
                      const dStatus = dev.status as string;
                      // Device.status is sticky (never reverted at runtime) —
                      // online/offline is derived from heartbeat freshness.
                      const isLifecyclePinned = ['maintenance', 'inactive', 'retired'].includes(dStatus);
                      const liveOnline = !isLifecyclePinned && isHeartbeatFresh(dev.lastHeartbeat ? new Date(dev.lastHeartbeat as string) : null);
                      const displayStatus = isLifecyclePinned ? dStatus : liveOnline ? 'online' : 'offline';
                      const isOnline = liveOnline;
                      return (
                        <div key={dev.id as string} className="flex items-center gap-4 p-4 rounded-xl border hover:bg-muted/30 transition-colors group">
                          <div className={`h-12 w-12 rounded-xl flex items-center justify-center shrink-0 ${isOnline ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-muted'}`}>
                            {isOnline ? <Wifi className="w-6 h-6 text-emerald-500" /> : <WifiOff className="w-6 h-6 text-muted-foreground" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold">{dev.name as string}</p>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
                              {dev.operatingSystem ? <span>{dev.operatingSystem as string}</span> : null}
                              {dev.osVersion ? <span>v{dev.osVersion as string}</span> : null}
                              {dev.hostname ? <span className="font-mono">{dev.hostname as string}</span> : null}
                              {dev.ipAddress ? <span>{dev.ipAddress as string}</span> : null}
                            </div>
                            {dev.lastHeartbeat ? (
                              <p className="text-[11px] text-muted-foreground mt-0.5">
                                Last heartbeat: {formatDistanceToNow(new Date(dev.lastHeartbeat as string), { addSuffix: true })}
                              </p>
                            ) : null}
                          </div>
                          <Badge className={deviceStatusColors[displayStatus] || 'bg-gray-100 text-gray-600'} variant="secondary">
                            <span className={`w-1.5 h-1.5 rounded-full mr-1.5 ${isOnline ? 'bg-emerald-500 animate-pulse' : displayStatus === 'offline' ? 'bg-red-500' : 'bg-gray-400'}`} />
                            {displayStatus}
                          </Badge>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 gap-2">
                    <Monitor className="w-8 h-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">No devices assigned to this employee</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Alerts Tab */}
          <TabsContent value="alerts" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <AlertOctagon className="w-4 h-4 text-amber-500" /> Related Alerts
                  </CardTitle>
                  <CardDescription className="text-xs">{alerts.length} alerts found</CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="max-h-80">
                    {alerts.length > 0 ? (
                      <div className="space-y-2">
                        {alerts.map((alert: Record<string, unknown>) => {
                          const severity = alert.severity as string;
                          const sevClass = severity === 'critical' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                            : severity === 'error' ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
                            : severity === 'warning' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                            : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
                          return (
                            <div key={alert.id as string} className="p-3 rounded-lg border hover:bg-muted/30 transition-colors">
                              <div className="flex items-center gap-2 mb-1">
                                <Badge variant="secondary" className={`text-[10px] h-5 px-1.5 ${sevClass}`}>{severity}</Badge>
                                <Badge variant="secondary" className="text-[10px] h-5 px-1.5">{alert.status as string}</Badge>
                              </div>
                              <p className="text-sm font-medium">{alert.title as string}</p>
                              <p className="text-xs text-muted-foreground mt-0.5">{alert.description as string}</p>
                              {alert.createdAt ? (
                                <p className="text-[11px] text-muted-foreground mt-1">
                                  {formatDistanceToNow(new Date(alert.createdAt as string), { addSuffix: true })}
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground text-center py-8">No alerts related to this employee</p>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>

              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Bell className="w-4 h-4 text-teal-500" /> Related Notifications
                  </CardTitle>
                  <CardDescription className="text-xs">{notifications.length} notifications found</CardDescription>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="max-h-80">
                    {notifications.length > 0 ? (
                      <div className="space-y-2">
                        {notifications.map((notif: Record<string, unknown>) => (
                          <div key={notif.id as string} className="p-3 rounded-lg border hover:bg-muted/30 transition-colors">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge variant="secondary" className="text-[10px] h-5 px-1.5">{notif.type as string}</Badge>
                              <Badge variant="secondary" className="text-[10px] h-5 px-1.5">{notif.priority as string}</Badge>
                            </div>
                            <p className="text-sm font-medium">{notif.title as string}</p>
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{notif.message as string}</p>
                            {notif.createdAt ? (
                              <p className="text-[11px] text-muted-foreground mt-1">
                                {formatDistanceToNow(new Date(notif.createdAt as string), { addSuffix: true })}
                              </p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground text-center py-8">No notifications related to this employee</p>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </motion.div>

      {/* Edit dialog — mounted on this page so Edit actually works */}
      <EmployeeDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        employee={emp}
        onSaved={handleEmployeeSaved}
      />

      {/* Manage project assignments — remounted per open so selection reseeds */}
      {manageProjectsOpen && (
        <ManageProjectsDialog
          employeeId={emp.id}
          employeeName={`${emp.firstName} ${emp.lastName}`.trim() || emp.email}
          open={manageProjectsOpen}
          onOpenChange={setManageProjectsOpen}
          onSaved={handleProjectsSaved}
        />
      )}
    </div>
  );
}

function InfoItem({ icon: Icon, label, value }: { icon: typeof Mail; label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/30">
      <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground font-medium">{label}</p>
        <div className="text-sm font-medium truncate mt-0.5">{value}</div>
      </div>
    </div>
  );
}

function MiniStat({ icon: Icon, label, value, color }: { icon: typeof Timer; label: string; value: string; color: string }) {
  return (
    <div className="flex items-center gap-2.5 p-2 rounded-lg bg-muted/30">
      <Icon className={`w-4 h-4 ${color} shrink-0`} />
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-bold">{value}</p>
      </div>
    </div>
  );
}
