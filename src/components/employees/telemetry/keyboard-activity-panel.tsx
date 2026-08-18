'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type DateRange } from 'react-day-picker';
import { subDays, format } from 'date-fns';
import { Keyboard, MousePointerClick, Timer, Hash } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { DatePickerWithRange } from '@/components/ui/date-picker-with-range';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

/**
 * Keyboard Activity — employee telemetry panel.
 *
 * Displays ONLY aggregate keyboard metrics (keystrokeCount +
 * activeTypingSeconds). Raw key data does not exist anywhere in the system
 * and is never rendered. All statistics are computed server-side from the
 * real KeyboardActivity rows — nothing is fabricated or hardcoded.
 */

interface KeyboardResponse {
  data: Array<{
    id: string;
    intervalStart: string;
    intervalEnd: string;
    keystrokeCount: number;
    activeTypingSeconds: number;
    application: string | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary: { totalKeystrokes: number; totalActiveTypingSeconds: number; intervals: number };
  byDay: Array<{ date: string; keystrokes: number; activeTypingSeconds: number }>;
  byApplication: Array<{ application: string; keystrokes: number; activeTypingSeconds: number; intervals: number }>;
}

function formatTyping(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatCount(n: number): string {
  return n.toLocaleString();
}

function StatTile({ icon: Icon, label, value, sub, color = 'text-primary' }: {
  icon: typeof Hash; label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="p-4 rounded-xl border bg-card">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className={`w-4 h-4 ${color}`} />
        <p className="text-xs font-medium">{label}</p>
      </div>
      <p className="text-2xl font-bold mt-1">{value}</p>
      {sub ? <p className="text-[11px] text-muted-foreground mt-0.5">{sub}</p> : null}
    </div>
  );
}

export function KeyboardActivityPanel({ employeeId }: { employeeId: string }) {
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => ({
    from: subDays(new Date(), 6),
    to: new Date(),
  }));

  const fromStr = dateRange?.from ? format(dateRange.from, 'yyyy-MM-dd') : undefined;
  const toStr = dateRange?.to ? format(dateRange.to, 'yyyy-MM-dd') : undefined;

  const { data, isLoading, isError, refetch } = useQuery<KeyboardResponse>({
    queryKey: ['employee-keyboard', employeeId, fromStr, toStr],
    queryFn: async () => {
      const params = new URLSearchParams({ page: '1', pageSize: '100' });
      if (fromStr) params.set('from', fromStr);
      if (toStr) params.set('to', toStr);
      const res = await fetch(`/api/employees/${employeeId}/keyboard?${params}`);
      if (!res.ok) throw new Error(`http ${res.status}`);
      return res.json();
    },
    enabled: !!employeeId,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            Aggregate keystroke count and active typing time — no key content is ever collected.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DatePickerWithRange date={dateRange} onDateChange={setDateRange} />
          <button
            onClick={() => refetch()}
            className="text-xs px-3 py-1.5 rounded-md border text-muted-foreground hover:bg-muted/50 transition-colors"
            type="button"
          >
            Refresh
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : isError || !data ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-destructive font-medium">Failed to load keyboard activity</p>
            <p className="text-xs text-muted-foreground mt-1">The request could not be completed. Refresh to retry.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatTile icon={Hash} label="Keystrokes" value={formatCount(data.summary.totalKeystrokes)} sub={`${formatCount(data.summary.intervals)} intervals`} />
            <StatTile icon={Timer} label="Active Typing" value={formatTyping(data.summary.totalActiveTypingSeconds)} sub="across the selected period" color="text-emerald-500" />
            <StatTile icon={MousePointerClick} label="Intervals" value={formatCount(data.summary.intervals)} sub="1-minute aggregate buckets" color="text-teal-500" />
          </div>

          {data.byDay.length > 0 ? (
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Keyboard className="w-4 h-4 text-violet-500" /> Typing Activity Timeline
                </CardTitle>
                <CardDescription className="text-xs">Keystrokes per day</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-48">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.byDay} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} stroke="var(--border)" />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }} stroke="var(--border)" />
                      <Tooltip
                        cursor={{ fill: 'var(--muted)', opacity: 0.3 }}
                        contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '12px' }}
                      />
                      <Bar dataKey="keystrokes" fill="#8b5cf6" name="Keystrokes" radius={[4, 4, 0, 0]} animationDuration={500} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-10 text-center">
                <Keyboard className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No keyboard activity in the selected period</p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  This employee has no keystroke intervals recorded{dateRange?.from ? ` since ${format(dateRange.from, 'MMM d')}` : ''}.
                </p>
              </CardContent>
            </Card>
          )}

          {data.byApplication.length > 0 ? (
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Per-Application Breakdown</CardTitle>
                <CardDescription className="text-xs">Safe process names only — never window titles or content</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {data.byApplication.map((a) => {
                    const pct = data.summary.totalKeystrokes > 0 ? (a.keystrokes / data.summary.totalKeystrokes) * 100 : 0;
                    return (
                      <div key={a.application} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono truncate">{a.application}</span>
                          <span className="text-muted-foreground shrink-0">
                            {formatCount(a.keystrokes)} keys · {formatTyping(a.activeTypingSeconds)}
                          </span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div className="h-full bg-violet-500 rounded-full" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}
