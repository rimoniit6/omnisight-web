'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type DateRange } from 'react-day-picker';
import { subDays, format } from 'date-fns';
import { MapPin, Target, Clock, Crosshair } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { DatePickerWithRange } from '@/components/ui/date-picker-with-range';
import { formatDistanceToNow } from 'date-fns';

/**
 * Location — employee telemetry panel.
 *
 * Displays the latest geolocation fix (latitude/longitude/accuracy/recordedAt)
 * and a strictly paginated history table. No reverse geocoding, no addresses —
 * only the coordinates the agent legitimately reported. RBAC is enforced
 * server-side (org-scoped employee lookup).
 */

interface LocationResponse {
  latest: { id: string; latitude: number; longitude: number; accuracy: number; recordedAt: string } | null;
  history: Array<{ id: string; latitude: number; longitude: number; accuracy: number; recordedAt: string }>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function accuracyLabel(accuracy: number): string {
  if (accuracy <= 0) return 'unknown';
  if (accuracy < 10) return '±<10m (high)';
  if (accuracy < 100) return `±${Math.round(accuracy)}m`;
  return `±${Math.round(accuracy)}m (low)`;
}

export function LocationPanel({ employeeId }: { employeeId: string }) {
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => ({
    from: subDays(new Date(), 6),
    to: new Date(),
  }));
  const [page, setPage] = useState(1);

  const fromStr = dateRange?.from ? format(dateRange.from, 'yyyy-MM-dd') : undefined;
  const toStr = dateRange?.to ? format(dateRange.to, 'yyyy-MM-dd') : undefined;

  const { data, isLoading, isError, refetch } = useQuery<LocationResponse>({
    queryKey: ['employee-location', employeeId, fromStr, toStr, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '50' });
      if (fromStr) params.set('from', fromStr);
      if (toStr) params.set('to', toStr);
      const res = await fetch(`/api/employees/${employeeId}/location?${params}`);
      if (!res.ok) throw new Error(`http ${res.status}`);
      return res.json();
    },
    enabled: !!employeeId,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Coordinates reported by the employee's agent — accuracy and timestamp shown for every fix.
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
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : isError || !data ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="text-sm text-destructive font-medium">Failed to load location history</p>
            <p className="text-xs text-muted-foreground mt-1">The request could not be completed. Refresh to retry.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Latest fix */}
          {data.latest ? (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-emerald-500" /> Latest Location
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="font-mono text-lg font-semibold">
                    {data.latest.latitude.toFixed(5)}, {data.latest.longitude.toFixed(5)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Recorded {formatDistanceToNow(new Date(data.latest.recordedAt), { addSuffix: true })}
                  </p>
                </CardContent>
              </Card>
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Target className="w-4 h-4 text-teal-500" /> Accuracy
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-lg font-semibold">{accuracyLabel(data.latest.accuracy)}</p>
                  <p className="text-xs text-muted-foreground mt-1">Horizontal accuracy in meters</p>
                </CardContent>
              </Card>
              <Card className="border-0 shadow-sm">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Clock className="w-4 h-4 text-violet-500" /> Recorded At
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-lg font-semibold">{format(new Date(data.latest.recordedAt), 'MMM d, HH:mm')}</p>
                  <p className="text-xs text-muted-foreground mt-1">{format(new Date(data.latest.recordedAt), 'yyyy-MM-dd')}</p>
                </CardContent>
              </Card>
            </div>
          ) : (
            <Card>
              <CardContent className="py-10 text-center">
                <Crosshair className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No location fixes in the selected period</p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Location tracking is polled every few minutes while enabled and consented.
                </p>
              </CardContent>
            </Card>
          )}

          {/* History table */}
          {data.history.length > 0 ? (
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Location History</CardTitle>
                <CardDescription className="text-xs">{data.total} fixes in the selected period</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b">
                        <th className="py-2 pr-4 font-medium">Recorded At</th>
                        <th className="py-2 pr-4 font-medium">Latitude</th>
                        <th className="py-2 pr-4 font-medium">Longitude</th>
                        <th className="py-2 font-medium">Accuracy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.history.map((h) => (
                        <tr key={h.id} className="border-b border-muted/40 last:border-0">
                          <td className="py-2 pr-4 text-muted-foreground">
                            {format(new Date(h.recordedAt), 'MMM d, HH:mm:ss')}
                          </td>
                          <td className="py-2 pr-4 font-mono">{h.latitude.toFixed(5)}</td>
                          <td className="py-2 pr-4 font-mono">{h.longitude.toFixed(5)}</td>
                          <td className="py-2">
                            <Badge variant="secondary" className="text-[11px]">
                              {accuracyLabel(h.accuracy)}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.totalPages > 1 ? (
                  <div className="flex items-center justify-between mt-4">
                    <p className="text-xs text-muted-foreground">
                      Page {data.page} of {data.totalPages}
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
          ) : null}
        </>
      )}
    </div>
  );
}
