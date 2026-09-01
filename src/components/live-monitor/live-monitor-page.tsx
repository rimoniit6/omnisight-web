'use client';

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useWebSocket, type LiveEventType, type LiveEventLog } from '@/components/providers/websocket-provider';
import { isSoundWorthy, SOUND_THROTTLE_MS, SOUNDS, readSoundPreference, writeSoundPreference } from '@/lib/sound-alert';
import { PresenceDot } from '@/components/ui/presence-dot';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { Skeleton } from '@/components/ui/skeleton';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { isHeartbeatFresh } from '@/lib/presence';
import { motion, AnimatePresence } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import {
  Monitor,
  Activity,
  Bell,
  Pause,
  Camera,
  UserPlus,
  Wifi,
  WifiOff,
  Radio,
  Trash2,
  Zap,
  Volume2,
  VolumeX,
  Usb,
  Filter,
  Server,
  Laptop,
  Clock,
  PauseCircle,
  PlayCircle,
  AlertTriangle,
} from 'lucide-react';

// ─── Constants ───
const ALL_EVENT_TYPES: { type: LiveEventType; label: string; icon: React.ElementType; color: string; bgColor: string }[] = [
  { type: 'device-status', label: 'Device', icon: Monitor, color: 'text-sky-600 dark:text-sky-400', bgColor: 'bg-sky-100 dark:bg-sky-900/30' },
  { type: 'activity-ping', label: 'Activity', icon: Activity, color: 'text-emerald-600 dark:text-emerald-400', bgColor: 'bg-emerald-100 dark:bg-emerald-900/30' },
  { type: 'notification', label: 'Alert', icon: Bell, color: 'text-amber-600 dark:text-amber-400', bgColor: 'bg-amber-100 dark:bg-amber-900/30' },
  { type: 'break-status', label: 'Break', icon: Pause, color: 'text-orange-600 dark:text-orange-400', bgColor: 'bg-orange-100 dark:bg-orange-900/30' },
  { type: 'screenshot', label: 'Screenshot', icon: Camera, color: 'text-violet-600 dark:text-violet-400', bgColor: 'bg-violet-100 dark:bg-violet-900/30' },
  { type: 'usb-event', label: 'USB', icon: Usb, color: 'text-rose-600 dark:text-rose-400', bgColor: 'bg-rose-100 dark:bg-rose-900/30' },
  { type: 'device-claim', label: 'Claim', icon: Laptop, color: 'text-indigo-600 dark:text-indigo-400', bgColor: 'bg-indigo-100 dark:bg-indigo-900/30' },
  { type: 'alert-event', label: 'Alert Event', icon: AlertTriangle, color: 'text-red-600 dark:text-red-400', bgColor: 'bg-red-100 dark:bg-red-900/30' },
  { type: 'project-time-update', label: 'Project Time', icon: Clock, color: 'text-blue-600 dark:text-blue-400', bgColor: 'bg-blue-100 dark:bg-blue-900/30' },
];

const priorityBorderMap: Record<string, string> = {
  low: 'border-l-slate-300 dark:border-l-slate-600',
  medium: 'border-l-amber-400 dark:border-l-amber-600',
  high: 'border-l-rose-400 dark:border-l-rose-600',
  critical: 'border-l-red-500 dark:border-l-red-400',
};

// ─── Sound Alert (LM-SOUND) ───
// A single shared HTMLAudioElement (lazy-created on the client only). Reusing
// one element avoids re-fetch/decode churn, prevents overlapping chimes, and —
// because the element is first touched inside the "Sound" button's click
// handler — keeps the browser's autoplay gate satisfied for the programmatic
// plays that follow. No autoplay bypass is used.
//
// Pure utility functions live in src/lib/sound-alert.ts for testability.
let alertAudio: HTMLAudioElement | null = null;

function getAlertAudio(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null;
  if (!alertAudio) {
    alertAudio = new Audio(SOUNDS.notification);
    alertAudio.preload = 'auto';
  }
  return alertAudio;
}

async function playAlertSound(priority?: string): Promise<boolean> {
  const audio = getAlertAudio();
  if (!audio) return false;
  try {
    // 0 < volume <= 1; critical is louder, everything else stays modest.
    audio.volume = priority === 'critical' ? 0.8 : 0.4;
    audio.currentTime = 0; // restart from the beginning (never overlaps)
    await audio.play();
    return true;
  } catch (error) {
    // Playback can legitimately fail (page never interacted with, audio
    // unavailable). Stay graceful in production; log a useful diagnostic in
    // development only so normal operation never spams the console.
    if (process.env.NODE_ENV === 'development') {
      console.warn('[LiveMonitor] Failed to play alert sound', error);
    }
    return false;
  }
}

