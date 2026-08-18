'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ProductivityTrends } from './productivity-trends';
import { DepartmentBreakdown } from './department-breakdown';
import { TopAppsWebsites } from './top-apps-websites';
import { ComparisonTool } from './comparison-tool';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Skeleton } from '@/components/ui/skeleton';
import { CalendarIcon, TrendingUp, Clock, Users, Activity, GitCompareArrows, X } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { toLocalDayKey } from '@/lib/compare-query';

type DatePreset = '7d' | '30d' | '90d' | 'custom';

function formatDateRange(from: Date, to: Date): string {
  return `${format(from, 'MMM d')} - ${format(to, 'MMM d, yyyy')}`;
}

function getPresetDates(preset: DatePreset): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date();
  switch (preset) {
    case '7d':
      from.setDate(from.getDate() - 6);
      break;
    case '30d':
      from.setDate(from.getDate() - 29);
      break;
    case '90d':
      from.setDate(from.getDate() - 89);
      break;
    default:
      from.setDate(from.getDate() - 6);
  }
  return { from, to };
}

const statCards = [
  {
    key: 'avgProductivity',
    label: 'Avg Productivity Score',
    icon: TrendingUp,
    iconColor: 'text-primary',
    iconBg: 'bg-primary/10',
    valueFormat: (v: number) => `${v}%`,
  },
  {
    key: 'totalProductiveHours',
    label: 'Total Productive Hours',
    icon: Clock,
    iconColor: 'text-info',
    iconBg: 'bg-info/10',
    valueFormat: (v: number) => `${v}h`,
  },
  {
    key: 'activeEmployees',
    label: 'Active Employees Tracked',
    icon: Users,
    iconColor: 'text-warning',
    iconBg: 'bg-warning/10',
    valueFormat: (v: number) => String(v),
  },
  {
    key: 'totalActivities',
    label: 'Data Points Analyzed',
    icon: Activity,
    iconColor: 'text-danger',
    iconBg: 'bg-danger/10',
    valueFormat: (v: number) => v.toLocaleString(),
  },
];

