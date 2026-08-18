'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell, LabelList } from 'recharts';
import { chartTheme, getTooltipStyle } from '@/lib/chart-theme';
import { useTheme } from 'next-themes';

interface DepartmentBreakdownProps {
  data?: Array<{
    department: string;
    employees: number;
    score: number;
    productive: number;
    neutral: number;
    unproductive: number;
  }>;
  isLoading: boolean;
}

type ChartDatum = {
  department: string;
  employees: number;
  score: number;
  productive: number;
  neutral: number;
  unproductive: number;
  total: number;
};

export function DepartmentBreakdown({ data, isLoading }: DepartmentBreakdownProps) {
  const { theme } = useTheme();
  const isDark = theme === 'dark';

  // Build the chart dataset once. The `total` field is computed here (data-driven)
  // so the LabelList formatter never has to reach into an uncertain `entry.payload`.
  const chartData: ChartDatum[] = useMemo(
    () =>
      (data ?? []).map((d) => ({
        ...d,
        total: (d.productive ?? 0) + (d.neutral ?? 0) + (d.unproductive ?? 0),
      })),
    [data]
  );

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Department Productivity (minutes)</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <Skeleton className="h-72 w-full" />
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} margin={{ top: 20, right: 10, left: -10, bottom: 0 }} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis dataKey="department" tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
              <Tooltip
                contentStyle={getTooltipStyle(isDark)}
                formatter={(value: number, name: string) => {
                  const label = name.charAt(0).toUpperCase() + name.slice(1);
                  return [`${value} min`, label];
                }}
              />
              <Legend iconType="circle" wrapperStyle={{ fontSize: '11px' }} />
              <Bar dataKey="productive" stackId="a" name="Productive" radius={[0, 0, 0, 0]} animationBegin={200} animationDuration={800}>
                {chartData.map((_, i) => (
                  <Cell key={`prod-${i}`} fill={chartTheme.departmentColors[i % chartTheme.departmentColors.length]} />
                ))}
              </Bar>
              <Bar dataKey="neutral" stackId="a" fill={chartTheme.colors.amber} name="Neutral" radius={[0, 0, 0, 0]} animationBegin={400} animationDuration={800} />
              <Bar dataKey="unproductive" stackId="a" fill={chartTheme.colors.rose} name="Unproductive" radius={[6, 6, 0, 0]} animationBegin={600} animationDuration={800}>
                <LabelList dataKey="total" position="top" formatter={(value: number | undefined) => value ?? 0} style={{ fontSize: 10, fill: 'var(--muted-foreground)' }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
