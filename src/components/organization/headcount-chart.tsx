'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { Area, AreaChart, XAxis, YAxis, Pie, PieChart, Cell } from 'recharts';
import { Users, UserCheck, Armchair, Building2 } from 'lucide-react';

interface HeadcountData {
  total: number;
  active: number;
  inactive: number;
  onLeave: number;
  byMonth: Array<{ month: string; count: number }>;
}

interface HeadcountChartProps {
  data: HeadcountData;
}

const DONUT_COLORS = ['var(--success)', 'var(--warning)', 'var(--danger)'];

const chartConfig = {
  count: { label: 'Employees', color: 'var(--success)' },
};

export function HeadcountChart({ data }: HeadcountChartProps) {
  const donutData = useMemo(() => [
    { name: 'Active', value: data.active },
    { name: 'Inactive', value: data.inactive },
    { name: 'On Leave', value: data.onLeave },
  ].filter(d => d.value > 0), [data.active, data.inactive, data.onLeave]);

  return (
    <div className="space-y-6">
      {/* Stat Cards — real headcount only, no seat capacity */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <Users className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{data.total}</p>
                <p className="text-xs text-muted-foreground">Total Employees</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-teal-500/10 flex items-center justify-center">
                <UserCheck className="w-5 h-5 text-teal-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{data.active}</p>
                <p className="text-xs text-muted-foreground">Active</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                <Armchair className="w-5 h-5 text-cyan-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{data.inactive}</p>
                <p className="text-xs text-muted-foreground">Inactive</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <Building2 className="w-5 h-5 text-amber-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{data.onLeave}</p>
                <p className="text-xs text-muted-foreground">On Leave</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Headcount Growth */}
        <Card className="border shadow-sm lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Headcount Growth</CardTitle>
          </CardHeader>
          <CardContent>
            {data.byMonth.length > 0 ? (
              <div>
                <p className="text-sm text-muted-foreground mb-3">Employee count over the last 6 months</p>
                <ChartContainer config={chartConfig} className="h-[140px] w-full">
                  <AreaChart data={data.byMonth} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="headcountGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--success)" stopOpacity={0.3} />
                        <stop offset="100%" stopColor="var(--success)" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 10 }}
                      stroke="var(--muted-foreground)"
                      tickFormatter={(v: string) => v.split(' ')[0]}
                    />
                    <YAxis tick={{ fontSize: 10 }} stroke="var(--muted-foreground)" />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area
                      type="monotone"
                      dataKey="count"
                      stroke="var(--success)"
                      fill="url(#headcountGradient)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ChartContainer>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No data</p>
            )}
          </CardContent>
        </Card>

        {/* Donut Chart Breakdown */}
        <Card className="border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Headcount Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            {donutData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No data</p>
            ) : (
              <>
                <div className="flex items-center justify-center">
                  <ChartContainer config={chartConfig} className="h-[160px] w-[160px]">
                    <PieChart>
                      <Pie
                        data={donutData}
                        cx="50%"
                        cy="50%"
                        innerRadius={45}
                        outerRadius={70}
                        paddingAngle={3}
                        dataKey="value"
                        strokeWidth={0}
                      >
                        {donutData.map((_entry: { name: string; value: number }, index: number) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={DONUT_COLORS[donutData.length === 1 && _entry.name === 'Active' ? 0 : index]}
                          />
                        ))}
                      </Pie>
                      <ChartTooltip content={<ChartTooltipContent />} />
                    </PieChart>
                  </ChartContainer>
                </div>
                <div className="flex flex-col gap-2 mt-3">
                  {donutData.map((item, index) => (
                    <div key={item.name} className="flex items-center justify-between text-sm">
                      <div className="flex items-center gap-2">
                        <div
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: DONUT_COLORS[index] }}
                        />
                        <span className="text-muted-foreground">{item.name}</span>
                      </div>
                      <span className="font-medium">{item.value}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
