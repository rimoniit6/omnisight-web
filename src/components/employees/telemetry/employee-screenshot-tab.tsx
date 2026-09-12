'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useCallback } from 'react';
import { formatDistanceToNow, format } from 'date-fns';
import { Camera, Clock, Monitor, AlertTriangle, WifiOff, RefreshCw, ExternalLink, Eye, Crosshair, CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { isHeartbeatFresh } from '@/lib/presence';
import { toast } from 'sonner';

/**
 * Employee Screenshot Tab — displays captured screenshots for a single employee
 * with an on-demand "Take Screenshot" button.
 *
 * Reuses the existing /api/screenshots endpoint with employeeId filter.
 * RBAC is enforced server-side (org-scoped employee lookup).
 */

interface ScreenshotItem {
  id: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  width: number | null;
  height: number | null;
  appWindow: string | null;
  ocrText: string | null;
  aiAnalysis: string | null;
  flagged: boolean;
  capturedAt: string;
  processingStatus?: string | null;
  thumbnailPath?: string | null;
}

interface ScreenshotListResponse {
  data: ScreenshotItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface DeviceInfo {
  id: string;
  name: string;
  status: string;
  lastHeartbeat: string | null;
}

interface DeviceListResponse {
  devices: DeviceInfo[];
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function freshnessLabel(capturedAt: string): { label: string; color: string } {
  const diffMs = Date.now() - new Date(capturedAt).getTime();
  const diffMin = diffMs / (1000 * 60);
  if (diffMin < 5) return { label: 'Just now', color: 'text-emerald-600' };
  if (diffMin < 30) return { label: 'Recent', color: 'text-blue-600' };
  if (diffMin < 60) return { label: `${Math.floor(diffMin)}m ago`, color: 'text-amber-600' };
  const diffHours = diffMin / 60;
  if (diffHours < 24) return { label: `${Math.floor(diffHours)}h ago`, color: 'text-orange-600' };
  const diffDays = diffHours / 24;
  return { label: `${Math.floor(diffDays)}d ago`, color: 'text-red-600' };
}

function ScreenshotCard({ screenshot, onClick }: { screenshot: ScreenshotItem; onClick: () => void }) {
  const freshness = freshnessLabel(screenshot.capturedAt);
  const thumbnailUrl = screenshot.thumbnailPath
    ? `/api/screenshots/${screenshot.id}/thumbnail`
    : `/api/screenshots/${screenshot.id}/image`;

  return (
    <Card
      className="border-0 shadow-sm cursor-pointer hover:shadow-md transition-shadow overflow-hidden"
      onClick={onClick}
    >
      <div className="aspect-video bg-muted/30 relative overflow-hidden">
        <img
          src={thumbnailUrl}
          alt={`Screenshot — ${screenshot.appWindow || 'Unknown'}`}
          className="w-full h-full object-cover"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
        {screenshot.flagged && (
          <Badge variant="destructive" className="absolute top-2 right-2 text-[10px]">
            Flagged
          </Badge>
        )}
        {screenshot.processingStatus === 'processing' && (
          <Badge variant="secondary" className="absolute top-2 left-2 text-[10px]">
            Processing
          </Badge>
        )}
      </div>
      <CardContent className="p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium truncate">{screenshot.appWindow || 'Unknown Application'}</p>
          <Badge variant="outline" className={`text-[10px] shrink-0 ${freshness.color} border-current`}>
            {freshness.label}
          </Badge>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          {format(new Date(screenshot.capturedAt), 'MMM d, HH:mm')} · {formatFileSize(screenshot.fileSize)}
        </p>
      </CardContent>
    </Card>
  );
}

export function EmployeeScreenshotTab({ employeeId }: { employeeId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery<ScreenshotListResponse>({
    queryKey: ['employee-screenshots', employeeId, page],
    queryFn: async () => {
      const params = new URLSearchParams({
        employeeId,
        page: String(page),
        pageSize: '24',
      });
      const res = await fetch(`/api/screenshots?${params}`);
      if (!res.ok) throw new Error(`http ${res.status}`);
      return res.json();
    },
    enabled: !!employeeId,
  });

  // Fetch employee devices to determine online status for capture button
  const { data: deviceData } = useQuery<DeviceListResponse>({
    queryKey: ['employee-devices', employeeId],
    queryFn: async () => {
      const res = await fetch(`/api/employees/${employeeId}/devices`);
      if (!res.ok) throw new Error(`http ${res.status}`);
      return res.json();
    },
    enabled: !!employeeId,
    staleTime: 30_000,
  });

  const onlineDevice = deviceData?.devices?.find(
    (d) => isHeartbeatFresh(d.lastHeartbeat ? new Date(d.lastHeartbeat) : null)
  ) ?? null;

  // Capture command mutation
  const captureMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      const res = await fetch('/api/device-commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId,
          commandType: 'screenshot.capture',
          expiresInSeconds: 60,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `http ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Screenshot capture command sent — the agent will capture shortly.');
      // Refresh the screenshot list after a delay to allow the agent to capture + upload
      setTimeout(() => {
        refetch();
        queryClient.invalidateQueries({ queryKey: ['employee-screenshots', employeeId] });
      }, 8_000);
    },
    onError: (err) => {
      toast.error(`Failed to send capture command: ${(err as Error).message}`);
    },
  });

  const handleCapture = useCallback(async () => {
    if (!onlineDevice) {
      toast.error('No online agent device found. The agent must be running and connected.');
      return;
    }
    captureMutation.mutate(onlineDevice.id);
  }, [onlineDevice, captureMutation]);

  const screenshots = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;
  const total = data?.total ?? 0;

  const selectedScreenshot = screenshots.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Screenshots captured from this employee&apos;s agent — organized by capture time.
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCapture}
            disabled={!onlineDevice || captureMutation.isPending}
            className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
            type="button"
          >
            {captureMutation.isPending ? (
              <>
                <Crosshair className="w-3.5 h-3.5 animate-spin" />
                Capturing…
              </>
            ) : (
              <>
                <Camera className="w-3.5 h-3.5" />
                Take Screenshot
              </>
            )}
          </button>
          <button
            onClick={() => refetch()}
            className="text-xs px-3 py-1.5 rounded-md border text-muted-foreground hover:bg-muted/50 transition-colors flex items-center gap-1.5"
            type="button"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {captureMutation.isSuccess && (
        <Card className="border-emerald-200 bg-emerald-50">
          <CardContent className="py-3 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <p className="text-xs text-emerald-700">
              Capture command sent. The screenshot will appear here shortly once the agent processes it.
            </p>
          </CardContent>
        </Card>
      )}

      {captureMutation.isError && (
        <Card className="border-destructive/20 bg-destructive/5">
          <CardContent className="py-3 flex items-center gap-2">
            <XCircle className="w-4 h-4 text-destructive" />
            <p className="text-xs text-destructive">
              Capture failed: {(captureMutation.error as Error)?.message || 'Unknown error'}. Please try again.
            </p>
          </CardContent>
        </Card>
      )}

      {!onlineDevice && deviceData && deviceData.devices.length > 0 && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="py-3 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <p className="text-xs text-amber-700">
              No online agent device found. The agent must be running and connected to capture screenshots.
            </p>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-video" />
          ))}
        </div>
      ) : isError ? (
        <Card>
          <CardContent className="py-10 text-center">
            <WifiOff className="w-8 h-8 text-destructive/40 mx-auto mb-2" />
            <p className="text-sm text-destructive font-medium">Failed to load screenshots</p>
            <p className="text-xs text-muted-foreground mt-1">The request could not be completed. Refresh to retry.</p>
          </CardContent>
        </Card>
      ) : screenshots.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <Camera className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No screenshots captured yet.</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Click &quot;Take Screenshot&quot; above or wait for the agent to capture them automatically.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex items-center gap-2 mb-2">
            <Badge variant="secondary" className="text-xs">
              {total} screenshot{total !== 1 ? 's' : ''}
            </Badge>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {screenshots.map((screenshot) => (
              <ScreenshotCard
                key={screenshot.id}
                screenshot={screenshot}
                onClick={() => setSelectedId(screenshot.id)}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-xs text-muted-foreground">
                Page {page} of {totalPages}
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
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  className="text-xs px-3 py-1.5 rounded-md border text-muted-foreground hover:bg-muted/50 disabled:opacity-40 transition-colors"
                  type="button"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Screenshot Detail Dialog */}
      <Dialog open={!!selectedId} onOpenChange={(open) => { if (!open) setSelectedId(null); }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden p-0">
          {selectedScreenshot && (
            <div className="flex flex-col">
              <div className="bg-muted/30 flex items-center justify-center min-h-[300px] max-h-[60vh] overflow-hidden">
                <img
                  src={`/api/screenshots/${selectedScreenshot.id}/image`}
                  alt={`Screenshot — ${selectedScreenshot.appWindow || 'Unknown'}`}
                  className="max-w-full max-h-[60vh] object-contain"
                />
              </div>
              <div className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{selectedScreenshot.appWindow || 'Unknown Application'}</p>
                    <p className="text-xs text-muted-foreground">
                      {format(new Date(selectedScreenshot.capturedAt), 'MMM d, yyyy HH:mm:ss')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {selectedScreenshot.width && selectedScreenshot.height && (
                      <Badge variant="secondary" className="text-[10px]">
                        {selectedScreenshot.width}×{selectedScreenshot.height}
                      </Badge>
                    )}
                    <Badge variant="secondary" className="text-[10px]">
                      {formatFileSize(selectedScreenshot.fileSize)}
                    </Badge>
                  </div>
                </div>
                {selectedScreenshot.aiAnalysis && (
                  <div className="bg-muted/30 rounded-lg p-3">
                    <p className="text-xs font-medium mb-1">AI Analysis</p>
                    <p className="text-xs text-muted-foreground">{selectedScreenshot.aiAnalysis}</p>
                  </div>
                )}
                <div className="flex justify-end">
                  <a
                    href={`/api/screenshots/${selectedScreenshot.id}/image`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-3 py-1.5 rounded-md border text-muted-foreground hover:bg-muted/50 transition-colors flex items-center gap-1.5"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    Open Full Size
                  </a>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
