'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import { io, Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/store';
import {
  appPolicyInvalidation,
  policyViolationInvalidation,
  usbEventInvalidation,
  deviceStatusInvalidation,
  activityPingInvalidation,
  projectTimeUpdateInvalidation,
  deviceClaimInvalidation,
  anomalyInvalidation,
  alertEventInvalidation,
  locationUpdateInvalidation,
} from '@/lib/ws-invalidation';

// ─── Event Types ───
export interface DeviceStatusEvent {
  deviceId: string;
  deviceName: string;
  oldStatus: string;
  newStatus: string;
  employeeId: string;
  employeeName: string | null;
  timestamp: string;
}

export interface ActivityPingEvent {
  id: string;
  employeeId: string;
  employeeName: string;
  department: string;
  activityType: string;
  activityTitle: string;
  /** Normalized bare domain for website events (never a raw URL); null otherwise. */
  activityUrl?: string | null;
  category: string;
  duration: number;
  timestamp: string;
}

export interface NotificationEvent {
  id: string;
  title: string;
  message: string;
  type: string;
  priority: string;
  timestamp: string;
}

export interface AlertEvent {
  id: string;
  title: string;
  type: string;
  severity: string;
  status: string;
  timestamp: string;
}

export interface BreakStatusEvent {
  employeeId: string;
  employeeName: string;
  action: 'started' | 'ended';
  timestamp: string;
}

export interface ScreenshotEvent {
  id: string;
  employeeId: string;
  employeeName: string;
  appWindow: string;
  timestamp: string;
}

export interface DeviceClaimEvent {
  id: string;
  deviceId: string;
  deviceName: string;
  hostname: string | null;
  employeeName: string | null;
  status: string;
  timestamp: string;
}



export interface ConnectedEvent {
  serverTime: string;
  deviceCount: number;
  employeeCount: number;
  message: string;
}

export interface UsbEventEvent {
  id: string;
  employeeId: string;
  employeeName: string;
  eventType: string;
  deviceName: string;
  blocked: boolean;
  timestamp: string;
}

export interface ProjectTimeUpdateEvent {
  id: string;
  projectId: string;
  projectName: string;
  employeeId: string;
  hours: number;
  timestamp: string;
}

export interface AnomalyEvent {
  id: string;
  organizationId: string;
  employeeId: string | null;
  deviceId: string | null;
  type: string;
  severity: string;
  status: string;
  title: string;
  timestamp: string;
}

export interface AppPolicyEvent {
  id: string;
  appName: string;
  listType: string;
  isActive: boolean;
  timestamp: string;
}

export interface PolicyViolationEvent {
  id: string;
  organizationId: string;
  employeeId: string | null;
  deviceId: string | null;
  executableName: string;
  severity: string;
  timestamp: string;
}

export type LiveEventType = 'device-status' | 'activity-ping' | 'notification' | 'break-status' | 'break-started' | 'break-ended' | 'screenshot' | 'usb-event' | 'project-time-update' | 'device-claim' | 'alert-event'  | 'location-update';

export interface LiveEventLog {
  id: string;
  type: LiveEventType;
  title: string;
  description: string;
  timestamp: string;
  priority?: string;
}

// ─── Context State ───
interface WebSocketState {
  isConnected: boolean;
  reconnectCount: number;
  serverInfo: ConnectedEvent | null;
  /** Real round-trip latency in ms, or null while unknown/unavailable (LM-3). */
  latency: number | null;
  eventLog: LiveEventLog[];
  lastDeviceUpdate: DeviceStatusEvent | null;
  lastActivity: ActivityPingEvent | null;
  lastNotification: NotificationEvent | null;
  lastBreakStatus: BreakStatusEvent | null;
  lastScreenshot: ScreenshotEvent | null;
  lastDeviceClaim: DeviceClaimEvent | null;
  lastUsbEvent: UsbEventEvent | null;
  lastAlertEvent: AlertEvent | null;
  lastProjectTimeUpdate: ProjectTimeUpdateEvent | null;
  clearEventLog: () => void;
  /** The live socket instance (null while disconnected) — lets other providers
   *  subscribe to realtime events without creating a second transport. */
  socket: Socket | null;
}

const WebSocketContext = createContext<WebSocketState | null>(null);

const EVENT_LOG_MAX = 80;

