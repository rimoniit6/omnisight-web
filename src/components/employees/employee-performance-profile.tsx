'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';
import {
  Clock, Zap, MinusCircle, AlertTriangle, Monitor, Wifi, WifiOff,
  TrendingDown, ShieldAlert, Timer, Calendar, Building2,
  ChevronLeft, Activity,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import { isHeartbeatFresh } from '@/lib/presence';
import { Button } from '@/components/ui/button';
import { useTheme } from 'next-themes';

interface EmployeePerformanceProfileProps {
  employeeId: string;
  onBack: () => void;
}

const severityConfig: Record<string, { color: string; bg: string; border: string; icon: typeof AlertTriangle }> = {
  low: { color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-200 dark:border-amber-800', icon: AlertTriangle },
  medium: { color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-900/20', border: 'border-orange-200 dark:border-orange-800', icon: ShieldAlert },
  high: { color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20', border: 'border-rose-200 dark:border-rose-800', icon: TrendingDown },
};

const riskTypeLabels: Record<string, { label: string; icon: typeof AlertTriangle }> = {
  high_idle_time: { label: 'High Idle Time', icon: Timer },
  declining_productivity: { label: 'Declining Productivity', icon: TrendingDown },
  unproductive_app_usage: { label: 'Unproductive App Usage', icon: AlertTriangle },
  irregular_hours: { label: 'Irregular Working Hours', icon: Clock },
  no_risks: { label: 'All Clear', icon: Activity },
};

const categoryBadgeClasses: Record<string, string> = {
  productive: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  neutral: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  unproductive: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
 idle: 'bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-400',
};

const statusColors: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100',
  inactive: 'bg-orange-100 text-orange-700 hover:bg-orange-100 border-orange-200',
  archived: 'bg-gray-100 text-gray-600 hover:bg-gray-100',
};

const PIE_COLORS = ['var(--success)', 'var(--warning)', 'var(--danger)'];
const APP_BAR_COLOR = 'var(--info)';

function AnimatedScoreRing({ score }: { score: number }) {
  const [animatedScore, setAnimatedScore] = useState(0);

  useEffect(() => {
    let current = 0;
    const step = score / 40;
    const interval = setInterval(() => {
      current += step;
      if (current >= score) {
        current = score;
        clearInterval(interval);
      }
      setAnimatedScore(Math.round(current));
    }, 25);
    return () => clearInterval(interval);
  }, [score]);

  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (circumference * animatedScore) / 100;

  const getScoreColor = (s: number) => {
    if (s >= 70) return { stroke: 'var(--success)', text: 'text-success', label: 'Excellent' };
    if (s >= 50) return { stroke: 'var(--info)', text: 'text-info', label: 'Good' };
    if (s >= 30) return { stroke: '#f59e0b', text: 'text-amber-600 dark:text-amber-400', label: 'Average' };
    return { stroke: '#f43f5e', text: 'text-rose-600 dark:text-rose-400', label: 'Needs Improvement' };
  };

  const scoreStyle = getScoreColor(score);

  return (
    <div className="flex flex-col items-center justify-center">
      <div className="relative" style={{ width: 140, height: 140 }}>
        <svg width="140" height="140" viewBox="0 0 140 140" className="-rotate-90">
          <defs>
            <linearGradient id="perfScoreGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor={scoreStyle.stroke} />
              <stop offset="100%" stopColor={scoreStyle.stroke} stopOpacity="0.6" />
            </linearGradient>
          </defs>
          {/* Background track */}
          <circle
            cx="70" cy="70" r={radius}
            fill="none"
            stroke="var(--muted)"
            strokeWidth="10"
          />
          {/* Score arc */}
          <circle
            cx="70" cy="70" r={radius}
            fill="none"
            stroke="url(#perfScoreGradient)"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.4s ease-out' }}
          />
          {/* Glow effect */}
          <circle
            cx="70" cy="70" r={radius}
            fill="none"
            stroke={scoreStyle.stroke}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.4s ease-out', filter: 'blur(6px)', opacity: 0.3 }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-3xl font-bold ${scoreStyle.text}`}>{animatedScore}</span>
          <span className="text-[10px] text-muted-foreground font-medium">out of 100</span>
        </div>
      </div>
      <span className={`text-sm font-semibold mt-2 ${scoreStyle.text}`}>{scoreStyle.label}</span>
    </div>
  );
}

function formatDurationMin(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

export function EmployeePerformanceProfile({ employeeId, onBack }: EmployeePerformanceProfileProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const { data, isLoading } = useQuery({
    queryKey: ['employee-performance', employeeId],
    queryFn: async () => {
      const res = await fetch(`/api/employees/${employeeId}/performance`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!employeeId,
  });

  const emp = data?.employee;
  const perf = data?.performance;

  // Pie chart data for activity distribution
  const pieData = useMemo(() => {
    if (!perf) return [];
    return [
      { name: 'Productive', value: perf.activityByCategory.productive || 0 },
      { name: 'Neutral', value: perf.activityByCategory.neutral || 0 },
      { name: 'Unproductive', value: perf.activityByCategory.unproductive || 0 },
    ].filter((d) => d.value > 0);
  }, [perf]);

  const tooltipStyle = useMemo(() => ({
    background: isDark ? '#1e293b' : '#ffffff',
    border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`,
    borderRadius: '8px',
    fontSize: '12px',
    color: isDark ? '#e5e7eb' : '#374151',
  }), [isDark]);

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-6 w-32" />
        </div>
        <div className="flex gap-6">
          <Skeleton className="h-48 w-48 rounded-full" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!emp || !perf) {
    return <div className="p-6 text-center text-muted-foreground">Performance data not available</div>;
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6">
        {/* Back button */}
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="w-4 h-4 mr-1" />
          Back to Summary
        </Button>

        {/* Header Section */}
        <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
          <div className="relative">
            <Avatar className="h-20 w-20 border-4 border-emerald-200 dark:border-emerald-800">
              <AvatarFallback className="text-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300 font-bold">
                {emp.firstName[0]}{emp.lastName[0]}
              </AvatarFallback>
            </Avatar>
            {/* Status indicator ring */}
            <div className={`absolute -bottom-0.5 -right-0.5 h-5 w-5 rounded-full border-2 border-background ${
              emp.status === 'active' ? 'bg-emerald-500' : emp.status === 'inactive' ? 'bg-orange-500' : 'bg-gray-400'
            }`} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-bold">{emp.firstName} {emp.lastName}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">{emp.designation || 'No designation'}</p>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <Badge className={statusColors[emp.status] || ''} variant="outline">
                {emp.status}
              </Badge>
              {emp.department && (
                <Badge variant="outline" className="text-xs">
                  <Building2 className="w-3 h-3 mr-1" /> {emp.department.name}
                </Badge>
              )}
              {emp.joinDate && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Calendar className="w-3 h-3" />
                  Joined {format(new Date(emp.joinDate), 'MMM dd, yyyy')}
                </span>
              )}
            </div>
          </div>
          {/* Overall Score Ring */}
          <AnimatedScoreRing score={perf.overallScore} />
        </div>

        {/* Performance Overview Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="border-l-4 border-l-emerald-500 hover:shadow-lg transition-shadow duration-300">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                  <Zap className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <span className="text-xs text-muted-foreground font-medium">Productive Hours</span>
              </div>
              <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{perf.productiveHours}h</p>
              <p className="text-[10px] text-muted-foreground mt-1">{perf.activityByCategory.productive}% of total</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-amber-500 hover:shadow-lg transition-shadow duration-300">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-8 w-8 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                  <MinusCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                </div>
                <span className="text-xs text-muted-foreground font-medium">Neutral Hours</span>
              </div>
              <p className="text-2xl font-bold text-amber-600 dark:text-amber-400">{perf.neutralHours}h</p>
              <p className="text-[10px] text-muted-foreground mt-1">{perf.activityByCategory.neutral}% of total</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-rose-500 hover:shadow-lg transition-shadow duration-300">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-8 w-8 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
                  <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                </div>
                <span className="text-xs text-muted-foreground font-medium">Unproductive Hours</span>
              </div>
              <p className="text-2xl font-bold text-rose-600 dark:text-rose-400">{perf.unproductiveHours}h</p>
              <p className="text-[10px] text-muted-foreground mt-1">{perf.activityByCategory.unproductive}% of total</p>
            </CardContent>
          </Card>

          <Card className="border-l-4 border-l-teal-500 hover:shadow-lg transition-shadow duration-300">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-8 w-8 rounded-lg bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center">
                  <Clock className="w-4 h-4 text-teal-600 dark:text-teal-400" />
                </div>
                <span className="text-xs text-muted-foreground font-medium">Total Tracked</span>
              </div>
              <p className="text-2xl font-bold text-teal-600 dark:text-teal-400">{perf.totalHoursTracked}h</p>
              <p className="text-[10px] text-muted-foreground mt-1">Avg {perf.avgDailyHours}h/day</p>
            </CardContent>
          </Card>
        </div>

        {/* Charts Section - 2x2 Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* 1. Productivity Trend (Area Chart) */}
          <Card className="hover:shadow-lg transition-shadow duration-300">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-500" />
                Productivity Trend (30 Days)
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={perf.productivityTrend} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                    <defs>
                      <linearGradient id="prodGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#f1f5f9'} />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 10 }}
                      stroke={isDark ? '#64748b' : '#94a3b8'}
                      interval={4}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      stroke={isDark ? '#64748b' : '#94a3b8'}
                      domain={[0, 100]}
                    />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Area
                      type="monotone"
                      dataKey="score"
                      stroke="#10b981"
                      strokeWidth={2}
                      fill="url(#prodGradient)"
                      animationBegin={0}
                      animationDuration={1000}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* 2. Activity Distribution (Pie/Donut Chart) */}
          <Card className="hover:shadow-lg transition-shadow duration-300">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Zap className="w-4 h-4 text-teal-500" />
                Activity Distribution
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="h-56 flex items-center justify-center">
                {pieData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={pieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={80}
                        paddingAngle={3}
                        dataKey="value"
                        animationBegin={0}
                        animationDuration={800}
                      >
                        {pieData.map((_entry, index) => (
                          <Cell key={`cell-${index}`} fill={PIE_COLORS[index]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(value: number) => [`${value}%`, '']}
                      />
                      <Legend
                        iconType="circle"
                        wrapperStyle={{ fontSize: '11px' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                ) : (
                  <p className="text-sm text-muted-foreground">No activity data available</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* 3. Weekly Pattern (Bar Chart) */}
          <Card className="hover:shadow-lg transition-shadow duration-300">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-500" />
                Weekly Pattern
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={perf.weeklyPattern} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#f1f5f9'} />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 10 }}
                      stroke={isDark ? '#64748b' : '#94a3b8'}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      stroke={isDark ? '#64748b' : '#94a3b8'}
                    />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Bar
                      dataKey="hours"
                      fill="#14b8a6"
                      radius={[4, 4, 0, 0]}
                      animationBegin={200}
                      animationDuration={800}
                      name="Hours"
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* 4. Top Applications (Horizontal Bar Chart) */}
          <Card className="hover:shadow-lg transition-shadow duration-300">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Monitor className="w-4 h-4 text-cyan-500" />
                Top Applications
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="h-56">
                {perf.topApplications.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={perf.topApplications}
                      layout="vertical"
                      margin={{ top: 5, right: 20, left: 5, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#f1f5f9'} horizontal={false} />
                      <XAxis
                        type="number"
                        tick={{ fontSize: 10 }}
                        stroke={isDark ? '#64748b' : '#94a3b8'}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        tick={{ fontSize: 10 }}
                        stroke={isDark ? '#64748b' : '#94a3b8'}
                        width={80}
                      />
                      <Tooltip
                        contentStyle={tooltipStyle}
                        formatter={(value: number) => [formatDurationMin(value), 'Duration']}
                      />
                      <Bar
                        dataKey="duration"
                        fill={APP_BAR_COLOR}
                        radius={[0, 4, 4, 0]}
                        animationBegin={400}
                        animationDuration={800}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <p className="text-sm text-muted-foreground">No application data available</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Top Websites */}
        {perf.topWebsites.length > 0 && (
          <Card className="hover:shadow-lg transition-shadow duration-300">
            <CardHeader className="pb-2 px-4 pt-4">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" />
                </svg>
                Top Websites
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="space-y-2">
                {perf.topWebsites.map((site: { name: string; duration: number; percentage: number }, idx: number) => (
                  <div key={site.name} className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground font-mono w-4 text-right">{idx + 1}</span>
                    <span className="text-sm font-medium flex-1 min-w-0 truncate">{site.name}</span>
                    <div className="w-24 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 rounded-full transition-all"
                        style={{ width: `${Math.min(site.percentage, 100)}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground w-12 text-right">{formatDurationMin(site.duration)}</span>
                    <Badge variant="secondary" className="text-[10px] w-10 justify-center">{site.percentage}%</Badge>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Risk Indicators */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" />
            Risk Indicators
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {perf.riskIndicators.map((risk: { type: string; severity: 'low' | 'medium' | 'high'; description: string }, idx: number) => {
              const config = severityConfig[risk.severity] || severityConfig.low;
              const riskInfo = riskTypeLabels[risk.type] || { label: risk.type, icon: AlertTriangle };
              const RiskIcon = riskInfo.icon;
              return (
                <div
                  key={idx}
                  className={`flex items-start gap-3 p-3 rounded-xl border ${config.bg} ${config.border}`}
                >
                  <div className={`h-8 w-8 rounded-lg ${config.bg} flex items-center justify-center shrink-0 mt-0.5`}>
                    <RiskIcon className={`w-4 h-4 ${config.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{riskInfo.label}</span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${config.color} ${config.border}`}
                      >
                        {risk.severity}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{risk.description}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Separator />

        {/* Recent Activity Feed */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Recent Activity
          </h3>
          <div className="space-y-2 max-h-80 overflow-y-auto custom-scrollbar">
            {perf.recentActivities.map((act: { id: string; type: string; title: string; category: string; duration: number; timestamp: string }) => (
              <div
                key={act.id}
                className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{act.title || act.type}</p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <Badge
                      variant="secondary"
                      className={`text-[9px] h-4 px-1.5 border-0 ${categoryBadgeClasses[act.category] || 'bg-slate-100 text-slate-600'}`}
                    >
                      {act.category || 'unknown'}
                    </Badge>
                    <span className="text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(act.timestamp), { addSuffix: true })}
                    </span>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground font-mono shrink-0">
                  {act.duration < 60 ? `${act.duration}s` : `${Math.round(act.duration / 60)}m`}
                </span>
              </div>
            ))}
            {perf.recentActivities.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">No recent activity</p>
            )}
          </div>
        </div>

        <Separator />

        {/* Devices Section */}
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
            <Monitor className="w-4 h-4" />
            Devices
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {perf.devicesUsed.map((device: { id: string; name: string; status: string; lastHeartbeat: string | null }) => {
              // Live status — heartbeat freshness, not the sticky column.
              const liveOnline = isHeartbeatFresh(device.lastHeartbeat ? new Date(device.lastHeartbeat) : null);
              const isOnline = ['maintenance', 'inactive', 'retired'].includes(device.status) ? device.status === 'online' : liveOnline;
              const displayStatus = ['maintenance', 'inactive', 'retired'].includes(device.status) ? device.status : isOnline ? 'online' : 'offline';
              return (
                <div
                  key={device.id}
                  className="flex items-center gap-3 p-3 border rounded-xl hover:bg-muted/30 transition-colors"
                >
                  <div className={`h-10 w-10 rounded-lg ${isOnline ? 'bg-emerald-50 dark:bg-emerald-900/20' : 'bg-muted'} flex items-center justify-center shrink-0`}>
                    {isOnline ? (
                      <Wifi className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <WifiOff className="w-5 h-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{device.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {device.lastHeartbeat
                        ? `Last seen ${formatDistanceToNow(new Date(device.lastHeartbeat), { addSuffix: true })}`
                        : 'No heartbeat'
                      }
                    </p>
                  </div>
                  <Badge
                    variant="secondary"
                    className={
                      displayStatus === 'online'
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                        : displayStatus === 'offline'
                          ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-400'
                    }
                  >
                    {displayStatus}
                  </Badge>
                </div>
              );
            })}
            {perf.devicesUsed.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4 col-span-2">No devices assigned</p>
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
