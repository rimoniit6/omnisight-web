'use client';

import { useEffect, useRef, useState } from 'react';
import { Users, Monitor, TrendingUp, AlertTriangle, Target } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

// ---------- Animated Counter Hook ----------
function useAnimatedCounter(target: number, duration: number = 1000, enabled: boolean = true) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled || target === 0) {
      return;
    }
    startRef.current = performance.now();

    const animate = (now: number) => {
      const elapsed = now - startRef.current;
      const progress = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(eased * target));
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration, enabled]);

  return display;
}

// ---------- Circular Progress Ring ----------
function CircularProgressRing({
  value,
  size = 48,
  strokeWidth = 4,
  color = 'var(--primary)',
}: {
  value: number; // 0-100
  size?: number;
  strokeWidth?: number;
  color?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const animatedValue = useAnimatedCounter(value, 1200);
  const offset = circumference - (animatedValue / 100) * circumference;

  return (
    <svg width={size} height={size} className="-rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-muted"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.3s ease-out' }}
      />
    </svg>
  );
}

// ---------- Types ----------
interface KpiCardsProps {
  data?: {
    totalEmployees: number;
    totalDevices: number;
    onlineDevices: number;
    avgProductivity: number;
    activeAlerts: number;
    productivityScore: number;
  };
  isLoading: boolean;
}

type KpiDef = {
  key: string;
  label: string;
  icon: React.ElementType;
  color: string;
  iconBg: string;
  change: string;
  changeNegative?: boolean;
  isSpecial?: boolean;
};

const kpis: KpiDef[] = [
  { key: 'totalEmployees', label: 'Total Employees', icon: Users, color: 'text-primary', iconBg: 'bg-primary/10', change: '' },
  { key: 'onlineDevices', label: 'Online Devices', icon: Monitor, color: 'text-info', iconBg: 'bg-info/10', change: '' },
  // P3-6: the value is productive HOURS per active employee (7-day window), not
  // a percentage — the label must say so or the KPI misreads as a score.
  { key: 'avgProductivity', label: 'Avg Productive Hrs', icon: TrendingUp, color: 'text-chart-3', iconBg: 'bg-chart-3/10', change: '', changeNegative: false },
  { key: 'activeAlerts', label: 'Active Alerts', icon: AlertTriangle, color: 'text-danger', iconBg: 'bg-danger/10', change: '' },
  { key: 'productivityScore', label: 'Productivity Score', icon: Target, color: 'text-primary', iconBg: 'bg-primary/10', change: '', isSpecial: true },
];

// ---------- KPI Card ----------
function KpiCard({ kpi, value, totalDevices }: { kpi: KpiDef; value: number; totalDevices?: number }) {
  const Icon = kpi.icon;
  const animatedValue = useAnimatedCounter(value, 1000, !kpi.isSpecial);

  const displayValue = kpi.key === 'onlineDevices'
    ? `${animatedValue}/${totalDevices ?? 0}`
    : kpi.key === 'avgProductivity'
      ? `${(animatedValue).toFixed(1)} hrs`
      : animatedValue.toString();

  // Productivity Score card with circular ring
  if (kpi.isSpecial) {
    return (
      <Card className="falcon-card falcon-card-hover relative overflow-hidden">
        <CardContent className="p-5">
          <div className="flex items-center gap-4">
            <div className="relative">
              <CircularProgressRing value={value} size={52} strokeWidth={4.5} />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xs font-bold text-primary">{value}%</span>
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground font-medium">{kpi.label}</p>
              <p className="text-2xl font-bold text-foreground mt-0.5">{value}%</p>
              <p className="text-xs mt-1 font-medium text-muted-foreground">
                {kpi.change ? `${kpi.change} vs last week` : 'overall score'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="falcon-card falcon-card-hover relative overflow-hidden group">
      <CardContent className="p-5">
        <div className="flex items-center gap-4">
          <div className={`h-11 w-11 rounded-lg ${kpi.iconBg} flex items-center justify-center shrink-0`}>
            <Icon className={`w-5 h-5 ${kpi.color}`} />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground font-medium">{kpi.label}</p>
            <div className="flex items-center gap-2">
              <p className="text-2xl font-bold text-foreground mt-0.5">{displayValue}</p>
              {kpi.key === 'activeAlerts' && value > 0 && (
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-danger opacity-60" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-danger" />
                </span>
              )}
            </div>
            <p className="text-xs mt-1 font-medium text-muted-foreground">
              {kpi.change ? `${kpi.change} ${kpi.key === 'activeAlerts' ? 'this week' : 'vs last week'}` : kpi.key === 'activeAlerts' ? 'active now' : 'current'}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- KpiCards ----------
export function KpiCards({ data, isLoading }: KpiCardsProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i} className="falcon-card rounded-xl border-l-4 border-l-transparent">
            <CardContent className="p-5">
              <div className="flex items-center gap-4">
                <Skeleton className="h-12 w-12 rounded-xl" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-7 w-16" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
      {kpis.map((kpi) => {
        const value = (data?.[kpi.key as keyof typeof data] as number) ?? 0;
        return (
          <KpiCard
            key={kpi.key}
            kpi={kpi}
            value={value}
            totalDevices={data?.totalDevices}
          />
        );
      })}
    </div>
  );
}
