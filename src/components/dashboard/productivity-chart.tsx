'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts';
import { useTheme } from 'next-themes';
import { chartTheme, getTooltipStyle } from '@/lib/chart-theme';

interface ProductivityChartProps {
  data?: Array<{
    date: string;
    productive: number;
    neutral: number;
    unproductive: number;
  }>;
  isLoading: boolean;
}

interface CustomCursorProps {
  points?: Array<{ x?: number; y?: number }>;
}

function CustomCursor({ points }: CustomCursorProps) {
  const point = points?.[0];
  if (!point) return null;
  return (
    <line
      x1={point.x}
      y1={10}
      x2={point.x}
      y2={260}
      stroke="var(--border)"
      strokeWidth={1}
      strokeDasharray="4 4"
    />
  );
}

export function ProductivityChart({ data, isLoading }: ProductivityChartProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  // Compute a reasonable max Y so the reference line is visible.
  // We use 75% of a typical 480-min (8h) workday as the reference.
  const referenceValue = 360;

  return (
    <Card className="border shadow-sm hover:shadow-lg transition-all duration-300">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Weekly Productivity (minutes)</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="chart-enter">
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="prodGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartTheme.colors.emerald} stopOpacity={0.35} />
                    <stop offset="95%" stopColor={chartTheme.colors.emerald} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="neutralGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartTheme.colors.amber} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={chartTheme.colors.amber} stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="unprodGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartTheme.colors.rose} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={chartTheme.colors.rose} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={isDark ? 'rgba(148,163,184,0.12)' : 'rgba(0,0,0,0.06)'}
                  vertical={false}
                />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke={isDark ? 'rgba(148,163,184,0.5)' : 'var(--muted-foreground)'} />
                <YAxis tick={{ fontSize: 11 }} stroke={isDark ? 'rgba(148,163,184,0.5)' : 'var(--muted-foreground)'} />
                <ReferenceLine
                  y={referenceValue}
                  stroke={chartTheme.colors.amber}
                  strokeDasharray="6 4"
                  strokeWidth={1.5}
                  label={{
                    value: 'Target',
                    position: 'insideTopRight',
                    fill: chartTheme.colors.amber,
                    fontSize: 11,
                    fontWeight: 600,
                  }}
                />
                <Tooltip
                  contentStyle={getTooltipStyle(isDark)}
                  cursor={<CustomCursor />}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: '12px' }} />
                <Area
                  type="monotone"
                  dataKey="productive"
                  stackId="1"
                  stroke={chartTheme.colors.emerald}
                  fill="url(#prodGrad)"
                  name="Productive"
                  animationBegin={200}
                  animationDuration={1000}
                  animationEasing="ease-out"
                  dot={(props: Record<string, unknown>) => {
                    const { cx, cy, payload } = props as { cx: number; cy: number; payload: { productive: number } };
                    return (
                      <circle
                        key={`dot-productive-${cx}`}
                        cx={cx}
                        cy={cy}
                        r={payload?.productive > 0 ? 4 : 0}
                        fill={chartTheme.colors.emerald}
                        stroke="white"
                        strokeWidth={2}
                        className="opacity-0 hover:opacity-100 transition-opacity"
                      />
                    );
                  }}
                  activeDot={{ r: 6, stroke: chartTheme.colors.emerald, strokeWidth: 2, fill: 'white' }}
                />
                <Area
                  type="monotone"
                  dataKey="neutral"
                  stackId="1"
                  stroke={chartTheme.colors.amber}
                  fill="url(#neutralGrad)"
                  name="Neutral"
                  animationBegin={400}
                  animationDuration={1000}
                  animationEasing="ease-out"
                />
                <Area
                  type="monotone"
                  dataKey="unproductive"
                  stackId="1"
                  stroke={chartTheme.colors.rose}
                  fill="url(#unprodGrad)"
                  name="Unproductive"
                  animationBegin={600}
                  animationDuration={1000}
                  animationEasing="ease-out"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