export function AnalyticsPage() {
  const [preset, setPreset] = useState<DatePreset>('7d');
  const [customFrom, setCustomFrom] = useState<Date | undefined>(undefined);
  const [customTo, setCustomTo] = useState<Date | undefined>(undefined);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [showCompare, setShowCompare] = useState(false);

  // From must not be after To (defensive — the calendars also disable such
  // picks). An inverted custom range is surfaced as a validation state and is
  // never sent to the API.
  const customRangeInvalid =
    preset === 'custom' && Boolean(customFrom && customTo && customFrom.getTime() > customTo.getTime());

  const dateRange = useMemo(() => {
    if (preset === 'custom' && customFrom && customTo && !customRangeInvalid) {
      return { from: customFrom, to: customTo };
    }
    return getPresetDates(preset);
  }, [preset, customFrom, customTo, customRangeInvalid]);

  const rangeLabel = useMemo(() => formatDateRange(dateRange.from, dateRange.to), [dateRange]);

  // Calendar dates are serialized as the LOCAL day (toLocalDayKey) — never
  // toISOString().split('T')[0], which shifts the selected day backward for
  // positive-offset zones (e.g. Asia/Dhaka +06).
  const params = useMemo(() => {
    if (customRangeInvalid) return null;
    const p = new URLSearchParams();
    p.set('startDate', toLocalDayKey(dateRange.from));
    p.set('endDate', toLocalDayKey(dateRange.to));
    return p.toString();
  }, [customRangeInvalid, dateRange]);

  const { data, isLoading } = useQuery({
    queryKey: ['analytics', params ?? 'invalid-range'],
    queryFn: async () => {
      const res = await fetch(`/api/analytics?${params}`);
      const json = await res.json();
      return json.data;
    },
    enabled: params !== null,
  });

  // Fetch departments for comparison tool
  const { data: departments } = useQuery({
    queryKey: ['departments-list'],
    queryFn: async () => {
      const res = await fetch('/api/departments');
      const json = await res.json();
      return (json.data || []) as { id: string; name: string }[];
    },
  });

  const handlePresetChange = (value: string) => {
    const p = value as DatePreset;
    setPreset(p);
    if (p !== 'custom') {
      setCustomFrom(undefined);
      setCustomTo(undefined);
    }
  };

  const handleCustomApply = () => {
    if (customFrom && customTo && customFrom.getTime() <= customTo.getTime()) {
      setCalendarOpen(false);
    }
  };

  const presets: Array<{ value: DatePreset; label: string }> = [
    { value: '7d', label: 'Last 7 Days' },
    { value: '30d', label: 'Last 30 Days' },
    { value: '90d', label: 'Last 90 Days' },
    { value: 'custom', label: 'Custom Range' },
  ];

  const workload = data?.summary?.workloadDistribution;

  return (
    <div className='space-y-5'>
      {/* Page header + Date Controls */}
      <div className='flex flex-col md:flex-row items-start md:items-center justify-between gap-3'>
        <div className='min-w-0'>
          <h2 className='text-xl font-semibold tracking-tight text-foreground'>Analytics</h2>
          <p className='text-sm text-muted-foreground mt-0.5 truncate'>
            Workforce productivity insights{preset !== 'custom' ? ` — ${rangeLabel}` : ''}
          </p>
        </div>
        <div className='flex items-center gap-2 md:ml-auto'>
          <Button
            variant={showCompare ? 'default' : 'outline'}
            size='sm'
            className={cn(
              'h-9 gap-1.5',
              showCompare
                ? 'bg-primary hover:bg-primary/90 text-primary-foreground'
                : ''
            )}
            onClick={() => setShowCompare(!showCompare)}
          >
            {showCompare ? <X className='w-3.5 h-3.5' /> : <GitCompareArrows className='w-3.5 h-3.5' />}
            {showCompare ? 'Close' : 'Compare'}
          </Button>

          <Select value={preset} onValueChange={handlePresetChange}>
            <SelectTrigger className='w-40'><SelectValue /></SelectTrigger>
            <SelectContent>
              {presets.map((p) => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {preset === 'custom' && (
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant='outline'
                  className={cn(
                    'h-9 justify-start text-left font-normal',
                    (!customFrom || !customTo) && 'text-muted-foreground'
                  )}
                >
                  <CalendarIcon className='mr-2 h-4 w-4' />
                  {customFrom && customTo ? rangeLabel : 'Pick a range'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className='w-auto p-0' align='end'>
                <div className='flex items-center justify-between p-3 border-b'>
                  <div className='grid grid-cols-2 gap-3'>
                    <div className='grid gap-1'>
                      <Label className='text-xs text-muted-foreground'>From</Label>
                      <Calendar
                        mode='single'
                        selected={customFrom}
                        onSelect={setCustomFrom}
                        className='rounded-md border'
                        disabled={customTo ? { after: customTo } : undefined}
                      />
                    </div>
                    <div className='grid gap-1'>
                      <Label className='text-xs text-muted-foreground'>To</Label>
                      <Calendar
                        mode='single'
                        selected={customTo}
                        onSelect={setCustomTo}
                        className='rounded-md border'
                        disabled={customFrom ? { before: customFrom } : undefined}
                      />
                    </div>
                  </div>
                </div>
                {customRangeInvalid && (
                  <div className='px-3 pb-1 text-xs text-destructive'>
                    From date must be on or before the To date.
                  </div>
                )}
                <div className='flex items-center justify-end p-3'>
                  <Button
                    size='sm'
                    className='bg-primary hover:bg-primary/90 text-primary-foreground'
                    onClick={handleCustomApply}
                    disabled={!customFrom || !customTo || customRangeInvalid}
                  >
                    Apply
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {/* Custom range validation — an inverted range is never silently
          turned into an empty chart; it is surfaced here and the API also
          rejects it defensively (400). */}
      {customRangeInvalid && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          From date must be on or before the To date. Please pick a valid range.
        </div>
      )}

      {/* Comparison Tool */}
      <AnimatePresence>
        {showCompare && departments && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <ComparisonTool departments={departments} dateRange={dateRange} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Summary Stat Cards */}
      <div className='grid grid-cols-2 lg:grid-cols-4 gap-4 stagger-children'>
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className='h-28 w-full rounded-xl' />
            ))
          : statCards.map((card) => {
              const Icon = card.icon;
              const value = data?.summary?.[card.key] ?? 0;
              return (
                <Card key={card.key} className='falcon-card falcon-card-hover overflow-hidden relative'>
                  <CardContent className='p-4'>
                    <div className='flex items-start justify-between'>
                      <div className={cn('h-9 w-9 rounded-lg flex items-center justify-center', card.iconBg)}>
                        <Icon className={cn('w-4 h-4', card.iconColor)} />
                      </div>
                      {card.key === 'avgProductivity' && (
                        <div className='h-10 w-10 rounded-full border-4 border-primary/20 bg-card flex items-center justify-center'>
                          <span className='text-xs font-bold text-primary'>{value}%</span>
                        </div>
                      )}
                    </div>
                    <div className='mt-3'>
                      <p className='text-2xl font-bold tracking-tight'>
                        {card.valueFormat(value)}
                      </p>
                      <p className='text-xs text-muted-foreground mt-0.5'>{card.label}</p>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
      </div>

      {/* Workload Distribution */}
      <Card className='border shadow-sm'>
        <CardContent className='p-4'>
          <h3 className='text-sm font-semibold mb-3'>Workload Distribution</h3>
          {isLoading ? (
            <Skeleton className='h-8 w-full rounded-full' />
          ) : (
            <div className='space-y-2'>
              <div className='h-6 rounded-full overflow-hidden flex bg-muted/50'>
                <div
                  className='bg-success transition-all duration-500 flex items-center justify-center'
                  style={{ width: `${workload?.productive ?? 0}%`, minWidth: workload?.productive ? 28 : 0 }}
                >
                  {workload && workload.productive >= 5 && (
                    <span className='text-[10px] font-semibold text-white'>{workload.productive}%</span>
                  )}
                </div>
                <div
                  className='bg-warning transition-all duration-500 flex items-center justify-center'
                  style={{ width: `${workload?.neutral ?? 0}%`, minWidth: workload?.neutral ? 28 : 0 }}
                >
                  {workload && workload.neutral >= 5 && (
                    <span className='text-[10px] font-semibold text-warning-foreground'>{workload.neutral}%</span>
                  )}
                </div>
                <div
                  className='bg-danger transition-all duration-500 flex items-center justify-center'
                  style={{ width: `${workload?.unproductive ?? 0}%`, minWidth: workload?.unproductive ? 28 : 0 }}
                >
                  {workload && workload.unproductive >= 5 && (
                    <span className='text-[10px] font-semibold text-white'>{workload.unproductive}%</span>
                  )}
                </div>
              </div>
              <div className='flex items-center gap-4 flex-wrap'>
                <div className='flex items-center gap-1.5'>
                  <div className='w-2.5 h-2.5 rounded-full bg-success' />
                  <span className='text-xs text-muted-foreground'>Productive {workload?.productive ?? 0}%</span>
                </div>
                <div className='flex items-center gap-1.5'>
                  <div className='w-2.5 h-2.5 rounded-full bg-warning' />
                  <span className='text-xs text-muted-foreground'>Neutral {workload?.neutral ?? 0}%</span>
                </div>
                <div className='flex items-center gap-1.5'>
                  <div className='w-2.5 h-2.5 rounded-full bg-danger' />
                  <span className='text-xs text-muted-foreground'>Unproductive {workload?.unproductive ?? 0}%</span>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Charts Row */}
      <div className='grid grid-cols-1 lg:grid-cols-2 gap-6'>
        <ProductivityTrends data={data?.productivityTrends} isLoading={isLoading} />
        <DepartmentBreakdown data={data?.departmentProductivity} isLoading={isLoading} />
      </div>

      {/* Top Apps */}
      <TopAppsWebsites data={data?.topApps} isLoading={isLoading} />
    </div>
  );
}
