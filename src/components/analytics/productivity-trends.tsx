'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceDot,
} from 'recharts';
import { ChevronDown, ChevronUp, TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { chartTheme, getTooltipStyle } from '@/lib/chart-theme';

interface TrendData {
  date: string;
  dateISO?: string;
  score: number;
  totalMinutes: number;
  productiveMinutes?: number;
  neutralMinutes?: number;
  unproductiveMinutes?: number;
}

interface ProductivityTrendsProps {
  data?: TrendData[];
  isLoading: boolean;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number; color: string }>; label?: string }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={getTooltipStyle()}>
      <p style={{ fontWeight: 600, marginBottom: 6 }}>{label}</p>
      {payload.map((entry, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2, fontSize: 12 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: entry.color }} />
          <span style={{ color: 'var(--muted-foreground)', textTransform: 'capitalize' }}>{entry.name === 'score' ? 'Productivity' : entry.name === 'productiveMinutes' ? 'Productive' : entry.name === 'neutralMinutes' ? 'Neutral' : 'Unproductive'}:</span>
          <span style={{ fontWeight: 500 }}>
            {entry.name === 'score' ? `${entry.value}%` : `${entry.value}min`}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ProductivityTrends({ data, isLoading }: ProductivityTrendsProps) {
  const [showDetails, setShowDetails] = useState(false);

  const { highest, lowest } = useMemo(() => {
    if (!data || data.length === 0) return { highest: null, lowest: null };
    let maxEntry = data[0];
    let minEntry = data[0];
    for (const d of data) {
      if (d.score > maxEntry.score) maxEntry = d;
      if (d.score < minEntry.score) minEntry = d;
    }
    return { highest: maxEntry, lowest: minEntry };
  }, [data]);

  return (
    <Card className='border shadow-sm'>
      <CardHeader className='pb-2'>
        <div className='flex items-center justify-between'>
          <CardTitle className='text-sm font-semibold'>Productivity Score Trend</CardTitle>
          {data && data.length > 0 && (
            <Button
              variant='ghost'
              size='sm'
              className='h-7 text-[11px] text-muted-foreground hover:text-foreground'
              onClick={() => setShowDetails(!showDetails)}
            >
              View Details
              {showDetails ? <ChevronUp className='w-3 h-3 ml-1' /> : <ChevronDown className='w-3 h-3 ml-1' />}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className='pt-0'>
        {isLoading ? (
          <Skeleton className='h-72 w-full' />
        ) : (
          <>
            <ResponsiveContainer width='100%' height={showDetails ? 220 : 280}>
              <AreaChart data={data} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id='scoreGradient' x1='0' y1='0' x2='0' y2='1'>
                    <stop offset='0%' stopColor={chartTheme.gradients.emeraldArea[0]} stopOpacity={0.35} />
                    <stop offset='100%' stopColor={chartTheme.gradients.emeraldArea[0]} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray='3 3' stroke='var(--border)' vertical={false} />
                <XAxis dataKey='date' tick={{ fontSize: 10 }} stroke='var(--muted-foreground)' interval='preserveStartEnd' />
                <YAxis tick={{ fontSize: 11 }} stroke='var(--muted-foreground)' domain={[0, 100]} />
                <Tooltip content={<CustomTooltip />} />
                <Area
                  type='monotone'
                  dataKey='score'
                  stroke={chartTheme.colors.emerald}
                  strokeWidth={2}
                  dot={{ fill: chartTheme.colors.emerald, r: 3 }}
                  fill='url(#scoreGradient)'
                  name='score'
                  animationBegin={200}
                  animationDuration={1000}
                  animationEasing='ease-out'
                />
                {/* Annotate highest point */}
                {highest && highest !== lowest && (
                  <ReferenceDot
                    x={highest.date}
                    y={highest.score}
                    r={6}
                    fill={chartTheme.colors.emerald}
                    stroke='white'
                    strokeWidth={2}
                    label={{
                      value: `${highest.score}%`,
                      position: 'top',
                      offset: 8,
                      fill: chartTheme.colors.emerald,
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  />
                )}
                {/* Annotate lowest point */}
                {lowest && highest !== lowest && (
                  <ReferenceDot
                    x={lowest.date}
                    y={lowest.score}
                    r={6}
                    fill={chartTheme.colors.rose}
                    stroke='white'
                    strokeWidth={2}
                    label={{
                      value: `${lowest.score}%`,
                      position: 'bottom',
                      offset: 8,
                      fill: chartTheme.colors.rose,
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>

            {/* Summary badges */}
            {highest && lowest && !showDetails && (
              <div className='flex items-center justify-center gap-4 mt-2 text-xs'>
                <div className='flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400'>
                  <TrendingUp className='w-3.5 h-3.5' />
                  <span>Peak: <strong>{highest.score}%</strong> ({highest.date})</span>
                </div>
                <div className='flex items-center gap-1.5 text-rose-600 dark:text-rose-400'>
                  <TrendingDown className='w-3.5 h-3.5' />
                  <span>Low: <strong>{lowest.score}%</strong> ({lowest.date})</span>
                </div>
              </div>
            )}

            {/* Daily Breakdown Table */}
            {showDetails && data && data.length > 0 && (
              <div className='mt-2 max-h-48 overflow-y-auto custom-scrollbar border rounded-lg'>
                <table className='w-full text-xs'>
                  <thead className='sticky top-0 bg-muted/80 backdrop-blur-sm'>
                    <tr>
                      <th className='text-left py-2 px-3 font-medium text-muted-foreground'>Date</th>
                      <th className='text-right py-2 px-3 font-medium text-muted-foreground'>Score</th>
                      <th className='text-right py-2 px-3 font-medium text-muted-foreground'>Total</th>
                      <th className='text-right py-2 px-3 font-medium text-emerald-600'>Prod.</th>
                      <th className='text-right py-2 px-3 font-medium text-amber-600'>Neutral</th>
                      <th className='text-right py-2 px-3 font-medium text-rose-600'>Unprod.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data].reverse().map((row, i) => (
                      <tr key={i} className='border-t hover:bg-muted/30 transition-colors'>
                        <td className='py-1.5 px-3 font-medium'>{row.date}</td>
                        <td className={cn('py-1.5 px-3 text-right font-semibold', row.score >= 70 ? 'text-emerald-600' : row.score >= 40 ? 'text-amber-600' : 'text-rose-600')}>
                          {row.score}%
                        </td>
                        <td className='py-1.5 px-3 text-right text-muted-foreground'>{row.totalMinutes}m</td>
                        <td className='py-1.5 px-3 text-right'>{row.productiveMinutes ?? '-'}m</td>
                        <td className='py-1.5 px-3 text-right'>{row.neutralMinutes ?? '-'}m</td>
                        <td className='py-1.5 px-3 text-right'>{row.unproductiveMinutes ?? '-'}m</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