/** Warm the audio element inside the "Sound" toggle's click gesture: decode
 *  the asset and prove playback is permitted, then emit a brief, low-volume
 *  confirmation blip. This is the explicit user opt-in — not an autoplay
 *  bypass.
 *
 *  Returns true when the browser accepted the unlock, false when it did not
 *  (autoplay policy still blocks, audio asset missing, etc.). */
function warmUpAlertAudio(): boolean {
  const audio = getAlertAudio();
  if (!audio) return false;
  try {
    audio.volume = 0.3;
    audio.currentTime = 0;
    // Fire-and-forget: the Promise resolves once the browser begins audio
    // output.  A short blip (120 ms) followed by pause proves the gate is
    // unlocked.  Errors mean autoplay is still blocked — we surface this to
    // the caller so the UI can show feedback.
    void audio.play()
      .then(() => {
        setTimeout(() => {
          audio.pause();
          audio.currentTime = 0;
        }, 120);
      })
      .catch(() => {
        // Autoplay unavailable — caller will see the false return.
      });
    // Optimistic: if we got here without throwing synchronously the audio
    // element exists and the user gesture is fresh.  The real gate is the
    // async play() above, but returning true here lets the UI immediately
    // show the "enabled" state while the confirmation blip plays.
    return true;
  } catch {
    // audio not supported
    return false;
  }
}

// ─── Event Type Config ───
function getEventConfig(type: LiveEventType) {
  return ALL_EVENT_TYPES.find(t => t.type === type) || ALL_EVENT_TYPES[1];
}

