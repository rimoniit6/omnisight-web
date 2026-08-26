'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useMemo } from 'react';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';

import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  LineChart, Line,
} from 'recharts';
import {
  Mail, Phone, Calendar, Building2, Monitor, Clock, CheckCircle2, AlertTriangle, MinusCircle,
  Timer, TrendingUp, AppWindow, BarChart3,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { EmployeePerformanceProfile } from './employee-performance-profile';
import { AvatarUpload } from '@/components/upload/avatar-upload';
import { isHeartbeatFresh } from '@/lib/presence';

interface EmployeeDetailDrawerProps {
  employeeId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const typeIcons: Record<string, { label: string; color: string }> = {
  application: { label: 'App', color: 'bg-emerald-100 text-emerald-700' },
  website: { label: 'Web', color: 'bg-teal-100 text-teal-700' },
  idle: { label: 'Idle', color: 'bg-amber-100 text-amber-700' },
  screenshot: { label: 'Screenshot', color: 'bg-slate-100 text-slate-700' },
  work_session: { label: 'Session', color: 'bg-blue-100 text-blue-700' },
};

const statusColors: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; class: string }> = {
  active: { variant: 'default', class: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' },
  inactive: { variant: 'outline', class: 'bg-orange-100 text-orange-700 hover:bg-orange-100 border-orange-200' },
  archived: { variant: 'secondary', class: 'bg-gray-100 text-gray-600 hover:bg-gray-100' },
};

const deviceStatusColors: Record<string, string> = {
  online: 'bg-emerald-100 text-emerald-700',
  offline: 'bg-red-100 text-red-700',
  maintenance: 'bg-yellow-100 text-yellow-700',
  inactive: 'bg-gray-100 text-gray-600',
};

// Device.status is a sticky lifecycle field — live online/offline is derived
// from heartbeat freshness (same centralized presence semantics as everywhere
// else); lifecycle-pinned statuses render literally.
function liveDeviceStatus(dev: Record<string, unknown>): string {
  const s = String(dev.status || '');
  if (['maintenance', 'inactive', 'retired'].includes(s)) return s;
  return dev.lastHeartbeat && isHeartbeatFresh(new Date(dev.lastHeartbeat as string)) ? 'online' : 'offline';
}

const categoryFilterOptions = [
  { value: 'all', label: 'All' },
  { value: 'productive', label: 'Productive' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'unproductive', label: 'Unproductive' },
] as const;

const categoryColors: Record<string, string> = {
  all: 'bg-primary text-primary-foreground',
  productive: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100',
  neutral: 'bg-amber-100 text-amber-700 hover:bg-amber-100',
  unproductive: 'bg-rose-100 text-rose-700 hover:bg-rose-100',
};

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function formatHours(seconds: number): string {
  return (seconds / 3600).toFixed(1);
}

function ProductivityScoreRing({ percentage }: { percentage: number }) {
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (circumference * percentage) / 100;

  return (
    <div className="flex flex-col items-center justify-center py-2">
      <div className="relative" style={{ width: 80, height: 80 }}>
        <svg width="80" height="80" viewBox="0 0 80 80" className="-rotate-90">
          <defs>
            <linearGradient id="scoreGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#10b981" />
              <stop offset="100%" stopColor="#14b8a6" />
            </linearGradient>
          </defs>
          <circle cx="40" cy="40" r={radius} fill="none" stroke="var(--muted)" strokeWidth="8" />
          <circle cx="40" cy="40" r={radius} fill="none" stroke="url(#scoreGradient)" strokeWidth="8" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} style={{ transition: 'stroke-dashoffset 1s ease-in-out' }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-bold text-emerald-600">{percentage}%</span>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground mt-1.5 font-medium">Productivity Score</p>
    </div>
  );
}

export function EmployeeDetailDrawer({ employeeId, open, onOpenChange }: EmployeeDetailDrawerProps) {
  const [viewMode, setViewMode] = useState<'summary' | 'profile'>('summary');

  // Reset view mode when drawer closes
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setViewMode('summary');
    }
    onOpenChange(newOpen);
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className={
        viewMode === 'profile'
          ? 'w-full sm:max-w-3xl p-0 overflow-hidden flex flex-col transition-all duration-300'
          : 'w-full sm:max-w-lg p-0 overflow-hidden flex flex-col transition-all duration-300'
      }>
        <DrawerInnerContent
          key={employeeId || '_empty'}
          employeeId={employeeId}
          viewMode={viewMode}
          onViewProfile={() => setViewMode('profile')}
          onBack={() => setViewMode('summary')}
        />
      </SheetContent>
    </Sheet>
  );
}

