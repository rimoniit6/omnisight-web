'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { useTheme } from 'next-themes';
import { chartTheme, getTooltipStyle } from '@/lib/chart-theme';

const STATUS_COLORS: Record<string, string> = {
  online: chartTheme.colors.emerald,
  offline: '#ef4444',
  maintenance: chartTheme.colors.amber,
  inactive: '#94a3b8',
  retired: '#64748b',
};

interface DeviceStatusChartProps {
  data?: Array<{ status: string; _count: number }>;
  isLoading: boolean;
}

export function DeviceStatusChart({ data, isLoading }: DeviceStatusChartProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  const chartData = (data || []).map((d) => ({
    name: d.status.charAt(0).toUpperCase() + d.status.slice(1),
    value: d._count,
    fill: STATUS_COLORS[d.status] || '#94a3b8',
  }));

  const total = chartData.reduce((sum, d) => sum + d.value, 0);

  return (
    <Card className="border shadow-sm hover:shadow-lg transition-all duration-300">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Device Status</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : chartData.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">No data</div>
        ) : (
          <div className="chart-enter">
            <div className="relative">
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={85}
                    paddingAngle={3}
                    dataKey="value"
                    animationBegin={200}
                    animationDuration={800}
                    animationEasing="ease-out"
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={getTooltipStyle(isDark)}
                    formatter={(value, _name, props) => {
                      const numValue = Number(value) || 0;
                      const pct = total > 0 ? ((numValue / total) * 100).toFixed(1) : '0';
                      const label = (props?.payload as { name?: string } | undefined)?.name ?? '';
                      return [`${numValue} devices (${pct}%)`, label];
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              {/* Center label showing total devices */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="text-center">
                  <p className="text-2xl font-bold text-foreground">{total}</p>
                  <p className="text-[10px] text-muted-foreground">Devices</p>
                </div>
              </div>
            </div>
            {/* Custom legend with percentage values */}
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 px-1">
              {chartData.map((entry, i) => {
                const pct = total > 0 ? ((entry.value / total) * 100).toFixed(1) : '0';
                return (
                  <div key={i} className="flex items-center gap-1.5 text-xs">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: entry.fill }} />
                    <span className="truncate text-muted-foreground">{entry.name}</span>
                    <span className="ml-auto font-medium text-foreground">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
