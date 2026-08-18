'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Users, UserPlus, Clock, Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DepartmentStat {
  name: string;
  count: number;
  activeCount: number;
}

interface DesignationStat {
  designation: string;
  count: number;
}

interface StatusStat {
  status: string;
  count: number;
}

interface TopPerformer {
  id: string;
  firstName: string;
  lastName: string;
  designation: string | null;
  productivityScore: number;
}

interface StatisticsData {
  byDepartment: DepartmentStat[];
  byDesignation: DesignationStat[];
  byStatus: StatusStat[];
  newHiresThisMonth: number;
  avgTenure: number;
  topPerformers: TopPerformer[];
}

export function EmployeeStatistics() {
  const { data, isLoading } = useQuery<StatisticsData>({
    queryKey: ['employee-statistics'],
    queryFn: async () => {
      const res = await fetch('/api/employees/statistics');
      const json = await res.json();
      return json;
    },
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <Card key={i} className="border-border/50">
            <CardContent className="p-4">
              <div className="animate-pulse space-y-3">
                <div className="h-4 w-24 bg-muted rounded" />
                <div className="h-8 w-16 bg-muted rounded" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!data) return null;

  const totalHeadcount = data.byStatus.reduce((s, e) => s + e.count, 0) - (data.byStatus.find((s) => s.status === 'archived')?.count || 0);
  const activeCount = data.byStatus.find((s) => s.status === 'active')?.count || 0;
  const inactiveCount = data.byStatus.find((s) => s.status === 'inactive')?.count || 0;
  const archivedCount = data.byStatus.find((s) => s.status === 'archived')?.count || 0;
  const maxDeptCount = Math.max(...data.byDepartment.map((d) => d.count), 1);

  const statusSegments = [
    { label: 'Active', count: activeCount, color: 'bg-success', ringColor: 'ring-success/30' },
    { label: 'Inactive', count: inactiveCount, color: 'bg-warning', ringColor: 'ring-warning/30' },
    { label: 'Archived', count: archivedCount, color: 'bg-muted-foreground/50', ringColor: 'ring-muted' },
  ];

  const totalForDonut = activeCount + inactiveCount + archivedCount || 1;
  const donutSegments = statusSegments.map((seg) => ({
    ...seg,
    pct: (seg.count / totalForDonut) * 100,
  }));

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {/* Department Distribution */}
      <Card className="border-border/50">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
              <Users className="w-3.5 h-3.5 text-primary" />
            </div>
            <h3 className="text-sm font-semibold">Department Distribution</h3>
          </div>
          <div className="space-y-2.5 max-h-48 overflow-y-auto pr-1 custom-scrollbar">
            {data.byDepartment.map((dept) => (
              <div key={dept.name} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-foreground font-medium truncate max-w-[120px]">{dept.name}</span>
                  <span className="text-muted-foreground tabular-nums">{dept.count} <span className="text-primary">({dept.activeCount})</span></span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-500"
                    style={{ width: `${(dept.count / maxDeptCount) * 100}%` }}
                  />
                </div>
              </div>
            ))}
            {data.byDepartment.length === 0 && (
              <p className="text-xs text-muted-foreground py-2">No departments</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Status Breakdown + Key Metrics */}
      <Card className="border-border/50">
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
              <Clock className="w-3.5 h-3.5 text-primary" />
            </div>
            <h3 className="text-sm font-semibold">Status Breakdown</h3>
          </div>

          {/* Donut-style display */}
          <div className="flex items-center gap-4">
            <div className="relative w-20 h-20 shrink-0">
              <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                {/* Background circle */}
                <circle cx="18" cy="18" r="14" fill="none" stroke="currentColor" strokeWidth="4" className="text-muted/30" />
                {/* Segments */}
                {(() => {
                  let offset = 0;
                  return donutSegments
                    .filter((s) => s.pct > 0)
                    .map((seg) => {
                      const dashArray = `${seg.pct * 0.88} ${88 - seg.pct * 0.88}`;
                      const dashOffset = -offset * 0.88;
                      offset += seg.pct;
                      return (
                        <circle
                          key={seg.label}
                          cx="18" cy="18" r="14"
                          fill="none"
                          stroke={seg.label === 'Active' ? 'var(--success)' : seg.label === 'Inactive' ? 'var(--warning)' : 'var(--muted-foreground)'}
                          strokeWidth="4"
                          strokeDasharray={dashArray}
                          strokeDashoffset={dashOffset}
                          strokeLinecap="butt"
                          className="transition-all duration-500"
                        />
                      );
                    });
                })()}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-lg font-bold leading-none">{totalHeadcount}</span>
                <span className="text-[9px] text-muted-foreground mt-0.5">total</span>
              </div>
            </div>
            <div className="space-y-2 flex-1">
              {statusSegments.map((seg) => (
                <div key={seg.label} className="flex items-center gap-2 text-xs">
                  <span className={cn('w-2.5 h-2.5 rounded-full', seg.color)} />
                  <span className="text-muted-foreground flex-1">{seg.label}</span>
                  <span className="font-semibold tabular-nums">{seg.count}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Key metrics row */}
          <div className="grid grid-cols-2 gap-3 pt-1">
            <div className="rounded-lg bg-primary/5 border border-primary/10 p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <UserPlus className="w-3 h-3 text-primary" />
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">New Hires</span>
              </div>
              <p className="text-lg font-bold text-primary">{data.newHiresThisMonth}</p>
              <p className="text-[10px] text-muted-foreground">this month</p>
            </div>
            <div className="rounded-lg bg-info/5 border border-info/10 p-2.5">
              <div className="flex items-center gap-1.5 mb-1">
                <Clock className="w-3 h-3 text-info" />
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">Avg Tenure</span>
              </div>
              <p className="text-lg font-bold text-info">{data.avgTenure}</p>
              <p className="text-[10px] text-muted-foreground">months</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Top Performers + Designation Distribution */}
      <Card className="border-border/50">
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-primary/10 flex items-center justify-center">
              <Trophy className="w-3.5 h-3.5 text-primary" />
            </div>
            <h3 className="text-sm font-semibold">Top Performers</h3>
          </div>

          <div className="space-y-2">
            {data.topPerformers.length > 0 ? (
              data.topPerformers.map((emp, idx) => (
                <div key={emp.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50 transition-colors">
                  <span className={cn(
                    'w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0',
                    idx === 0 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' :
                    idx === 1 ? 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300' :
                    idx === 2 ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300' :
                    'bg-muted text-muted-foreground'
                  )}>
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">{emp.firstName} {emp.lastName}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{emp.designation || 'Employee'}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="h-8 w-8 relative">
                      <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                        <circle cx="18" cy="18" r="14" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/30" />
                        <circle
                          cx="18" cy="18" r="14"
                          fill="none"
                          stroke="var(--primary)"
                          strokeWidth="3"
                          strokeDasharray={`${emp.productivityScore * 0.88} ${88 - emp.productivityScore * 0.88}`}
                          strokeLinecap="round"
                          className="transition-all duration-500"
                        />
                      </svg>
                      <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-primary">
                        {emp.productivityScore}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground py-2 text-center">No activity data yet</p>
            )}
          </div>

          {/* Top designations */}
          {data.byDesignation.length > 0 && (
            <div className="pt-2 border-t border-border/50">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">Top Designations</p>
              <div className="flex flex-wrap gap-1.5">
                {data.byDesignation.slice(0, 4).map((d) => (
                  <span
                    key={d.designation}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-muted text-[11px] text-foreground"
                  >
                    {d.designation}
                    <span className="text-primary font-semibold">{d.count}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