function DrawerInnerContent({
  employeeId, viewMode, onViewProfile, onBack,
}: {
  employeeId: string | null;
  viewMode: 'summary' | 'profile';
  onViewProfile: () => void;
  onBack: () => void;
}) {
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['employee-details', employeeId],
    queryFn: async () => {
      if (!employeeId) return null;
      const res = await fetch(`/api/employees/${employeeId}/detail`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!employeeId && viewMode === 'summary',
  });

  const emp = data?.employee;
  const summary = data?.activitySummary;
  // Memoized so derived useMemo/useCallback deps stay referentially stable.
  const activities = useMemo(() => data?.activities || [], [data]);
  const dailyProductivity = useMemo(() => data?.dailyProductivity || [], [data]);

  const totalTime = summary?.totalTime || 1;
  const productivePct = Math.round(((summary?.productiveTime || 0) / totalTime) * 100);
  const neutralPct = Math.round(((summary?.neutralTime || 0) / totalTime) * 100);
  const unproductivePct = 100 - productivePct - neutralPct;

  const keyMetrics = useMemo(() => {
    const totalHours = formatHours(summary?.totalTime || 0);
    const avgDaily = formatHours((summary?.totalTime || 0) / 7);
    const appMap: Record<string, number> = {};
    for (const act of activities) {
      const name = (act.applicationName || act.title || 'Unknown') as string;
      if (name && name !== 'Unknown') {
        appMap[name] = (appMap[name] || 0) + (act.duration as number || 0);
      }
    }
    let topApp = '—';
    let topDuration = 0;
    for (const [name, dur] of Object.entries(appMap)) {
      if (dur > topDuration) { topApp = name; topDuration = dur; }
    }
    return { totalHours, avgDaily, topApp };
  }, [summary, activities]);

  const filteredActivities = useMemo(() => {
    if (categoryFilter === 'all') return activities;
    return activities.filter((act: Record<string, unknown>) => act.category === categoryFilter);
  }, [activities, categoryFilter]);

  const sparklineData = useMemo(() => {
    return dailyProductivity.map((day: Record<string, number>) => {
      const total = (day.productive || 0) + (day.neutral || 0) + (day.unproductive || 0);
      const pct = total > 0 ? Math.round(((day.productive || 0) / total) * 100) : 0;
      return { pct };
    });
  }, [dailyProductivity]);

  if (viewMode === 'profile' && employeeId) {
    return <EmployeePerformanceProfile employeeId={employeeId} onBack={onBack} />;
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-60" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!emp) {
    return <div className="p-6 text-center text-muted-foreground">Employee not found</div>;
  }

  return (
    <>
      {/* Header */}
      <div className="p-6 pb-4 border-b">
        <SheetHeader>
          <SheetDescription className="sr-only">Employee details</SheetDescription>
        </SheetHeader>
        <div className="flex items-start gap-4 mt-2">
          <AvatarUpload
            currentAvatar={emp.avatar}
            entityId={emp.id}
            entityType="employee"
            name={`${emp.firstName} ${emp.lastName}`}
            size="lg"
            editable
            onUpdated={() => {
              queryClient.invalidateQueries({ queryKey: ['employee-details', employeeId] });
              queryClient.invalidateQueries({ queryKey: ['employees'] });
            }}
          />
          <div className="flex-1 min-w-0">
            <SheetTitle className="text-lg">{emp.firstName} {emp.lastName}</SheetTitle>
            <p className="text-sm text-muted-foreground mt-0.5">{emp.designation || 'No designation'}</p>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge className={statusColors[emp.status]?.class || ''} variant={statusColors[emp.status]?.variant || 'outline'}>
                {emp.status}
              </Badge>
              {emp.department && (
                <Badge variant="outline" className="text-xs">
                  <Building2 className="w-3 h-3 mr-1" /> {emp.department.name}
                </Badge>
              )}
              <span className="text-xs text-muted-foreground font-mono">ID: {emp.employeeId}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="flex-1 flex flex-col min-h-0">
        <div className="px-6 pt-3 flex items-center justify-between">
          <TabsList className="w-auto">
            <TabsTrigger value="overview" className="px-4">Overview</TabsTrigger>
            <TabsTrigger value="activity" className="px-4">Activity</TabsTrigger>
            <TabsTrigger value="devices" className="px-4">Devices</TabsTrigger>
          </TabsList>
          <Button
            variant="outline"
            size="sm"
            onClick={onViewProfile}
            className="text-xs border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 shrink-0"
          >
            <BarChart3 className="w-3.5 h-3.5 mr-1.5" />
            View Full Profile
          </Button>
        </div>

        <ScrollArea className="flex-1 px-6 pb-6">
          {/* Overview Tab */}
          <TabsContent value="overview" className="mt-4 space-y-4">
            <div className="flex justify-center p-4 bg-muted/40 rounded-xl border border-border">
              <ProductivityScoreRing percentage={productivePct} />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="flex flex-col items-center gap-1.5 p-3 bg-muted/30 rounded-lg">
                <div className="h-8 w-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                  <Timer className="w-4 h-4 text-emerald-600" />
                </div>
                <span className="text-sm font-bold">{keyMetrics.totalHours}h</span>
                <span className="text-[10px] text-muted-foreground">Total Hours</span>
              </div>
              <div className="flex flex-col items-center gap-1.5 p-3 bg-muted/30 rounded-lg">
                <div className="h-8 w-8 rounded-lg bg-teal-500/10 flex items-center justify-center">
                  <TrendingUp className="w-4 h-4 text-teal-600" />
                </div>
                <span className="text-sm font-bold">{keyMetrics.avgDaily}h</span>
                <span className="text-[10px] text-muted-foreground">Avg Daily</span>
              </div>
              <div className="flex flex-col items-center gap-1.5 p-3 bg-muted/30 rounded-lg">
                <div className="h-8 w-8 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                  <AppWindow className="w-4 h-4 text-cyan-600" />
                </div>
                <span className="text-sm font-bold truncate max-w-full px-1">{keyMetrics.topApp}</span>
                <span className="text-[10px] text-muted-foreground">Top App</span>
              </div>
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
                  <Mail className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">Email</p>
                  <p className="text-xs font-medium truncate">{emp.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
                  <Phone className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">Phone</p>
                  <p className="text-xs font-medium truncate">{emp.phone || '—'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
                  <Calendar className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">Join Date</p>
                  <p className="text-xs font-medium">{emp.joinDate ? format(new Date(emp.joinDate), 'MMM dd, yyyy') : '—'}</p>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
                  <Building2 className="w-4 h-4 text-muted-foreground" />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] text-muted-foreground">Department</p>
                  <p className="text-xs font-medium truncate">{emp.department?.name || '—'}</p>
                </div>
              </div>
            </div>

            <Separator />

            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Current Device</h4>
              {emp.devices && emp.devices.length > 0 ? (
                <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg">
                  <div className="h-9 w-9 rounded-lg bg-emerald-50 flex items-center justify-center">
                    <Monitor className="w-4 h-4 text-emerald-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{emp.devices[0].name}</p>
                    <p className="text-xs text-muted-foreground">{emp.devices[0].operatingSystem || 'Unknown OS'}</p>
                  </div>
                  <Badge className={deviceStatusColors[liveDeviceStatus(emp.devices[0] as Record<string, unknown>)] || 'bg-gray-100 text-gray-600'} variant="secondary">
                    {liveDeviceStatus(emp.devices[0] as Record<string, unknown>)}
                  </Badge>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No devices assigned</p>
              )}
            </div>

            <Separator />

            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Time Breakdown</h4>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                    <span>Productive</span>
                  </div>
                  <span className="font-medium text-emerald-600">{formatDuration(summary?.productiveTime || 0)} ({productivePct}%)</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${productivePct}%` }} />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <MinusCircle className="w-3.5 h-3.5 text-amber-500" />
                    <span>Neutral</span>
                  </div>
                  <span className="font-medium text-amber-600">{formatDuration(summary?.neutralTime || 0)} ({neutralPct}%)</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-amber-500 rounded-full transition-all" style={{ width: `${neutralPct}%` }} />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
                    <span>Unproductive</span>
                  </div>
                  <span className="font-medium text-rose-600">{formatDuration(summary?.unproductiveTime || 0)} ({Math.max(0, unproductivePct)}%)</span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-rose-500 rounded-full transition-all" style={{ width: `${Math.max(0, unproductivePct)}%` }} />
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Activity Tab */}
          <TabsContent value="activity" className="mt-4 space-y-4">
            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Productivity Trend</h4>
              <div className="h-[60px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={sparklineData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                    <Line type="monotone" dataKey="pct" stroke="#10b981" strokeWidth={2} dot={false} activeDot={{ r: 3, fill: '#10b981', strokeWidth: 0 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Filter by Category</h4>
              <div className="flex gap-2 flex-wrap">
                {categoryFilterOptions.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setCategoryFilter(opt.value)}
                    className={`text-[11px] px-2.5 py-1 rounded-full font-medium transition-colors border-0 ${
                      categoryFilter === opt.value
                        ? categoryColors[opt.value]
                        : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <Separator />

            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Last 7 Days (minutes)</h4>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={dailyProductivity} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                    <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                    <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '11px' }} />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: '10px' }} />
                    <Bar dataKey="productive" stackId="1" fill="#10b981" name="Productive" radius={[0, 0, 0, 0]} animationBegin={200} animationDuration={800} />
                    <Bar dataKey="neutral" stackId="1" fill="#f59e0b" name="Neutral" animationBegin={400} animationDuration={800} />
                    <Bar dataKey="unproductive" stackId="1" fill="#f43f5e" name="Unproductive" radius={[4, 4, 0, 0]} animationBegin={600} animationDuration={800} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <Separator />

            <div>
              <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                Recent Activity{categoryFilter !== 'all' ? ` (${categoryFilter})` : ' (last 20)'}
              </h4>
              <div className="space-y-2 max-h-72 overflow-y-auto custom-scrollbar">
                {filteredActivities.slice(0, 20).map((act: Record<string, unknown>) => {
                  const typeInfo = typeIcons[act.type as string] || { label: act.type as string, color: 'bg-gray-100 text-gray-600' };
                  return (
                    <div key={act.id as string} className="flex items-start gap-2.5 p-2 rounded-lg hover:bg-muted/30 transition-colors">
                      <div className="mt-0.5">
                        <Badge variant="secondary" className={`text-[9px] h-4 px-1.5 border-0 ${typeInfo.color}`}>{typeInfo.label}</Badge>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{(act.applicationName || act.title || act.url || 'Unknown') as string}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-muted-foreground">
                            {formatDistanceToNow(new Date(act.timestamp as string), { addSuffix: true })}
                          </span>
                          <span className="text-[10px] text-muted-foreground">·</span>
                          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                            <Clock className="w-2.5 h-2.5" /> {formatDuration(act.duration as number)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {filteredActivities.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">No activity recorded</p>
                )}
              </div>
            </div>
          </TabsContent>

          {/* Devices Tab */}
          <TabsContent value="devices" className="mt-4 space-y-3">
            {emp.devices && emp.devices.length > 0 ? (
              emp.devices.map((dev: Record<string, unknown>) => (
                <div key={dev.id as string} className="flex items-center gap-3 p-3 border rounded-lg hover:bg-muted/30 transition-colors">
                  <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
                    <Monitor className="w-5 h-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{dev.name as string}</p>
                    <p className="text-xs text-muted-foreground truncate">{String(dev.operatingSystem || 'Unknown OS')} {dev.hostname ? `· ${dev.hostname}` : ''}</p>
                  </div>
                  <Badge className={deviceStatusColors[liveDeviceStatus(dev)] || 'bg-gray-100 text-gray-600'} variant="secondary">
                    {liveDeviceStatus(dev)}
                  </Badge>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No devices assigned</p>
            )}
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </>
  );
}
