'use client';

import { useQuery } from '@tanstack/react-query';
import { useState, useEffect, useMemo } from 'react';
import { type DateRange } from 'react-day-picker';
import { subDays, format } from 'date-fns';
import { MapPin, Target, Clock, Crosshair, AlertTriangle, WifiOff, Shield, RotateCcw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { DatePickerWithRange } from '@/components/ui/date-picker-with-range';
import { formatDistanceToNow } from 'date-fns';
import { calculateDistanceKm } from '@/lib/location-distance';

/**
 * Location — employee telemetry panel.
 *
 * Displays the latest accepted geolocation fix on an interactive map with a
 * strictly paginated history table. Includes status messages for disabled
 * tracking, missing consent, and no-data states. RBAC is enforced server-side
 * (org-scoped employee lookup).
 *
 * The map shows the CURRENT (latest accepted) location by default. Clicking a
 * history row moves the map to that historical accepted point; "Show Current
 * Location" returns the map to the latest accepted point. Only accepted
 * movement history is shown — the 5 KM server-side filter means sub-threshold
 * raw readings never become rows.
 */

interface LocationResponse {
  latest: { id: string; latitude: number; longitude: number; accuracy: number | null; recordedAt: string; source: string; address: string | null } | null;
  history: Array<{ id: string; latitude: number; longitude: number; accuracy: number | null; recordedAt: string; source: string }>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface TrackingStatus {
  consentGranted: boolean;
  trackingEnabled: boolean;
}

function accuracyLabel(accuracy: number | null): string {
  if (accuracy === null || accuracy === undefined) return 'Unknown accuracy';
  if (accuracy <= 0) return 'Unknown accuracy';
  if (accuracy < 10) return '±<10m (high)';
  if (accuracy < 100) return `±${Math.round(accuracy)}m`;
  return `±${Math.round(accuracy)}m (low)`;
}

function sourceLabel(source: string): { label: string; color: string; icon: string } {
  if (source === 'native') return { label: 'Device Location', color: 'text-emerald-600', icon: '📡' };
  return { label: 'IP-based (approximate)', color: 'text-amber-600', icon: '🌐' };
}

function freshnessLabel(recordedAt: string): { label: string; color: string } {
  const diffMs = Date.now() - new Date(recordedAt).getTime();
  const diffMin = diffMs / (1000 * 60);
  if (diffMin < 5) return { label: 'Live', color: 'text-emerald-600' };
  if (diffMin < 30) return { label: 'Recent', color: 'text-blue-600' };
  if (diffMin < 60) return { label: `${Math.floor(diffMin)}m ago`, color: 'text-amber-600' };
  const diffHours = diffMin / 60;
  if (diffHours < 24) return { label: `${Math.floor(diffHours)}h ago`, color: 'text-orange-600' };
  const diffDays = diffHours / 24;
  return { label: `${Math.floor(diffDays)}d ago`, color: 'text-red-600' };
}

function formatDistance(km: number): string {
  if (!Number.isFinite(km) || km < 0) return '—';
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

// Dynamic import for Leaflet map (avoids SSR/window errors)
function LocationMap({ latitude, longitude, accuracy, title, subtitle, highlight }: {
  latitude: number; longitude: number; accuracy: number | null; title?: string; subtitle?: string; highlight?: boolean;
}) {
  const [MapComponent, setMapComponent] = useState<React.ComponentType<{
    lat: number; lng: number; accuracy: number | null; title?: string; subtitle?: string; highlight?: boolean;
  }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    import('./location-map').then((mod) => {
      if (!cancelled) setMapComponent(() => mod.LocationMapInner);
    }).catch(() => {
      // Map failed to load — render fallback
    });
    return () => { cancelled = true; };
  }, []);

  if (!MapComponent) {
    return (
      <div className="h-[300px] rounded-lg bg-muted/30 flex items-center justify-center">
        <div className="text-center">
          <MapPin className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-xs text-muted-foreground">Loading map...</p>
        </div>
      </div>
    );
  }

  return <MapComponent lat={latitude} lng={longitude} accuracy={accuracy} title={title} subtitle={subtitle} highlight={highlight} />;;
}

export function LocationPanel({ employeeId }: { employeeId: string }) {
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => ({
    from: subDays(new Date(), 6),
    to: new Date(),
  }));
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fromStr = dateRange?.from ? format(dateRange.from, 'yyyy-MM-dd') : undefined;
  const toStr = dateRange?.to ? format(dateRange.to, 'yyyy-MM-dd') : undefined;

  const { data, isLoading, isError, refetch } = useQuery<LocationResponse>({
    queryKey: ['employee-location', employeeId, fromStr, toStr, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (fromStr) params.set('from', fromStr);
      if (toStr) params.set('to', toStr);
      const res = await fetch(`/api/employees/${employeeId}/location?${params}`);
      if (!res.ok) throw new Error(`http ${res.status}`);
      return res.json();
    },
    enabled: !!employeeId,
  });

  // Fetch tracking status (consent + org setting)
  const { data: trackingStatus } = useQuery<TrackingStatus>({
    queryKey: ['tracking-status', employeeId],
    queryFn: async () => {
      const res = await fetch(`/api/employees/${employeeId}/location/tracking-status`);
      if (!res.ok) return { consentGranted: false, trackingEnabled: false };
      return res.json();
    },
    enabled: !!employeeId,
    staleTime: 30_000,
  });

  const latest = data?.latest ?? null;
  const history = useMemo(() => data?.history ?? [], [data]);

  // The currently displayed point: a selected history row, else the latest.
  const selected = useMemo(
    () => history.find((h) => h.id === selectedId) ?? null,
    [history, selectedId]
  );
  const displayed = selected ?? latest;
  const displayedIsCurrent = !selected;

  // Source info for the displayed location
  const sourceInfo = displayed ? sourceLabel(displayed.source) : null;

  // Pre-compute distance moved for each history row (from the next older row).
  const distanceByRow = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 0; i < history.length; i++) {
      const cur = history[i];
      const prev = history[i + 1]; // older, accepted point
      if (prev) {
        map.set(cur.id, calculateDistanceKm(cur.latitude, cur.longitude, prev.latitude, prev.longitude));
      } else {
        map.set(cur.id, NaN); // unknown within this page
      }
    }
    return map;
  }, [history]);

  const freshness = displayed ? freshnessLabel(displayed.recordedAt) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Coordinates reported by the employee&apos;s agent — accuracy and timestamp shown for every fix.
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

      {/* Tracking Status Banner */}
      {trackingStatus && (
        <>
          {!trackingStatus.trackingEnabled && (
            <Card className="border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10">
              <CardContent className="py-3 px-4 flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Location Tracking is disabled for this organization.</p>
                  <p className="text-xs text-amber-600 dark:text-amber-400">Enable &quot;Location Tracking&quot; in Settings → Monitoring to start collecting location data.</p>
                </div>
              </CardContent>
            </Card>
          )}
          {trackingStatus.trackingEnabled && !trackingStatus.consentGranted && (
            <Card className="border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/10">
              <CardContent className="py-3 px-4 flex items-center gap-3">
                <Shield className="w-5 h-5 text-blue-600 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-blue-800 dark:text-blue-200">Location consent has not been granted by this employee.</p>
                  <p className="text-xs text-blue-600 dark:text-blue-400">The employee must grant location consent via the Consent page before location data is collected.</p>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* IP-based location warning */}
      {displayed && displayed.source === 'ip' && (
        <Card className="border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/10">
          <CardContent className="py-3 px-4 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Approximate Location (IP-based)</p>
              <p className="text-xs text-amber-600 dark:text-amber-400">This location is derived from the device&apos;s IP address and may be up to 10 km inaccurate. Device GPS was unavailable.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-[300px] w-full rounded-lg" />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}
          </div>
        </div>
      ) : isError || !data ? (
        <Card>
          <CardContent className="py-10 text-center">
            <WifiOff className="w-8 h-8 text-destructive/40 mx-auto mb-2" />
            <p className="text-sm text-destructive font-medium">Failed to load location history</p>
            <p className="text-xs text-muted-foreground mt-1">The request could not be completed. Refresh to retry.</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Map + Currently Displayed Location */}
          {displayed ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Map */}
              <Card className="lg:col-span-2 border-0 shadow-sm overflow-hidden">
                <CardContent className="p-0">
                  <LocationMap
                    latitude={displayed.latitude}
                    longitude={displayed.longitude}
                    accuracy={displayed.accuracy}
                    title={displayedIsCurrent ? 'Current Location' : format(new Date(displayed.recordedAt), 'MMM d, HH:mm')}
                    subtitle={displayedIsCurrent ? 'Latest accepted location' : 'Selected history point'}
                    highlight={!displayedIsCurrent}
                  />
                </CardContent>
              </Card>

              {/* Displayed Fix Details */}
              <div className="space-y-3">
                <Card className="border-0 shadow-sm">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-emerald-500" />
                      {displayedIsCurrent ? 'Current Location' : 'Selected Location'}
                      {freshness && (
                        <Badge variant="outline" className={`text-[10px] ${freshness.color} border-current`}>
                          {freshness.label}
                        </Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="font-mono text-lg font-semibold">
                      {displayed.latitude.toFixed(5)}, {displayed.longitude.toFixed(5)}
                    </p>
                    {sourceInfo && (
                      <p className={`text-xs mt-1 ${sourceInfo.color}`}>
                        {sourceInfo.icon} {sourceInfo.label}
                      </p>
                    )}
                    {'address' in displayed && (displayed as { address?: string | null }).address && (
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        📍 {(displayed as { address: string | null }).address}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      Recorded {formatDistanceToNow(new Date(displayed.recordedAt), { addSuffix: true })}
                    </p>
                    {!displayedIsCurrent && (
                      <button
                        type="button"
                        onClick={() => setSelectedId(null)}
                        className="mt-3 text-xs px-3 py-1.5 rounded-md border flex items-center gap-1.5 text-muted-foreground hover:bg-muted/50 transition-colors"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> Show Current Location
                      </button>
                    )}
                  </CardContent>
                </Card>
                <Card className="border-0 shadow-sm">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Target className="w-4 h-4 text-teal-500" /> Accuracy
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-lg font-semibold">{accuracyLabel(displayed.accuracy)}</p>
                    <p className="text-xs text-muted-foreground mt-1">{displayed.accuracy !== null ? 'Horizontal accuracy in meters' : 'Accuracy unavailable (IP-based location)'}</p>
                  </CardContent>
                </Card>
                <Card className="border-0 shadow-sm">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      <Clock className="w-4 h-4 text-violet-500" /> Recorded At
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-lg font-semibold">{format(new Date(displayed.recordedAt), 'MMM d, HH:mm')}</p>
                    <p className="text-xs text-muted-foreground mt-1">{format(new Date(displayed.recordedAt), 'yyyy-MM-dd')}</p>
                  </CardContent>
                </Card>
              </div>
            </div>
          ) : (
            <Card>
              <CardContent className="py-10 text-center">
                <Crosshair className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No location data received yet.</p>
                <p className="text-xs text-muted-foreground/70 mt-1">
                  Location tracking requires: (1) Location Tracking enabled in Settings, and (2) the employee must grant location consent.
                </p>
              </CardContent>
            </Card>
          )}

          {/* History table */}
          {history.length > 0 ? (
            <Card className="border-0 shadow-sm">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">Location History</CardTitle>
                <CardDescription className="text-xs">{data.total} accepted points in the selected period</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-muted-foreground border-b">
                        <th className="py-2 pr-4 font-medium">Time</th>
                        <th className="py-2 pr-4 font-medium">Location</th>
                        <th className="py-2 pr-4 font-medium">Distance Moved</th>
                        <th className="py-2 pr-4 font-medium">Accuracy</th>
                        <th className="py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((h) => {
                        const hFreshness = freshnessLabel(h.recordedAt);
                        const isCurrent = latest !== null && h.id === latest.id;
                        const dm = distanceByRow.get(h.id);
                        return (
                          <tr
                            key={h.id}
                            onClick={() => setSelectedId(h.id === selectedId ? null : h.id)}
                            className={`border-b border-muted/40 last:border-0 cursor-pointer transition-colors hover:bg-muted/40 ${
                              h.id === selectedId ? 'bg-teal-50 dark:bg-teal-900/20' : ''
                            }`}
                          >
                            <td className="py-2 pr-4 text-muted-foreground">
                              <span>{format(new Date(h.recordedAt), 'MMM d, HH:mm:ss')}</span>
                              <span className={`ml-2 text-[10px] ${hFreshness.color}`}>{hFreshness.label}</span>
                            </td>
                            <td className="py-2 pr-4 font-mono">
                              {h.latitude.toFixed(5)}, {h.longitude.toFixed(5)}
                              <span className={`ml-1 text-[9px] ${h.source === 'native' ? 'text-emerald-600' : 'text-amber-600'}`}>
                                {h.source === 'native' ? '📡' : '🌐'}
                              </span>
                            </td>
                            <td className="py-2 pr-4 font-mono">
                              {isCurrent ? '—' : formatDistance(dm ?? NaN)}
                            </td>
                            <td className="py-2 pr-4">
                              <Badge variant="secondary" className="text-[11px]">
                                {accuracyLabel(h.accuracy)}
                              </Badge>
                            </td>
                            <td className="py-2">
                              {isCurrent ? (
                                <Badge variant="outline" className="text-[10px] text-emerald-600 border-emerald-600">Current</Badge>
                              ) : (
                                <Badge variant="secondary" className="text-[10px]">History</Badge>
                              )}
                            </td>
                          </tr>
                        );
                      })}
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