// ─── Stats Cards ───
function ConnectionStatusCard({ isConnected, reconnectCount, serverInfo, latency }: {
  isConnected: boolean;
  reconnectCount: number;
  serverInfo: { deviceCount: number; employeeCount: number } | null;
  /** Real round-trip latency in ms, or null when unavailable (LM-3). */
  latency: number | null;
}) {
  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Server className="w-4 h-4 text-primary" />
          Connection
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Status</span>
            {isConnected ? (
              <Badge className="bg-emerald-100 text-emerald-700 text-[10px] h-5 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800">
                <Wifi className="h-3 w-3 mr-1" />
                Connected
              </Badge>
            ) : (
              <Badge className="bg-rose-100 text-rose-700 text-[10px] h-5 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-800">
                <WifiOff className="h-3 w-3 mr-1" />
                Disconnected
              </Badge>
            )}
          </div>
          {reconnectCount > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Reconnect</span>
              <Badge variant="outline" className="text-[10px] h-5 border-amber-300 text-amber-600">
                Attempt #{reconnectCount}
              </Badge>
            </div>
          )}
          {serverInfo && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Devices</span>
                <span className="text-xs font-semibold">{serverInfo.deviceCount}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Employees</span>
                <span className="text-xs font-semibold">{serverInfo.employeeCount}</span>
              </div>
            </>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Latency</span>
            <span className="text-xs font-semibold text-emerald-600">
              {isConnected && latency !== null ? `${latency}ms` : '—'}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Event Stats (LM-P2-2: DB-backed) ────────────────────────────────────
// Counts are authoritative server-side aggregations from
// GET /api/live-monitor/event-stats (org-scoped, time-windowed). The client
// NEVER derives statistics from the 80-event WebSocket log.
const EVENT_STAT_RANGES = [
  { value: 'today', label: 'Today' },
  { value: '24h', label: '24H' },
  { value: '7d', label: '7D' },
] as const;

type EventStatRange = (typeof EVENT_STAT_RANGES)[number]['value'];

interface EventStatsPayload {
  counts: {
    devices: number;
    activity: number;
    notifications: number;
    break: number;
    screenshot: number;
    usb: number;
    deviceClaim: number;
    projectTime: number;
    alert: number;
    total: number;
  };
}

const EVENT_TYPE_TO_STAT: Record<LiveEventType, keyof EventStatsPayload['counts']> = {
  'device-status': 'devices',
  'activity-ping': 'activity',
  notification: 'notifications',
  'break-status': 'break',
  'break-started': 'break',
  'break-ended': 'break',
  screenshot: 'screenshot',
  'usb-event': 'usb',
  'device-claim': 'deviceClaim',
  'project-time-update': 'projectTime',
  'alert-event': 'alert',
  'location-update': 'deviceClaim',
};

const RANGE_LABELS: Record<EventStatRange, string> = {
  today: 'today',
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
};

function EventCountCards({ activeFilters }: {
  activeFilters: Set<LiveEventType>;
}) {
  const [range, setRange] = useState<EventStatRange>('today');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['event-stats', range],
    queryFn: async () => {
      const res = await fetch(`/api/live-monitor/event-stats?range=${range}`);
      if (!res.ok) throw new Error(`event-stats ${res.status}`);
      const json = await res.json();
      return json.data as EventStatsPayload;
    },
    refetchInterval: 15000,
  });

  const counts = data?.counts;

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <BarChart3Icon className="w-4 h-4 text-primary" />
            Event Stats
          </CardTitle>
          <div className="flex items-center gap-0.5">
            {EVENT_STAT_RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setRange(r.value)}
                className={cn(
                  'px-1.5 py-0.5 rounded text-[9px] font-medium border transition-all',
                  range === r.value
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-primary/20'
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          {isError
            ? 'Statistics unavailable'
            : isLoading
              ? 'Loading statistics…'
              : `Database window: ${RANGE_LABELS[range]} · Total ${counts?.total ?? 0}`}
        </p>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {isError ? (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <p className="text-xs">Could not load event statistics.</p>
            <button onClick={() => refetch()} className="text-[10px] text-primary underline mt-1">
              Retry
            </button>
          </div>
        ) : isLoading || !counts ? (
          <div className="grid grid-cols-2 gap-2">
            {ALL_EVENT_TYPES.map(({ type, bgColor, color, icon: Icon, label }) => (
              <div key={type} className={cn('flex items-center gap-2 p-2 rounded-lg border border-border', activeFilters.has(type) ? 'opacity-100' : 'opacity-60')}>
                <div className={cn('h-6 w-6 rounded flex items-center justify-center shrink-0', bgColor)}>
                  <Icon className={cn('h-3 w-3', color)} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] text-muted-foreground truncate">{label}</p>
                  <Skeleton className="h-3 w-6" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {ALL_EVENT_TYPES.map(({ type, label, icon: Icon, color, bgColor }) => (
              <div
                key={type}
                className={cn(
                  'flex items-center gap-2 p-2 rounded-lg border transition-all cursor-pointer',
                  activeFilters.has(type)
                    ? 'border-primary/30 bg-primary/5'
                    : 'border-border opacity-60 hover:opacity-100'
                )}
                title={`Click to ${activeFilters.has(type) ? 'hide' : 'show'} ${label}`}
              >
                <div className={cn('h-6 w-6 rounded flex items-center justify-center shrink-0', bgColor)}>
                  <Icon className={cn('h-3 w-3', color)} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] text-muted-foreground truncate">{label}</p>
                  <p className="text-xs font-bold">{counts[EVENT_TYPE_TO_STAT[type]] ?? 0}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Simple bar chart icon replacement
function BarChart3Icon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </svg>
  );
}

// ─── Event List Item ───
function EventItem({ event, index }: { event: LiveEventLog; index: number }) {
  const config = getEventConfig(event.type);
  const Icon = config.icon;
  const pStyle = priorityBorderMap[event.priority || 'low'] || priorityBorderMap.low;

  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.2 } }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.02, 0.3) }}
      className={cn(
        'flex items-start gap-3 px-3 py-2.5 rounded-lg border-l-[3px] bg-card hover:bg-muted/40 transition-colors group',
        pStyle
      )}
    >
      <div className={cn('h-7 w-7 rounded-md flex items-center justify-center shrink-0 mt-0.5', config.bgColor)}>
        <Icon className={cn('h-3.5 w-3.5', config.color)} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium text-foreground truncate">{event.title}</p>
          {event.priority && event.priority !== 'low' && (
            <span className={cn(
              'text-[9px] px-1 py-0.5 rounded font-medium shrink-0',
              event.priority === 'medium' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
              event.priority === 'high' && 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
              event.priority === 'critical' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
            )}>
              {event.priority.toUpperCase()}
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground truncate mt-0.5">{event.description}</p>
      </div>
      <div className="flex flex-col items-end gap-1 shrink-0">
        <Badge variant="secondary" className="text-[9px] h-4 px-1.5 font-normal">
          {config.label}
        </Badge>
        <span className="text-[10px] text-muted-foreground/60">
          {formatDistanceToNow(new Date(event.timestamp), { addSuffix: true })}
        </span>
      </div>
    </motion.div>
  );
}

// ─── Device Grid ───
function DeviceGrid() {
  const { data, isLoading } = useQuery({
    queryKey: ['devices', 'live-monitor'],
    // GET /api/devices returns { data: Device[] } — data IS the array. The old
    // `json.data?.devices` parse (copied from a paginated-wrapper assumption)
    // always resolved to [] and rendered an empty grid. Matches devices-page.
    queryFn: async () => {
      const res = await fetch('/api/devices?pageSize=50');
      const json = await res.json();
      return json.data || [];
    },
    refetchInterval: 30000,
  });

  const devices = data || [];

  if (isLoading) {
    return (
      <Card className="border shadow-sm">
        <CardHeader className="pb-2 pt-4 px-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Monitor className="w-4 h-4 text-primary" />
            Device Status Grid
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-16 rounded-lg" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Live presence — heartbeat freshness (centralized), not the sticky column.
  const deviceLiveStatus = (d: { status: string; lastHeartbeat?: string | null }) => {
    if (['maintenance', 'inactive', 'retired'].includes(d.status)) return d.status;
    return isHeartbeatFresh(d.lastHeartbeat ? new Date(d.lastHeartbeat) : null) ? 'online' : 'offline';
  };
  const onlineCount = devices.filter((d: { status: string; lastHeartbeat?: string | null }) => deviceLiveStatus(d) === 'online').length;
  const offlineCount = devices.filter((d: { status: string; lastHeartbeat?: string | null }) => deviceLiveStatus(d) === 'offline').length;

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2 pt-4 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Monitor className="w-4 h-4 text-primary" />
            Device Grid
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge className="bg-emerald-100 text-emerald-700 text-[9px] h-4 px-1.5 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400">
              {onlineCount} Online
            </Badge>
            <Badge className="bg-rose-100 text-rose-700 text-[9px] h-4 px-1.5 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400">
              {offlineCount} Offline
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2">
          {devices.map((device: { id: string; name: string; status: string; lastHeartbeat?: string | null; employee?: { id: string; firstName: string; lastName: string } | null }) => {
            const isOnline = deviceLiveStatus(device) === 'online';
            return (
              <motion.div
                key={device.id}
                layout
                className={cn(
                  'flex items-center gap-2 p-2.5 rounded-lg border transition-all',
                  isOnline
                    ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-800/50 dark:bg-emerald-900/10'
                    : 'border-rose-200 bg-rose-50/50 dark:border-rose-800/50 dark:bg-rose-900/10'
                )}
              >
                <span className={cn(
                  'relative flex h-2.5 w-2.5 shrink-0',
                  isOnline && 'animate-pulse'
                )}>
                  <span className={cn(
                    'absolute inline-flex h-full w-full rounded-full',
                    isOnline ? 'bg-emerald-400 opacity-75' : 'bg-rose-400 opacity-75'
                  )} />
                  <span className={cn(
                    'relative inline-flex rounded-full h-2.5 w-2.5',
                    isOnline ? 'bg-emerald-500' : 'bg-rose-500'
                  )} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium truncate">{device.name}</p>
                  <p className="flex items-center gap-1 text-[9px] text-muted-foreground truncate">
                    {device.employee ? (
                      <>
                        <PresenceDot employeeId={device.employee.id} className="h-1.5 w-1.5" />
                        <span className="truncate">{device.employee.firstName} {device.employee.lastName}</span>
                      </>
                    ) : 'Unassigned'}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
        {devices.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Monitor className="h-8 w-8 mb-2 opacity-30" />
            <p className="text-xs">No devices found</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Main Live Monitor Page ───
export function LiveMonitorPage() {
  const {
    isConnected,
    reconnectCount,
    serverInfo,
    latency,
    eventLog,
    clearEventLog,
  } = useWebSocket();

  const [activeFilters, setActiveFilters] = useState<Set<LiveEventType>>(new Set(ALL_EVENT_TYPES.map(t => t.type)));
  const [soundEnabled, setSoundEnabled] = useState(readSoundPreference);
  const [audioReady, setAudioReady] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [pausedSnapshot, setPausedSnapshot] = useState<LiveEventLog[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sound cursor: id of the newest event already considered for sound, plus
  // the wall-clock time of the last non-critical sound (throttle).
  const lastSoundedEventRef = useRef<string | null>(null);
  const lastSoundTimeRef = useRef(0);

  // Persist sound preference to localStorage
  useEffect(() => {
    writeSoundPreference(soundEnabled);
  }, [soundEnabled]);

  // When sound is enabled, attempt audio unlock.  If the user has previously
  // enabled sound (persisted preference), try to unlock automatically — the
  // first user gesture on the page will have already satisfied the browser's
  // autoplay gate.  If the unlock fails, set audioReady=false so the UI can
  // show the user they need to click.
  useEffect(() => {
    const ready = soundEnabled ? warmUpAlertAudio() : false;
    setAudioReady(ready);
  }, [soundEnabled]);

  // Filter events
  const filteredEvents = useMemo(() => {
    return eventLog.filter(e => activeFilters.has(e.type));
  }, [eventLog, activeFilters]);

  // Use paused snapshot when paused, live data when not
  const displayedEvents = isPaused && pausedSnapshot ? pausedSnapshot : filteredEvents;

  // Save snapshot when pausing
  const handlePauseToggle = useCallback(() => {
    if (!isPaused) {
      // About to pause - save current snapshot
      setPausedSnapshot(filteredEvents);
    }
    setIsPaused(prev => !prev);
  }, [isPaused, filteredEvents]);

  // Sound toggle: the explicit user opt-in. Enabling warms the audio element
  // inside this click gesture (decode + autoplay unlock + confirmation blip);
  // disabling stops any in-flight chime immediately.
  const handleToggleSound = useCallback(() => {
    const next = !soundEnabled;
    setSoundEnabled(next);
    if (next) {
      const unlocked = warmUpAlertAudio();
      setAudioReady(unlocked);
    } else {
      setAudioReady(false);
      const audio = getAlertAudio();
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    }
  }, [soundEnabled]);

  // Auto-scroll to top on new events
  useEffect(() => {
    if (scrollRef.current && !isPaused) {
      scrollRef.current.scrollTop = 0;
    }
  }, [displayedEvents.length, isPaused]);

  // Baseline the sound cursor at the newest event present on mount — the
  // stream history that already exists when the page loads must never sound.
  useEffect(() => {
    lastSoundedEventRef.current = eventLog[0]?.id ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sound alerts: fire for genuinely NEW events entering the Live Event Stream
  // (eventLog[0] is the newest). Each event is considered exactly once (per
  // event id), gated on the toggle, filtered by isSoundWorthy, and throttled
  // for non-critical events. No sound on mount, no repeats for the same event,
  // no heartbeat spam, and toggling OFF stops in-flight chimes via the button.
  useEffect(() => {
    const newest = eventLog[0];
    if (!newest) return;
    if (newest.id === lastSoundedEventRef.current) return; // already considered
    lastSoundedEventRef.current = newest.id;
    if (!soundEnabled) return;
    if (!isSoundWorthy(newest)) return;
    const now = Date.now();
    if (newest.priority !== 'critical' && now - lastSoundTimeRef.current < SOUND_THROTTLE_MS) return;
    lastSoundTimeRef.current = now;
    playAlertSound(newest.priority);
  }, [eventLog, soundEnabled]);

  const toggleFilter = useCallback((type: LiveEventType) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const allSelected = activeFilters.size === ALL_EVENT_TYPES.length;

  return (
    <div className="space-y-6" role="region" aria-label="Live Monitor">
      {/* ─── Header Bar ─── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <Radio className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-foreground">Live Monitor</h2>
            <p className="text-xs text-muted-foreground">Real-time workforce activity stream</p>
          </div>
          <div className="ml-2">
            {isConnected ? (
              <Badge className="bg-emerald-100 text-emerald-700 text-[10px] h-5 px-1.5 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 gap-1">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                LIVE
              </Badge>
            ) : (
              <Badge className="bg-rose-100 text-rose-700 text-[10px] h-5 px-1.5 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400">
                <WifiOff className="h-3 w-3 mr-1" />
                OFFLINE
              </Badge>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Sound toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={soundEnabled ? 'default' : 'outline'}
                size="sm"
                className={cn('h-8 gap-1.5 text-xs', soundEnabled && !audioReady && 'border-amber-300 text-amber-600 dark:border-amber-700 dark:text-amber-400')}
                onClick={handleToggleSound}
              >
                {soundEnabled ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                {soundEnabled ? (audioReady ? 'Sound' : 'Sound…') : 'Enable Sound'}
              </Button>
            </TooltipTrigger>
            <TooltipContent><p className="text-xs">{soundEnabled ? (audioReady ? 'Sound alerts active' : 'Click to enable audio') : 'Enable sound alerts for live events'}</p></TooltipContent>
          </Tooltip>

          {/* Pause toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={isPaused ? 'default' : 'outline'}
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={handlePauseToggle}
              >
                {isPaused ? <PlayCircle className="h-3.5 w-3.5" /> : <PauseCircle className="h-3.5 w-3.5" />}
                {isPaused ? 'Resume' : 'Pause'}
              </Button>
            </TooltipTrigger>
            <TooltipContent><p className="text-xs">{isPaused ? 'Resume live updates' : 'Pause live updates'}</p></TooltipContent>
          </Tooltip>

          {/* Clear */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={clearEventLog}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </Button>
            </TooltipTrigger>
            <TooltipContent><p className="text-xs">Clear all events</p></TooltipContent>
          </Tooltip>

          {/* Select All / None */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={() => {
                  if (allSelected) {
                    setActiveFilters(new Set());
                  } else {
                    setActiveFilters(new Set(ALL_EVENT_TYPES.map(t => t.type)));
                  }
                }}
              >
                <Filter className="h-3.5 w-3.5" />
                {allSelected ? 'None' : 'All'}
              </Button>
            </TooltipTrigger>
            <TooltipContent><p className="text-xs">{allSelected ? 'Deselect all types' : 'Select all types'}</p></TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* ─── Event Type Filter Chips ─── */}
      <div className="flex items-center gap-2 flex-wrap">
        {ALL_EVENT_TYPES.map(({ type, label, icon: Icon, color, bgColor }) => {
          const isActive = activeFilters.has(type);
          return (
            <button
              key={type}
              onClick={() => toggleFilter(type)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-xs font-medium transition-all',
                isActive
                  ? 'border-primary/30 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary/20 hover:text-foreground'
              )}
            >
              <div className={cn('h-4 w-4 rounded flex items-center justify-center', isActive ? bgColor : 'bg-muted')}>
                <Icon className={cn('h-2.5 w-2.5', isActive ? color : 'text-muted-foreground')} />
              </div>
              {label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
          <Zap className="h-3 w-3 text-emerald-500" />
          <span>{displayedEvents.length} events</span>
          {isPaused && (
            <Badge variant="outline" className="ml-1 text-[9px] h-4 px-1 border-amber-300 text-amber-600">
              PAUSED
            </Badge>
          )}
        </div>
      </div>

      {/* ─── Main Content Grid ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Left: Event Stream (3 cols) */}
        <div className="lg:col-span-3">
          <Card className="border shadow-sm overflow-hidden">
            <CardHeader className="pb-2 pt-4 px-4 border-b">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Activity className="w-4 h-4 text-primary" />
                  Live Event Stream
                </CardTitle>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  Updated {displayedEvents.length > 0 ? formatDistanceToNow(new Date(displayedEvents[0].timestamp), { addSuffix: true }) : '—'}
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div ref={scrollRef} className="max-h-[520px] overflow-y-auto">
                <div className="p-2 space-y-1">
                  {displayedEvents.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                      <div className="relative mb-4">
                        <Radio className="h-12 w-12 opacity-20" />
                        {isConnected && (
                          <span className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-emerald-500 animate-ping" />
                        )}
                      </div>
                      <p className="text-sm font-medium">Waiting for live events...</p>
                      <p className="text-xs opacity-60 mt-1">Events appear here in real-time as they occur</p>
                    </div>
                  ) : (
                    <AnimatePresence mode="popLayout">
                      {displayedEvents.map((event, i) => (
                        <EventItem key={event.id} event={event} index={i} />
                      ))}
                    </AnimatePresence>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right: Sidebar (1 col) */}
        <div className="space-y-6">
          <ConnectionStatusCard
            isConnected={isConnected}
            reconnectCount={reconnectCount}
            serverInfo={serverInfo}
            latency={latency}
          />
          <EventCountCards activeFilters={activeFilters} />
        </div>
      </div>

      {/* ─── Device Status Grid (below) ─── */}
      <DeviceGrid />
    </div>
  );
}
