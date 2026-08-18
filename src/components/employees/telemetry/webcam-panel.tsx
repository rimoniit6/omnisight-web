'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Play, Square, Video, Loader2, WifiOff, ShieldAlert, Ban, Timer } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { isHeartbeatFresh } from '@/lib/presence';
import { REQUEST_TIMEOUT_MS, webcamRequestExpired } from '@/lib/webcam-request';

/**
 * Webcam — explicit operator-controlled camera access (Employee Details).
 *
 * Privacy contract enforced in the UI:
 *   - NO auto-start: the camera never opens on page load or mount.
 *   - Frames are only fetched while a server-registered ACTIVE session exists
 *     (the agent only opens the camera after an allowlisted webcam.start
 *     command + consent + config, all re-verified server-side).
 *   - Frames are rendered in-memory only; nothing is recorded or persisted.
 *   - Stop issues webcam.stop immediately and releases the stream.
 *
 * States: OFFLINE / NO CONSENT / DISABLED / REQUESTING / CONNECTING / LIVE /
 * STOPPING / STOPPED / ERROR — derived from the server status + mutations.
 */

type Phase = 'idle' | 'requesting' | 'stopping' | 'error';

interface WebcamStatus {
  consentGranted: boolean;
  configEnabled: boolean;
  devices: Array<{ id: string; name: string; status: string; lastHeartbeat: string | null }>;
  activeSession: { sessionId: string; startedAt: string; startedBy: string; lastFrameAt: string | null } | null;
  recentSessions: Array<{ sessionId: string; startedAt: string; endedAt: string | null; endedReason: string | null; startedBy: string }>;
}

const STATUS_POLL_MS = 3000;
const FRAME_POLL_MS = 1000;

