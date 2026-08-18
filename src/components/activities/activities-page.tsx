'use client';

import { useState, useMemo, useEffect } from 'react';
import { type DateRange } from 'react-day-picker';
import { subDays, format } from 'date-fns';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Download,
  Search,
  Users,
  BarChart3,
  Clock,
  Zap,
} from 'lucide-react';
import { ExportDialog } from '@/components/export/export-dialog';
import { ActivityTimeline } from './activity-timeline';
import { ActivityStats } from './activity-stats';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmployeeCombobox } from '@/components/employees/employee-combobox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { PaginationControls } from '@/components/ui/pagination-controls';
import { DatePickerWithRange } from '@/components/ui/date-picker-with-range';
// ==================== Daily Productivity Bars ====================

function DailyProductivityBars({ data, isLoading }: {
  data: Array<{
    date: string;
    totalMinutes: number;
    productiveMinutes: number;
    neutralMinutes: number;
    unproductiveMinutes: number;
    idleMinutes: number;
    activityCount: number;
  }>;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2">
            <Skeleton className="h-3 w-8 shrink-0" />
            <div className="flex-1">
              <Skeleton className="h-5 w-full rounded-full" />
            </div>
            <Skeleton className="h-3 w-12 shrink-0" />
          </div>
        ))}
      </div>
    );
  }

  const maxMinutes = Math.max(...data.map((d) => d.totalMinutes), 1);

  return (
    <div className="space-y-1.5">
      {data.map((day) => {
        const pct = day.totalMinutes > 0 ? (day.totalMinutes / maxMinutes) * 100 : 0;
        const productivePct = day.totalMinutes > 0 ? (day.productiveMinutes / day.totalMinutes) * 100 : 0;
        const neutralPct = day.totalMinutes > 0 ? (day.neutralMinutes / day.totalMinutes) * 100 : 0;
        const unproductivePct = day.totalMinutes > 0 ? (day.unproductiveMinutes / day.totalMinutes) * 100 : 0;
        const idlePct = day.totalMinutes > 0 ? (day.idleMinutes / day.totalMinutes) * 100 : 0;
        const dateLabel = format(new Date(day.date), 'EEE');
        const hours = (day.totalMinutes / 60).toFixed(1);

        return (
          <div key={day.date} className="flex items-center gap-2">
            <span className="text-[10px] font-medium text-muted-foreground w-7 shrink-0 text-right">
              {dateLabel}
            </span>
            <div className="flex-1">
              <div className="h-5 w-full rounded-full bg-muted/40 overflow-hidden flex" style={{ minWidth: pct > 0 ? '4px' : undefined }}>
                {productivePct > 0 && (
                  <motion.div
                    className="h-full bg-success rounded-l-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${pct * productivePct / 100}%` }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                  />
                )}
                {neutralPct > 0 && (
                  <motion.div
                    className="h-full bg-warning"
                    initial={{ width: 0 }}
                    animate={{ width: `${pct * neutralPct / 100}%` }}
                    transition={{ duration: 0.5, delay: 0.2 }}
                  />
                )}
                {unproductivePct > 0 && (
                  <motion.div
                    className="h-full bg-danger"
                    initial={{ width: 0 }}
                    animate={{ width: `${pct * unproductivePct / 100}%` }}
                    transition={{ duration: 0.5, delay: 0.3 }}
                  />
                )}
                {idlePct > 0 && (
                  <motion.div
                    className="h-full bg-muted-foreground/40 rounded-r-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${pct * idlePct / 100}%` }}
                    transition={{ duration: 0.5, delay: 0.4 }}
                  />
                )}
              </div>
            </div>
            <span className="text-[10px] font-medium text-muted-foreground w-10 shrink-0 text-right tabular-nums">
              {hours}h
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ==================== Summary Score Card ====================

function ScoreCard({ label, value, icon: Icon, color, isLoading }: {
  label: string; value: number | string; icon: React.ElementType; color: string; isLoading: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <div className={`h-8 w-8 rounded-lg ${color} flex items-center justify-center shrink-0`}>
        <Icon className="h-4 w-4 text-white" />
      </div>
      <div>
        {isLoading ? (
          <>
            <Skeleton className="h-2.5 w-16 mb-0.5" />
            <Skeleton className="h-4 w-8" />
          </>
        ) : (
          <>
            <p className="text-[10px] text-muted-foreground leading-tight">{label}</p>
            <p className="text-sm font-bold leading-tight">{value}</p>
          </>
        )}
      </div>
    </div>
  );
}

// ==================== Main Page ====================

export function ActivitiesPage() {
  const [typeFilter, setTypeFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  // Debounce the search box: only the settled value triggers a request, so
  // typing never hammers the API per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 350);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const [page, setPage] = useState(1);
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => ({
    from: subDays(new Date(), 6),
    to: new Date(),
  }));
  const [showDailyChart, setShowDailyChart] = useState(true);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    p.set('page', String(page));
    p.set('pageSize', '15');
    if (typeFilter && typeFilter !== 'all') p.set('type', typeFilter);
    if (categoryFilter && categoryFilter !== 'all') p.set('category', categoryFilter);
    if (employeeFilter && employeeFilter !== 'all') p.set('employeeId', employeeFilter);
    if (dateRange?.from) p.set('from', format(dateRange.from, 'yyyy-MM-dd'));
    if (dateRange?.to) p.set('to', format(dateRange.to, 'yyyy-MM-dd'));
    if (debouncedSearch) p.set('search', debouncedSearch);
    return p;
  }, [typeFilter, categoryFilter, employeeFilter, page, dateRange, debouncedSearch]);

  // Fetch activities list. keepPreviousData preserves the current rows while a
  // new filter/search refetch is in flight — no page wipe on every keystroke.
  const { data, isLoading } = useQuery({
    queryKey: ['activities', typeFilter, categoryFilter, employeeFilter, page, dateRange?.from?.toISOString(), dateRange?.to?.toISOString(), debouncedSearch],
    queryFn: async () => {
      const res = await fetch(`/api/activities?${params}`);
      return res.json();
    },
    placeholderData: keepPreviousData,
  });

  const activities = data?.data || [];

  // Fetch daily breakdown
  const { data: dailyData, isLoading: dailyLoading } = useQuery({
    queryKey: ['activities-daily', employeeFilter, dateRange?.from?.toISOString(), dateRange?.to?.toISOString()],
    queryFn: async () => {
      const dp = new URLSearchParams();
      dp.set('days', '7');
      if (employeeFilter && employeeFilter !== 'all') dp.set('employeeId', employeeFilter);
      const res = await fetch(`/api/activities/daily?${dp}`);
      return res.json();
    },
  });

  const resetFilters = () => {
    setTypeFilter('');
    setCategoryFilter('');
    setEmployeeFilter('');
    setSearchQuery('');
    setDateRange({ from: subDays(new Date(), 6), to: new Date() });
    setPage(1);
  };

  const hasActiveFilters = typeFilter || categoryFilter || employeeFilter || debouncedSearch;

  // Stat cards are the server-side summary over the FULL matching dataset
  // (same filters/date range, all pages) — never the current 15-row page.
  const activityStats = {
    totalActivities: data?.summary?.total ?? 0,
    totalDuration: data?.summary?.totalDuration ?? 0,
    productiveTime: data?.summary?.productiveTime ?? 0,
    unproductiveTime: data?.summary?.unproductiveTime ?? 0,
  };

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Activities</h2>
          <p className="text-sm text-muted-foreground mt-0.5 truncate">
            Monitor employee activity and productivity across applications
          </p>
        </div>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" className="h-8 text-xs shrink-0" onClick={resetFilters}>
            Reset Filters
          </Button>
        )}
      </div>

      {/* Daily Productivity Panel */}
      {showDailyChart && (
        <Card className="falcon-card p-0">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold">Daily Productivity</h3>
                <span className="text-xs text-muted-foreground">Last 7 days</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Badge className="bg-success/10 text-success text-[9px] h-4 px-1 border-success/25">Productive</Badge>
                <Badge className="bg-warning/10 text-warning text-[9px] h-4 px-1 border-warning/25">Neutral</Badge>
                <Badge className="bg-danger/10 text-danger text-[9px] h-4 px-1 border-danger/25">Unprod.</Badge>
                <Badge className="bg-muted text-muted-foreground text-[9px] h-4 px-1 border-transparent">Idle</Badge>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-4">
              <DailyProductivityBars
                data={dailyData?.daily || []}
                isLoading={dailyLoading}
              />
              <div className="flex flex-row md:flex-col gap-3 md:gap-2 md:min-w-[140px]">
                <ScoreCard
                  label="Productivity"
                  value={`${dailyData?.summary?.productivityScore || 0}%`}
                  icon={Zap}
                  color="bg-success"
                  isLoading={dailyLoading}
                />
                <ScoreCard
                  label="Avg Daily"
                  value={`${dailyData?.summary?.avgDailyMinutes || 0}m`}
                  icon={Clock}
                  color="bg-info"
                  isLoading={dailyLoading}
                />
                <ScoreCard
                  label="Activities"
                  value={dailyData?.daily?.reduce((s: number, d: { activityCount: number }) => s + d.activityCount, 0) || 0}
                  icon={Users}
                  color="bg-primary"
                  isLoading={dailyLoading}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card className="falcon-card p-0">
        <CardContent className="p-3">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center">
              <div className="relative flex-1 w-full sm:max-w-[200px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search activities..."
                  value={searchQuery}
                  onChange={(e) => { setSearchQuery(e.target.value); setPage(1); }}
                  className="pl-8 h-8 text-xs"
                />
              </div>
              <DatePickerWithRange
                date={dateRange}
                onDateChange={(d) => { setDateRange(d); setPage(1); }}
                className="w-full sm:w-auto"
              />
            </div>
            <div className="flex flex-wrap gap-2 items-center">
              <EmployeeCombobox
                value={employeeFilter || null}
                onValueChange={(v) => { setEmployeeFilter((v as string) ?? ''); setPage(1); }}
                placeholder="All Employees"
                allowClear
                clearLabel="All Employees"
                size="sm"
                labelFormat="name-dept"
                className="w-full sm:w-[180px]"
                ariaLabel="Filter by employee"
              />
              <Select value={typeFilter || 'all'} onValueChange={(v) => { setTypeFilter(v === 'all' ? '' : v); setPage(1); }}>
                <SelectTrigger className="h-8 text-xs w-full sm:w-[140px]">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="application">Application</SelectItem>
                  <SelectItem value="website">Website</SelectItem>
                  <SelectItem value="idle">Idle</SelectItem>
                  <SelectItem value="work_session">Work Session</SelectItem>
                </SelectContent>
              </Select>
              <Select value={categoryFilter || 'all'} onValueChange={(v) => { setCategoryFilter(v === 'all' ? '' : v); setPage(1); }}>
                <SelectTrigger className="h-8 text-xs w-full sm:w-[140px]">
                  <SelectValue placeholder="All Categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  <SelectItem value="productive">Productive</SelectItem>
                  <SelectItem value="neutral">Neutral</SelectItem>
                  <SelectItem value="unproductive">Unproductive</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex-1" />
              <ExportDialog
                exportType="activities"
                title="Export Activities"
                trigger={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                  >
                    <Download className="w-3.5 h-3.5 mr-1.5" />
                    Export
                  </Button>
                }
                availableColumns={[
                  { key: 'employee', label: 'Employee', defaultEnabled: true },
                  { key: 'applicationName', label: 'Application', defaultEnabled: true },
                  { key: 'title', label: 'Title', defaultEnabled: true },
                  { key: 'category', label: 'Category', defaultEnabled: true },
                  { key: 'duration', label: 'Duration', defaultEnabled: true },
                  { key: 'device', label: 'Device', defaultEnabled: false },
                  { key: 'timestamp', label: 'Timestamp', defaultEnabled: false },
                ]}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setShowDailyChart(!showDailyChart)}
              >
                <BarChart3 className="w-3.5 h-3.5 mr-1.5" />
                {showDailyChart ? 'Hide Chart' : 'Show Chart'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Activity Stats */}
      <ActivityStats stats={activityStats} isLoading={isLoading} />

      {/* Activity Timeline */}
      <div className="border rounded-lg p-4">
        <ActivityTimeline activities={activities} isLoading={isLoading} />
      </div>

      {/* Pagination */}
      <PaginationControls
        currentPage={data?.page || 1}
        totalPages={data?.totalPages || 1}
        totalItems={data?.total || 0}
        pageSize={15}
        onPageChange={setPage}
      />
    </div>
  );
}
