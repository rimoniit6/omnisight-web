'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Label } from '@/components/ui/label';
import { ArrowRight, ArrowUpRight, ArrowDownRight, TrendingUp, Clock, Users, Activity, CalendarIcon, BarChart3 } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import {
  buildPeriodCompareQuery,
  buildDepartmentCompareQuery,
  isValidPeriodPair,
} from '@/lib/compare-query';

type CompareMode = 'departments' | 'periods';

interface ComparisonEntity {
  id?: string;
  name: string;
  productivityScore: number;
  activeHours: number;
  activeEmployees: number;
  totalActivities: number;
  productiveHours: number;
  neutralHours: number;
  unproductiveHours: number;
  activeDays?: number;
  topApps: { name: string; durationMinutes: number; category: string }[];
  workload: { productive: number; neutral: number; unproductive: number };
}

function DeltaIndicator({ value, suffix = '%' }: { value: number; suffix?: string }) {
  const isUp = value > 0;
  const isZero = value === 0;
  return (
    <span className={cn(
      'inline-flex items-center gap-0.5 text-xs font-medium',
      isZero && 'text-muted-foreground',
      isUp && 'text-emerald-600 dark:text-emerald-400',
      !isUp && !isZero && 'text-rose-600 dark:text-rose-400'
    )}>
      {!isZero && (isUp ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />)}
      {isZero ? '0' : `${isUp ? '+' : ''}${value}`}{suffix}
    </span>
  );
}

function MetricCard({ label, valueA, valueB, icon: Icon, format: fmt }: {
  label: string;
  valueA: number;
  valueB: number;
  icon: React.ElementType;
  format?: (v: number) => string;
}) {
  const formatted = fmt || ((v: number) => String(v));
  const delta = valueB !== 0 ? Math.round(((valueA - valueB) / valueB) * 100) : (valueA > 0 ? 100 : 0);

  return (
    <div className="grid grid-cols-3 items-center gap-2 py-2 border-b border-border last:border-b-0">
      <div className="flex items-center gap-2">
        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground truncate">{label}</span>
      </div>
      <div className="text-right">
        <span className="text-sm font-semibold">{formatted(valueA)}</span>
      </div>
      <div className="text-right flex items-center justify-end gap-1">
        <span className="text-xs text-muted-foreground">{formatted(valueB)}</span>
        <DeltaIndicator value={delta} />
      </div>
    </div>
  );
}

function WorkloadBar({ label, valueA, valueB }: { label: string; valueA: number; valueB: number }) {
  const delta = valueB !== 0 ? Math.round(((valueA - valueB) / valueB) * 100) : (valueA > 0 ? 100 : 0);
  const colorA = label === 'productive' ? 'bg-emerald-500' : label === 'neutral' ? 'bg-amber-400' : 'bg-rose-500';

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="capitalize text-muted-foreground">{label}</span>
        <div className="flex items-center gap-2">
          <span className="font-medium">{valueA}%</span>
          <DeltaIndicator value={delta} />
        </div>
      </div>
      <div className="flex gap-1 h-2.5">
        <div className="flex-1 bg-muted rounded-full overflow-hidden">
          <div className={cn('h-full rounded-full transition-all duration-500', colorA)} style={{ width: `${valueA}%` }} />
        </div>
        <div className="flex-1 bg-muted rounded-full overflow-hidden">
          <div className={cn('h-full rounded-full transition-all duration-500 opacity-50', colorA)} style={{ width: `${valueB}%` }} />
        </div>
      </div>
    </div>
  );
}

interface AppEntry {
  name: string;
  durationMinutes: number;
  category: string;
}

interface AppWithSides extends AppEntry {
  sideA?: number;
  sideB?: number;
}