// Deterministic, monotonically increasing client-side event ids (LM-SOUND):
// `${timestamp}-${seq}` is collision-free per session without Math.random().
let eventLogSeq = 0;

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const token = useAuthStore((s) => s.token);
  const socketRef = useRef<Socket | null>(null);
  const [socketInstance, setSocketInstance] = useState<Socket | null>(null);

  // Realtime endpoint candidates, tried in order:
  //   1. NEXT_PUBLIC_LIVE_UPDATES_URL — explicit (dev/self-hosted direct).
  //   2. '/?XTransformPort=3010' — the Caddy production transform path.
  //   3. http://<app-host>:3010 — bare `next dev` / self-hosted WITHOUT Caddy:
  //      the transform path 404s on the app server, so fall back to the
  //      mini-service's direct port on the same host. This is what makes
  //      realtime (activity-ping / employee-presence / device-status) work
  //      when the admin app is started without the env var.
  const [socketUrlIndex, setSocketUrlIndex] = useState(0);
  const socketCandidates = useMemo<string[]>(() => {
    const urls: string[] = [];
    const explicit = process.env.NEXT_PUBLIC_LIVE_UPDATES_URL;
    if (explicit) urls.push(explicit);
    urls.push('/?XTransformPort=3010');
    if (typeof window !== 'undefined') {
      urls.push(`http://${window.location.hostname}:3010`);
    }
    return urls;
  }, []);
  const socketUrl = socketCandidates[Math.min(socketUrlIndex, socketCandidates.length - 1)];
  const [isConnected, setIsConnected] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);
  const [serverInfo, setServerInfo] = useState<ConnectedEvent | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const latencyTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [lastDeviceUpdate, setLastDeviceUpdate] = useState<DeviceStatusEvent | null>(null);
  const [lastActivity, setLastActivity] = useState<ActivityPingEvent | null>(null);
  const [lastNotification, setLastNotification] = useState<NotificationEvent | null>(null);
  const [lastBreakStatus, setLastBreakStatus] = useState<BreakStatusEvent | null>(null);
  const [lastScreenshot, setLastScreenshot] = useState<ScreenshotEvent | null>(null);
  const [lastDeviceClaim, setLastDeviceClaim] = useState<DeviceClaimEvent | null>(null);
  const [lastUsbEvent, setLastUsbEvent] = useState<UsbEventEvent | null>(null);
  const [lastAlertEvent, setLastAlertEvent] = useState<AlertEvent | null>(null);
  const [lastProjectTimeUpdate, setLastProjectTimeUpdate] = useState<ProjectTimeUpdateEvent | null>(null);
  const [eventLog, setEventLog] = useState<LiveEventLog[]>([]);

  const addEventLog = useCallback((event: Omit<LiveEventLog, 'id'>) => {
    const logEntry: LiveEventLog = { ...event, id: `${Date.now()}-${eventLogSeq++}` };
    setEventLog(prev => [logEntry, ...prev].slice(0, EVENT_LOG_MAX));
  }, []);

  const clearEventLog = useCallback(() => setEventLog([]), []);

  useEffect(() => {
    // Never connect while signed out; reconnects on (re)auth. The JWT is
    // passed through the handshake `auth` field — the server also accepts the
    // httpOnly session cookie, so reload sessions work before a token exists.
    if (!isAuthenticated) return;
    if (socketRef.current?.connected) return;

    const socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionAttempts: 20,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
      timeout: 10000,
      auth: { token: token ?? undefined },
    });

    socket.on('connect', () => {
      setIsConnected(true);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('connect_error', (err) => {
      // Invalid/expired credentials: the server disconnects us. Stop retrying
      // instead of hammering an unauthorized endpoint.
      const message = (err as Error & { message?: string }).message;
      if (message === 'unauthorized' || message === 'no-organization') {
        socket.disconnect();
        socketRef.current = null;
        setIsConnected(false);
        return;
      }
      // Other errors (service down, network, wrong path): try the next
      // candidate endpoint ONCE, then let reconnection handle the rest. This
      // covers bare `next dev` / self-hosted setups where the Caddy transform
      // path does not exist on the app server.
      setSocketUrlIndex((prev) => {
        if (prev < socketCandidates.length - 1) return prev + 1;
        return prev;
      });
    });

    socket.on('reconnect_attempt', (attempt) => {
      setReconnectCount(attempt);
    });

    socket.on('reconnect', () => {
      setReconnectCount(0);
    });

    socket.on('connected', (data: ConnectedEvent) => {
      setServerInfo(data);
    });

    // ─── Latency probe (LM-3) ───
    // Real round-trip measurement: ping with a client timestamp, measure the
    // echo back. Unknown/unavailable stays null — the UI renders '—', never
    // a fabricated number.
    socket.on('latency-pong', (data: { t?: number }) => {
      if (typeof data?.t === 'number') {
        setLatency(Math.max(0, Date.now() - data.t));
      }
    });
    const startLatencyProbe = () => {
      if (latencyTimerRef.current) return;
      const ping = () => {
        if (socket.connected) socket.emit('latency-ping', { t: Date.now() });
      };
      ping();
      latencyTimerRef.current = setInterval(ping, 5000);
    };
    socket.on('connect', startLatencyProbe);

    // ─── Device Status ───
    socket.on('device-status', (event: DeviceStatusEvent) => {
      setLastDeviceUpdate(event);
      addEventLog({
        type: 'device-status',
        title: event.newStatus === 'online' ? 'Device Online' : 'Device Offline',
        description: `${event.deviceName}${event.employeeName ? ` (${event.employeeName})` : ''}`,
        timestamp: event.timestamp,
        priority: event.newStatus === 'online' ? 'low' : 'high',
      });
      // Centralized mapping (src/lib/ws-invalidation.ts): the affected
      // employee's details query is targeted; global aggregates refreshed.
      for (const key of deviceStatusInvalidation(event.employeeId)) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    });

    // ─── Activity Ping ───
    socket.on('activity-ping', (event: ActivityPingEvent) => {
      setLastActivity(event);
      // Website events surface the normalized domain (server-persisted) as the
      // primary label; the sanitized page title remains available via
      // activityTitle and in the Activities timeline. A raw URL can never
      // appear here — the server only broadcasts domain-only payloads.
      const isWebsite = event.activityType === 'website';
      const title = isWebsite && event.activityUrl ? event.activityUrl : event.activityTitle;
      addEventLog({
        type: 'activity-ping',
        title,
        description: `${event.employeeName} — ${event.department}`,
        timestamp: event.timestamp,
        priority: event.category === 'unproductive' ? 'medium' : 'low',
      });
      for (const key of activityPingInvalidation(event.employeeId)) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    });

    // ─── Notification ───
    socket.on('notification', (event: NotificationEvent) => {
      setLastNotification(event);
      addEventLog({
        type: 'notification',
        title: event.title,
        description: event.message,
        timestamp: event.timestamp,
        priority: event.priority,
      });
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      queryClient.invalidateQueries({ queryKey: ['notification-count'] });
      queryClient.invalidateQueries({ queryKey: ['notifications-dropdown'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['event-stats'] });
    });

    // ─── Break Status ───
    // Listens to the legacy `break-status` event AND the dedicated
    // `break-started` / `break-ended` events (identical payload shape).
    const handleBreakStatus = (event: BreakStatusEvent) => {
      setLastBreakStatus(event);
      addEventLog({
        type: 'break-status',
        title: event.action === 'started' ? 'Break Started' : 'Break Ended',
        description: event.employeeName,
        timestamp: event.timestamp,
        priority: 'low',
      });
      queryClient.invalidateQueries({ queryKey: ['break-status'] });
      queryClient.invalidateQueries({ queryKey: ['break-summary'] });
      queryClient.invalidateQueries({ queryKey: ['break-history'] });
      queryClient.invalidateQueries({ queryKey: ['event-stats'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    };
    socket.on('break-status', handleBreakStatus);
    socket.on('break-started', handleBreakStatus);
    socket.on('break-ended', handleBreakStatus);

    // ─── Screenshot ───
    socket.on('new-screenshot', (event: ScreenshotEvent) => {
      setLastScreenshot(event);
      addEventLog({
        type: 'screenshot',
        title: 'Screenshot Captured',
        description: `${event.employeeName} — ${event.appWindow}`,
        timestamp: event.timestamp,
      });
      queryClient.invalidateQueries({ queryKey: ['screenshots'] });
      queryClient.invalidateQueries({ queryKey: ['screenshot-stats'] });
      queryClient.invalidateQueries({ queryKey: ['event-stats'] });
    });

    // ─── Agent Registration (legacy path: creation + approve/reject) ───
    // ─── Device Claim (device claim path: creation + lifecycle transitions) ───
    socket.on('device-claim', (event: DeviceClaimEvent) => {
      setLastDeviceClaim(event);
      const titles: Record<string, string> = {
        approved: 'Device Approved',
        rejected: 'Device Rejected',
        revoked: 'Device Revoked',
        cancelled: 'Device Claim Cancelled',
        expired: 'Device Claim Expired',
      };
      addEventLog({
        type: 'device-claim',
        title: titles[event.status] ?? 'New Device Claim',
        description: event.deviceName,
        timestamp: event.timestamp,
        priority: event.status === 'pending' ? 'medium' : 'low',
      });
      // Centralized mapping (src/lib/ws-invalidation.ts): the approvals list
      // (prefix-matched 'device-claims'), the sidebar pending badge and the
      // global aggregates are refreshed.
      for (const key of deviceClaimInvalidation()) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    });

    // ─── Location Update (new GPS fix arrived) ───
    // The event carries NO coordinates (privacy); the client refetches the
    // employee's location API to get the actual data.
    socket.on('location-update', (event: { id: string; employeeId: string; timestamp: string }) => {
      for (const key of locationUpdateInvalidation(event.employeeId)) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    });

    // ─── Anomaly (new anomaly detected/reported) ───
    // Refreshes the Anomalies page (any list/filter/pagination variant, via
    // the 'anomalies' prefix) and dashboard aggregates without polling. The
    // event carries no sensitive telemetry — only attribution + type/severity.
    socket.on('anomaly', (_event: AnomalyEvent) => {
      for (const key of anomalyInvalidation()) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    });

    // ─── USB Event ───
    socket.on('usb-event', (event: UsbEventEvent) => {
      setLastUsbEvent(event);
      addEventLog({
        type: 'usb-event',
        title: event.blocked ? 'USB Blocked' : `USB ${event.eventType === 'usb_insert' ? 'Inserted' : 'Removed'}`,
        description: `${event.employeeName} — ${event.deviceName || 'Unknown Device'}`,
        timestamp: event.timestamp,
        priority: event.blocked ? 'high' : 'medium',
      });
      for (const key of usbEventInvalidation()) {
        queryClient.invalidateQueries({ queryKey: key });
      }
      queryClient.invalidateQueries({ queryKey: ['event-stats'] });
    });

    // ─── Alert Event (N-10) ───
    socket.on('alert-event', (event: AlertEvent) => {
      setLastAlertEvent(event);
      addEventLog({
        type: 'alert-event',
        title: `Alert: ${event.title}`,
        description: `Severity ${event.severity} (${event.status})`,
        timestamp: event.timestamp,
        priority: event.severity === 'critical' ? 'critical' : event.severity === 'error' ? 'high' : 'medium',
      });
      for (const key of alertEventInvalidation()) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    });

    // ─── App Policy (whitelist/blacklist entry created or removed) ───
    // Second-admin sessions refresh their Policies page app list in real time.
    socket.on('app-policy', (_event: AppPolicyEvent) => {
      for (const key of appPolicyInvalidation()) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    });

    // ─── Policy Violation (agent blocked a process against a blacklist) ───
    socket.on('policy-violation', (_event: PolicyViolationEvent) => {
      for (const key of policyViolationInvalidation()) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    });

    // ─── Project Time Update (automatic activity-derived project time) ───
    socket.on('project-time-update', (event: ProjectTimeUpdateEvent) => {
      setLastProjectTimeUpdate(event);
      addEventLog({
        type: 'project-time-update',
        title: 'Project Time Updated',
        description: `${event.projectName} — ${event.hours}h automatically tracked`,
        timestamp: event.timestamp,
        priority: 'low',
      });
      // Refresh exactly the affected project's queries (prefix-matched) plus
      // the affected employee's project list — never the whole app.
      for (const key of projectTimeUpdateInvalidation(event.projectId, event.employeeId)) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    });

    socketRef.current = socket;
    setSocketInstance(socket);

    return () => {
      if (latencyTimerRef.current) {
        clearInterval(latencyTimerRef.current);
        latencyTimerRef.current = null;
      }
      setLatency(null);
      socket.disconnect();
      socketRef.current = null;
      setSocketInstance(null);
      setIsConnected(false);
    };
  }, [queryClient, addEventLog, isAuthenticated, token, socketUrl, socketCandidates.length]);

  return (
    <WebSocketContext.Provider
      value={{
        isConnected,
        reconnectCount,
        serverInfo,
        latency,
        eventLog,
        lastDeviceUpdate,
        lastActivity,
        lastNotification,
        lastBreakStatus,
        lastScreenshot,
        lastDeviceClaim,
        lastUsbEvent,
        lastAlertEvent,
        lastProjectTimeUpdate,
        clearEventLog,
        socket: socketInstance,
      }}
    >
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  const ctx = useContext(WebSocketContext);
  if (!ctx) throw new Error('useWebSocket must be used within WebSocketProvider');
  return ctx;
}

// Legacy compatibility hook - redirects to singleton context
export function useLiveUpdates() {
  return useWebSocket();
}
