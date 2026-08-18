'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type DateRange } from 'react-day-picker';
import { subDays, format } from 'date-fns';
import { Globe, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { DatePickerWithRange } from '@/components/ui/date-picker-with-range';

/**
 * Website Domains — employee telemetry panel.
 *
 * Displays ONLY normalized bare domains (e.g. github.com) aggregated from the
 * website-type activity rows. Full URLs, paths, query parameters and page
 * content are never rendered — the stored value is already domain-only and
 * the endpoint strips any legacy prefix defensively.
 */

interface WebsitesResponse {
  data: Array<{ domain: string; visits: number; totalSeconds: number; firstSeen: string; lastSeen: string }>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  summary: { totalSeconds: number; totalVisits: number; domains: number };
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function WebsiteDomainsPanel({ employeeId }: { employeeId: string }) {
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => ({
    from: subDays(new Date(), 6),
    to: new Date(),
  }));
  const [page, setPage] = useState(1);

  const fromStr = dateRange?.from ? format(dateRange.from, 'yyyy-MM-dd') : undefined;
  const toStr = dateRange?.to ? format(dateRange.to, 'yyyy-MM-dd') : undefined;

  const { data, isLoading, isError, refetch } = useQuery<WebsitesResponse>({
    queryKey: ['employee-websites', employeeId, fromStr, toStr, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (fromStr) params.set('from', fromStr);
      if (toStr) params.set('to', toStr);
      const res = await fetch(`/api/employees/${employeeId}/websites?${params}`);
      if (!res.ok) throw new Error(`http ${res.status}`);
      return res.json();
    },
    enabled: !!employeeId,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Bare domains only — full URLs, paths and page content are never stored or shown.
        </p>
        <div className="flex items-center gap-2">
          <DatePickerWithRange date={dateRange} onDateChange={(r) => { setDateRange(r); setPage(1); }} />
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
        <Skeleton className="h-64" />
      ) : isError || !data ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-destructive font-medium">Failed to load website activity</p>
            <p className="text-xs text-muted-foreground mt-1">The request could not be completed. Refresh to retry.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Domains</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{data.summary.domains}</p>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Visits</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{data.summary.totalVisits.toLocaleString()}</p>
              </CardContent>
            </Card>
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">Time on Websites</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold">{formatDuration(data.summary.totalSeconds)}</p>
              </CardContent>
            </Card>
          </div>

          {data.data.length > 0 ? (
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Globe className="w-4 h-4 text-teal-500" /> Domain Usage
                </CardTitle>
                <CardDescription className="text-xs">Aggregated by bare domain across the selected period</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b">
                        <th className="py-2 pr-4 font-medium">Domain</th>
                        <th className="py-2 pr-4 font-medium text-right">Visits</th>
                        <th className="py-2 pr-4 font-medium text-right">Duration</th>
                        <th className="py-2 pr-4 font-medium">First Seen</th>
                        <th className="py-2 font-medium">Last Seen</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.data.map((d) => (
                        <tr key={d.domain} className="border-b border-muted/40 last:border-0">
                          <td className="py-2 pr-4">
                            <span className="font-mono flex items-center gap-1.5">
                              <ExternalLink className="w-3 h-3 text-muted-foreground" /> {d.domain}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-right">
                            <Badge variant="secondary" className="text-[11px]">{d.visits}</Badge>
                          </td>
                          <td className="py-2 pr-4 text-right">{formatDuration(d.totalSeconds)}</td>
                          <td className="py-2 pr-4 text-muted-foreground">{format(new Date(d.firstSeen), 'MMM d, HH:mm')}</td>
                          <td className="py-2 text-muted-foreground">{format(new Date(d.lastSeen), 'MMM d, HH:mm')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.totalPages > 1 ? (
                  <div className="flex items-center justify-between mt-4">
                    <p className="text-xs text-muted-foreground">
                      Page {data.page} of {data.totalPages} · {data.total} domains
                    </p>
                    <div className="flex gap-2">
                      <button
                        disabled={page <= 1}
                        onClick={() => setPage((p) => p - 1)}
                        className="text-xs px-3 py-1.5 rounded-md border text-muted-foreground hover:bg-muted/50 disabled:opacity-40 transition-colors"
                        type="button"
                      >
                        Previous
                      </button>
                      <button
                        disabled={page >= data.totalPages}
                        onClick={() => setPage((p) => p + 1)}
                        className="text-xs px-3 py-1.5 rounded-md border text-muted-foreground hover:bg-muted/50 disabled:opacity-40 transition-colors"
                        type="button"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-10 text-center">
                <Globe className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No website activity in the selected period</p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Website tracking is collected as domain-only visits while enabled and consented.
                </p>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