export function WebcamPanel({ employeeId }: { employeeId: string }) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const frameTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeSessionId = useRef<string | null>(null);
  const stopPendingRef = useRef(false);
  const requestDeadlineRef = useRef<number | null>(null);

  const { data, isLoading, isError, refetch } = useQuery<WebcamStatus>({
    queryKey: ['employee-webcam-status', employeeId],
    queryFn: async () => {
      const res = await fetch(`/api/employees/${employeeId}/webcam`);
      if (!res.ok) throw new Error(`http ${res.status}`);
      return res.json();
    },
    enabled: !!employeeId,
    // 3s poll while a session may be active OR while a start request is in
    // flight (otherwise the panel would stay REQUESTING forever — the agent
    // opens the camera after the 10s command poll, but nothing refetched the
    // status once Start was clicked). React Query dedupes concurrent polls.
    refetchInterval: (query) =>
      query.state.data?.activeSession || phase === 'requesting' ? STATUS_POLL_MS : false,
  });

  // A device counts as "online" only when its heartbeat is fresh — Device.status
  // is a sticky lifecycle field that never reverts to 'offline' at runtime.
  const onlineDevice = data?.devices.find((d) => isHeartbeatFresh(d.lastHeartbeat ? new Date(d.lastHeartbeat) : null)) ?? null;

  const stopFramePoll = useCallback(() => {
    if (frameTimer.current) {
      clearInterval(frameTimer.current);
      frameTimer.current = null;
    }
    setFrameUrl(null);
  }, []);

  const startFramePoll = useCallback((sessionId: string) => {
    stopFramePoll();
    // One immediate fetch + a 1s poll while the session is active. The relay
    // keeps only the latest frame in memory (60s TTL) — nothing is stored.
    const tick = () => {
      // Cache-bust so the browser re-requests the JPEG every tick.
      setFrameUrl(`/api/agent/webcam/frame?sessionId=${encodeURIComponent(sessionId)}&t=${Date.now()}`);
    };
    tick();
    frameTimer.current = setInterval(tick, FRAME_POLL_MS);
  }, [stopFramePoll]);

  // Live whenever the server has a registered session, except while a stop is
  // in flight or the panel is in an error state. User-intent phases
  // (requesting/stopping) never gate the server truth.
  const isLive = !!data?.activeSession && phase !== 'stopping' && phase !== 'error';

  // Follow the server session state: when an active session exists (e.g. the
  // agent opened the camera from a command issued elsewhere), adopt it and
  // stream frames. State-touching relay calls are deferred to a microtask —
  // never synchronously in the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    const active = data?.activeSession;
    if (active) {
      // A session appeared — the start request succeeded.
      requestDeadlineRef.current = null;
    }
    if (!active) {
      stopPendingRef.current = false;
      activeSessionId.current = null;
      queueMicrotask(() => stopFramePoll());
      return;
    }
    activeSessionId.current = active.sessionId;
    // A stop is in flight — never resume the relay until the server confirms
    // the session has ended.
    if (stopPendingRef.current || phase === 'error') return;
    queueMicrotask(() => startFramePoll(active.sessionId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.activeSession?.sessionId, phase, stopFramePoll, startFramePoll]);

  // REQUEST timeout watchdog: if Start was clicked and the agent never opened
  // the camera within REQUEST_TIMEOUT_MS, surface an explicit error instead of
  // staying on REQUESTING forever. Cleared once a session appears or on stop.
  useEffect(() => {
    if (phase !== 'requesting' || !requestDeadlineRef.current) return;
    const remaining = requestDeadlineRef.current - Date.now();
    const expired = webcamRequestExpired(requestDeadlineRef.current, !!data?.activeSession);
    if (remaining <= 0 || expired) {
      requestDeadlineRef.current = null;
      setPhase('error');
      setError('The agent did not open the camera in time (command expired or the agent went offline).');
      return;
    }
    const t = setTimeout(() => {
      if (webcamRequestExpired(requestDeadlineRef.current ?? 0, !!data?.activeSession)) {
        requestDeadlineRef.current = null;
        setPhase('error');
        setError('The agent did not open the camera in time (command expired or the agent went offline).');
      }
    }, remaining);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, data?.activeSession]);

  // Cleanup on unmount — always release the stream (never the camera; the
  // camera is only released by a stop command / server-side guards).
  useEffect(() => stopFramePoll, [stopFramePoll]);

  const postCommand = useCallback(async (commandType: 'webcam.start' | 'webcam.stop', deviceId: string) => {
    const res = await fetch('/api/device-commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, commandType, expiresInSeconds: 120 }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `http ${res.status}`);
    }
    return res.json();
  }, []);

  const handleStart = async () => {
    setError(null);
    if (!data) return;
    if (!data.consentGranted) {
      setPhase('error');
      setError('Webcam access consent is not granted for this employee.');
      return;
    }
    if (data.configEnabled !== true) {
      setPhase('error');
      setError('Webcam monitoring is disabled for this organization.');
      return;
    }
    if (!onlineDevice) {
      setPhase('error');
      setError('No online agent device for this employee. The agent must be running and connected.');
      return;
    }
    if (data.activeSession) {
      // Already live server-side — adopt the session instead of double-starting.
      stopPendingRef.current = false;
      startFramePoll(data.activeSession.sessionId);
      return;
    }
    setPhase('requesting');
    stopPendingRef.current = false;
    try {
      await postCommand('webcam.start', onlineDevice.id);
      toast.success('Webcam start command sent — waiting for the agent…');
      // The status poll (below) picks up the session and the derived isLive
      // flips on. REQUEST_TIMEOUT_MS bounds the wait: if the agent never opens
      // the camera (offline mid-flight / camera error / command expired), the
      // panel surfaces an explicit error instead of spinning forever.
      requestDeadlineRef.current = Date.now() + REQUEST_TIMEOUT_MS;
    } catch (err) {
      requestDeadlineRef.current = null;
      setPhase('error');
      setError((err as Error).message || 'Failed to send webcam start command');
      toast.error('Failed to send webcam start command');
    }
  };

  const handleStop = async () => {
    setError(null);
    setPhase('stopping');
    stopPendingRef.current = true;
    stopFramePoll();
    try {
      const active = data?.activeSession;
      if (active) {
        // The agent is streaming — issue the stop command for the right device.
        const deviceId = onlineDevice?.id ?? data?.devices[0]?.id;
        if (deviceId) await postCommand('webcam.stop', deviceId);
      } else if (onlineDevice) {
        // Session may have just ended; still send stop for a clean release.
        await postCommand('webcam.stop', onlineDevice.id);
      }
      setPhase('idle');
      toast.success('Webcam stop command sent');
      queryClient.invalidateQueries({ queryKey: ['employee-webcam-status'] });
    } catch (err) {
      setPhase('error');
      setError((err as Error).message || 'Failed to send webcam stop command');
      toast.error('Failed to send webcam stop command');
    }
  };

  // ── Derived UI state ─────────────────────────────────────────────────────
  let stateBadge: { label: string; tone: 'green' | 'red' | 'amber' | 'gray' | 'violet' } = { label: 'STOPPED', tone: 'gray' };
  if (isError) stateBadge = { label: 'ERROR', tone: 'red' };
  else if (isLive) stateBadge = { label: 'LIVE', tone: 'green' };
  else if (phase === 'requesting') stateBadge = { label: 'REQUESTING', tone: 'amber' };
  else if (phase === 'stopping') stateBadge = { label: 'STOPPING', tone: 'amber' };
  else if (phase === 'error') stateBadge = { label: 'ERROR', tone: 'red' };
  else if (!data) stateBadge = { label: 'STOPPED', tone: 'gray' };
  else if (data.consentGranted !== true) stateBadge = { label: 'NO CONSENT', tone: 'red' };
  else if (data.configEnabled !== true) stateBadge = { label: 'DISABLED', tone: 'amber' };
  else if (!onlineDevice) stateBadge = { label: 'OFFLINE', tone: 'gray' };

  const toneClass: Record<string, string> = {
    green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
    gray: 'bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400',
    violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300',
  };

  return (
    <div className="space-y-4">
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Video className="w-4 h-4 text-rose-500" /> On-Demand Webcam
              </CardTitle>
              <CardDescription className="text-xs">
                Explicit operator control. The camera opens only after you press Start and the agent confirms consent + configuration.
              </CardDescription>
            </div>
            <Badge className={toneClass[stateBadge.tone] || toneClass.gray} variant="secondary">
              {isLive ? <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse mr-1.5 inline-block" /> : null}
              {stateBadge.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Consent / config / device guards — read-only state, no guessing */}
          <div className="flex flex-wrap gap-2 text-xs">
            {data && (
              <>
                <Badge variant="outline" className={data.consentGranted ? 'text-emerald-600 border-emerald-500/40' : 'text-red-500 border-red-500/40'}>
                  {data.consentGranted ? 'Consent granted' : 'No webcam consent'}
                </Badge>
                <Badge variant="outline" className={data.configEnabled ? 'text-emerald-600 border-emerald-500/40' : 'text-amber-600 border-amber-500/40'}>
                  {data.configEnabled ? 'Webcam enabled' : 'Webcam disabled in org settings'}
                </Badge>
                {onlineDevice ? (
                  <Badge variant="outline" className="text-emerald-600 border-emerald-500/40">
                    <WifiOff className="w-3 h-3 mr-1 hidden" />
                    Agent online — {onlineDevice.name}
                  </Badge>
                ) : data.devices.length > 0 ? (
                  <Badge variant="outline" className="text-gray-500">
                    Agent offline
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-gray-500">No agent device bound</Badge>
                )}
              </>
            )}
          </div>

          {/* Live viewer — only while a server-registered session is active */}
          {isLive && frameUrl ? (
            <div className="rounded-xl overflow-hidden border bg-black/5 dark:bg-black/30">
              <div className="flex items-center justify-between px-3 py-2 bg-black/70 text-white text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" /> LIVE
                </span>
                <span className="font-mono">
                  {data?.activeSession?.startedAt ? `since ${format(new Date(data.activeSession.startedAt), 'HH:mm:ss')}` : ''}
                </span>
              </div>
              <img
                src={frameUrl}
                alt="Live webcam frame"
                className="w-full max-h-96 object-contain"
                onError={() => setError('Lost connection to the frame stream')}
              />
            </div>
          ) : isLive ? (
            <div className="h-56 rounded-xl border flex items-center justify-center text-sm text-muted-foreground bg-muted/30">
              Waiting for the first frame…
            </div>
          ) : (
            <div className="h-40 rounded-xl border border-dashed flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground bg-muted/10">
              {phase === 'requesting' ? (
                <>
                  <Loader2 className="w-6 h-6 animate-spin text-amber-500" />
                  <span>Waiting for the agent to open the camera…</span>
                </>
              ) : phase === 'stopping' ? (
                <>
                  <Loader2 className="w-6 h-6 animate-spin text-amber-500" />
                  <span>Releasing the camera…</span>
                </>
              ) : (
                <>
                  <CameraOff className="w-7 h-7 text-muted-foreground/50" />
                  <span>Camera is off — press Start Webcam to begin an explicit session</span>
                </>
              )}
            </div>
          )}

          {error ? (
            <p className="text-xs text-destructive flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5" /> {error}
            </p>
          ) : null}

          {/* Controls — never enabled while requesting/stopping */}
          <div className="flex items-center gap-3">
            {isLive || phase === 'requesting' ? (
              <Button variant="destructive" size="sm" onClick={handleStop}>
                <Square className="w-4 h-4 mr-2" /> Stop Webcam
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleStart}
                disabled={
                  isLoading ||
                  !data ||
                  data.consentGranted !== true ||
                  data.configEnabled !== true ||
                  !onlineDevice
                }
              >
                <Play className="w-4 h-4 mr-2" /> Start Webcam
              </Button>
            )}
            <button
              onClick={() => refetch()}
              className="text-xs px-3 py-1.5 rounded-md border text-muted-foreground hover:bg-muted/50 transition-colors"
              type="button"
            >
              Refresh status
            </button>
          </div>

          {!data && isLoading ? <Skeleton className="h-24" /> : null}

          {data && data.consentGranted !== true ? (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Ban className="w-3.5 h-3.5" /> Webcam access revoked or not consented — the agent will refuse to open the camera.
            </p>
          ) : null}
          {data && data.configEnabled !== true && data.consentGranted ? (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Timer className="w-3.5 h-3.5" /> Webcam monitoring is disabled in organization settings.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* Recent sessions — audit context (metadata only, never frames) */}
      {data && data.recentSessions.length > 0 ? (
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Camera className="w-4 h-4 text-muted-foreground" /> Recent Sessions
            </CardTitle>
            <CardDescription className="text-xs">Session metadata and end reasons — no video is ever stored</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.recentSessions.map((s) => (
                <div key={s.sessionId} className="flex items-center justify-between text-xs py-2 border-b border-muted/40 last:border-0">
                  <div>
                    <p className="font-medium">
                      {format(new Date(s.startedAt), 'MMM d, HH:mm')}
                      {s.endedAt ? ` — ${format(new Date(s.endedAt), 'HH:mm')}` : ''}
                    </p>
                    <p className="text-muted-foreground mt-0.5">
                      started by {s.startedBy === 'admin' ? 'an administrator' : s.startedBy}
                    </p>
                  </div>
                  <Badge variant="secondary" className="text-[10px]">
                    {s.endedReason || 'unknown end'}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