function AppComparison({ appsA, appsB }: { appsA: ComparisonEntity['topApps']; appsB: ComparisonEntity['topApps'] }) {
  // Merge all unique apps from both entities
  const allApps = new Map<string, AppWithSides>();
  appsA.forEach((a) => allApps.set(a.name, { ...a, sideA: a.durationMinutes }));
  appsB.forEach((b) => {
    const existing = allApps.get(b.name);
    if (existing) {
      existing.sideB = b.durationMinutes;
    } else {
      allApps.set(b.name, { ...b, sideB: b.durationMinutes });
    }
  });

  const merged = Array.from(allApps.entries()).slice(0, 6);
  const maxMin = Math.max(1, ...merged.map(([, a]) => Math.max(a.sideA || 0, a.sideB || 0)));

  return (
    <div className="space-y-2">
      {merged.map(([name, app]) => {
        const minA = app.sideA || 0;
        const minB = app.sideB || 0;
        const pctA = Math.round((minA / maxMin) * 100);
        const pctB = Math.round((minB / maxMin) * 100);
        return (
          <div key={name} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="truncate max-w-[140px]" title={name}>{name}</span>
              <div className="flex items-center gap-3 shrink-0">
                <span className="font-medium text-emerald-600 dark:text-emerald-400 w-12 text-right">{minA}m</span>
                <span className="text-muted-foreground w-12 text-right">{minB}m</span>
              </div>
            </div>
            <div className="flex gap-1 h-2">
              <div className="flex-1 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all duration-500" style={{ width: `${pctA}%` }} />
              </div>
              <div className="flex-1 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500/40 rounded-full transition-all duration-500" style={{ width: `${pctB}%` }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface ComparisonToolProps {
  departments: { id: string; name: string }[];
  /** Shared analytics date range — bounds the departments query (never unbounded). */
  dateRange?: { from: Date; to: Date };
}

export function ComparisonTool({ departments, dateRange }: ComparisonToolProps) {
  const [mode, setMode] = useState<CompareMode>('departments');
  const [dept1, setDept1] = useState('');
  const [dept2, setDept2] = useState('');
  const [start1, setStart1] = useState<Date | undefined>(undefined);
  const [end1, setEnd1] = useState<Date | undefined>(undefined);
  const [start2, setStart2] = useState<Date | undefined>(undefined);
  const [end2, setEnd2] = useState<Date | undefined>(undefined);
  const [calOpen, setCalOpen] = useState<'a' | 'b' | null>(null);

  // Query construction and validation live in lib/compare-query.ts (pure and
  // unit-tested). Dates are NEVER dereferenced here — undefined selections
  // simply leave the query disabled, so switching to Time Periods before
  // picking dates cannot crash the component.
  const periodQuery = useMemo(
    () => buildPeriodCompareQuery({ start1, end1, start2, end2 }),
    [start1, end1, start2, end2]
  );
  const deptQuery = useMemo(
    () => buildDepartmentCompareQuery(dept1, dept2, dateRange),
    [dept1, dept2, dateRange]
  );
  const compareQuery = mode === 'departments' ? deptQuery : periodQuery;
  const canCompare = compareQuery.ok;
  const queryParams = canCompare ? compareQuery.params : '';
  // Validation state for the periods mode: any start > its end.
  const periodRangeInvalid =
    (start1 && end1 && !isValidPeriodPair(start1, end1)) ||
    (start2 && end2 && !isValidPeriodPair(start2, end2));

  interface CompareResponse {
    mode: string;
    entityA: ComparisonEntity;
    entityB: ComparisonEntity;
  }

  const { data, isLoading } = useQuery<CompareResponse>({
    queryKey: ['analytics-compare', queryParams],
    queryFn: async () => {
      const res = await fetch(`/api/analytics/compare?${queryParams}`);
      const json = (await res.json()) as CompareResponse;
      return json;
    },
    enabled: canCompare,
  });

  const entityA = data?.entityA;
  const entityB = data?.entityB;

  const resetDates = () => {
    setStart1(undefined);
    setEnd1(undefined);
    setStart2(undefined);
    setEnd2(undefined);
  };

  return (
    <Card className="border shadow-sm">
      <CardHeader className="p-4 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-emerald-500" />
            <CardTitle className="text-sm">Comparison Tool</CardTitle>
          </div>
          {/* Mode toggle */}
          <div className="flex items-center border rounded-md overflow-hidden">
            <Button
              variant={mode === 'departments' ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-3 rounded-none text-xs"
              onClick={() => { setMode('departments'); resetDates(); }}
            >
              Departments
            </Button>
            <Button
              variant={mode === 'periods' ? 'default' : 'ghost'}
              size="sm"
              className="h-7 px-3 rounded-none text-xs"
              onClick={() => { setMode('periods'); setDept1(''); setDept2(''); }}
            >
              Time Periods
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-4 pt-0 space-y-4">
        {/* Selectors */}
        {mode === 'departments' ? (
          <div className="grid grid-cols-1 md:grid-cols-[1fr,auto,1fr] items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Department A</Label>
              <Select value={dept1} onValueChange={setDept1}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  {departments.filter(d => d.id !== dept2).map(d => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-center pb-1">
              <ArrowRight className="w-4 h-4 text-muted-foreground rotate-90 md:rotate-0" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Department B</Label>
              <Select value={dept2} onValueChange={setDept2}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  {departments.filter(d => d.id !== dept1).map(d => (
                    <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Period A */}
            <div className="space-y-2">
              <Label className="text-xs font-medium">Period A</Label>
              <div className="flex gap-2">
                <Popover open={calOpen === 'a'} onOpenChange={(o) => setCalOpen(o ? 'a' : null)}>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9 flex-1 justify-start text-left font-normal text-xs">
                      <CalendarIcon className="mr-1.5 h-3.5 w-3.5" />
                      {start1 ? format(start1, 'MMM d') : 'Start'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={start1}
                      onSelect={(d) => { setStart1(d); }}
                      disabled={end1 ? { after: end1 } : undefined}
                    />
                  </PopoverContent>
                </Popover>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9 flex-1 justify-start text-left font-normal text-xs">
                      <CalendarIcon className="mr-1.5 h-3.5 w-3.5" />
                      {end1 ? format(end1, 'MMM d') : 'End'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar mode="single" selected={end1} onSelect={setEnd1} disabled={start1 ? { before: start1 } : undefined} />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
            {/* Period B */}
            <div className="space-y-2">
              <Label className="text-xs font-medium">Period B</Label>
              <div className="flex gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9 flex-1 justify-start text-left font-normal text-xs">
                      <CalendarIcon className="mr-1.5 h-3.5 w-3.5" />
                      {start2 ? format(start2, 'MMM d') : 'Start'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={start2}
                      onSelect={setStart2}
                      disabled={end2 ? { after: end2 } : undefined}
                    />
                  </PopoverContent>
                </Popover>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9 flex-1 justify-start text-left font-normal text-xs">
                      <CalendarIcon className="mr-1.5 h-3.5 w-3.5" />
                      {end2 ? format(end2, 'MMM d') : 'End'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar mode="single" selected={end2} onSelect={setEnd2} disabled={start2 ? { before: start2 } : undefined} />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>
        )}

        {/* Validation / empty state */}
        {!canCompare && mode === 'periods' && periodRangeInvalid && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            Start date must be on or before its end date in both periods.
          </div>
        )}

        {/* Results — gated on canCompare so stale results from a previous
            selection never linger once the selection becomes incomplete or
            invalid. */}
        {isLoading && canCompare ? (
          <div className="space-y-3">
            <Skeleton className="h-32 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
          </div>
        ) : canCompare && entityA && entityB ? (
          <div className="space-y-4">
            {/* Entity labels */}
            <div className="grid grid-cols-3 items-center gap-2 text-xs">
              <span />
              <div className="text-center">
                <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
                  {entityA.name}
                </Badge>
              </div>
              <div className="text-center">
                <Badge variant="outline">{entityB.name}</Badge>
              </div>
            </div>

            {/* Side-by-side productivity score bars */}
            <div className="grid grid-cols-2 gap-3">
              <div className="text-center space-y-1">
                <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{entityA.productivityScore}%</p>
                <p className="text-[10px] text-muted-foreground">Productivity Score</p>
                <div className="h-2 bg-muted rounded-full overflow-hidden mx-4">
                  <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${entityA.productivityScore}%` }} />
                </div>
              </div>
              <div className="text-center space-y-1">
                <p className="text-2xl font-bold text-foreground">{entityB.productivityScore}%</p>
                <p className="text-[10px] text-muted-foreground">Productivity Score</p>
                <div className="h-2 bg-muted rounded-full overflow-hidden mx-4">
                  <div className="h-full bg-emerald-500/40 rounded-full" style={{ width: `${entityB.productivityScore}%` }} />
                </div>
              </div>
            </div>
            <div className="flex justify-center">
              <DeltaIndicator
                value={entityB.productivityScore !== 0 ? Math.round(((entityA.productivityScore - entityB.productivityScore) / entityB.productivityScore) * 100) : (entityA.productivityScore > 0 ? 100 : 0)}
              />
            </div>

            {/* Key Metrics Table */}
            <Card className="bg-muted/30 border-0">
              <CardContent className="p-3">
                <div className="grid grid-cols-3 items-center gap-2 text-xs font-medium text-muted-foreground mb-1 pb-1.5 border-b border-border">
                  <span>Metrics</span>
                  <span className="text-center">A</span>
                  <span className="text-center">B &amp; Delta</span>
                </div>
                <MetricCard label="Active Hours" valueA={entityA.activeHours} valueB={entityB.activeHours} icon={Clock} format={(v) => `${v}h`} />
                <MetricCard label="Active Employees" valueA={entityA.activeEmployees} valueB={entityB.activeEmployees} icon={Users} />
                <MetricCard label="Activities" valueA={entityA.totalActivities} valueB={entityB.totalActivities} icon={Activity} format={(v) => v.toLocaleString()} />
                {entityA.activeDays !== undefined && entityB.activeDays !== undefined && (
                  <MetricCard label="Active Days" valueA={entityA.activeDays} valueB={entityB.activeDays} icon={CalendarIcon} />
                )}
                <MetricCard label="Productive Hrs" valueA={entityA.productiveHours} valueB={entityB.productiveHours} icon={TrendingUp} format={(v) => `${v}h`} />
              </CardContent>
            </Card>

            {/* Workload Distribution Comparison */}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-2">Workload Distribution</h4>
              <div className="space-y-3">
                <WorkloadBar label="productive" valueA={entityA.workload.productive} valueB={entityB.workload.productive} />
                <WorkloadBar label="neutral" valueA={entityA.workload.neutral} valueB={entityB.workload.neutral} />
                <WorkloadBar label="unproductive" valueA={entityA.workload.unproductive} valueB={entityB.workload.unproductive} />
              </div>
            </div>

            {/* Top Applications Comparison */}
            <div>
              <h4 className="text-xs font-medium text-muted-foreground mb-2">Top Applications</h4>
              <AppComparison appsA={entityA.topApps} appsB={entityB.topApps} />
            </div>
          </div>
        ) : canCompare ? null : (
          <div className="text-center py-6 text-sm text-muted-foreground">
            <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>{mode === 'departments'
              ? 'Select two different departments to compare'
              : 'Select date ranges for both periods'}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}