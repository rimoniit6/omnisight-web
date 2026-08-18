'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/components/providers/websocket-provider';
import { employeePresenceInvalidation } from '@/lib/ws-invalidation';

// Global employee live presence.
//
// Server-authoritative: the snapshot API (GET /api/employees/presence) and the
// realtime `employee-presence` events are BOTH derived from Device.lastHeartbeat
// freshness server-side (see src/lib/presence.ts). This provider only merges
// the two sources and never fabricates a state:
//   - snapshot drives the initial page state (correct on first paint)
//   - WebSocket events drive live transitions (online → offline etc.)
//   - reconnect re-fetches the snapshot and reconciles
//   - stale events (older lastSeenAt) can never overwrite newer state

export interface EmployeePresenceState {
  online: boolean;
  lastSeenAt: string | null;
}

export interface EmployeePresenceEvent {
  employeeId: string;
  employeeName: string;
  online: boolean;
  lastSeenAt: string;
  organizationId: string;
  timestamp: string;
}

interface PresenceContextValue {
  byEmployeeId: Record<string, EmployeePresenceState>;
  /** True only while the first snapshot has not yet arrived. */
  loading: boolean;
  /** True when the last snapshot fetch failed (realtime events may still flow). */
  error: boolean;
  refresh: () => void;
}

const PresenceContext = createContext<PresenceContextValue | null>(null);

export const EMPLOYEE_PRESENCE_QUERY_KEY = ['employee-presence'];

async function fetchPresenceSnapshot(): Promise<Record<string, EmployeePresenceState>> {
  const res = await fetch('/api/employees/presence', {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`presence snapshot failed: ${res.status}`);
  const data = (await res.json()) as { employees?: Record<string, EmployeePresenceState> };
  return data.employees ?? {};
}

/** Merge two snapshots keeping the NEWER lastSeenAt per employee (stale-safe). */
function mergePresence(
  base: Record<string, EmployeePresenceState>,
  incoming: Record<string, EmployeePresenceState>
): Record<string, EmployeePresenceState> {
  const merged = { ...base };
  for (const [id, state] of Object.entries(incoming)) {
    const cur = merged[id];
    const incomingMs = state.lastSeenAt ? new Date(state.lastSeenAt).getTime() : 0;
    const curMs = cur?.lastSeenAt ? new Date(cur.lastSeenAt).getTime() : 0;
    if (!cur || incomingMs >= curMs) {
      merged[id] = state;
    }
  }
  return merged;
}

export function PresenceProvider({ children }: { children: ReactNode }) {
  const { socket } = useWebSocket();
  const queryClient = useQueryClient();
  const [byEmployeeId, setByEmployeeId] = useState<Record<string, EmployeePresenceState>>({});

  const { isLoading, isError, refetch } = useQuery({
    queryKey: EMPLOYEE_PRESENCE_QUERY_KEY,
    queryFn: fetchPresenceSnapshot,
    staleTime: 30_000,
    refetchInterval: 60_000, // safety net — realtime events are the fast path
    refetchOnWindowFocus: true,
  });

  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  // Snapshot arrives → merge (stale-safe: never overwrite a newer WS update).
  useEffect(() => {
    queryClient
      .fetchQuery({ queryKey: EMPLOYEE_PRESENCE_QUERY_KEY, queryFn: fetchPresenceSnapshot })
      .then((snap) => setByEmployeeId((prev) => mergePresence(prev, snap)))
      .catch(() => {
        // Query error state is surfaced via isError; keep last known state.
      });
    // Intentionally runs once on mount (queryClient.fetchQuery is cached).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyEvent = useCallback((event: EmployeePresenceEvent) => {
    setByEmployeeId((prev) => {
      const cur = prev[event.employeeId];
      const eventMs = event.lastSeenAt ? new Date(event.lastSeenAt).getTime() : 0;
      const curMs = cur?.lastSeenAt ? new Date(cur.lastSeenAt).getTime() : 0;
      // Out-of-order protection: an event with an older heartbeat must not
      // regress newer state (e.g. a delayed offline event after a reconnect).
      if (cur && eventMs < curMs) return prev;
      return {
        ...prev,
        [event.employeeId]: {
          online: event.online,
          lastSeenAt: event.lastSeenAt || cur?.lastSeenAt || null,
        },
      };
    });
    // Targeted freshness: a presence transition only affects this employee's
    // open details page — invalidate that exact prefix (no global refetch).
    for (const key of employeePresenceInvalidation(event.employeeId)) {
      queryClient.invalidateQueries({ queryKey: key });
    }
  }, [queryClient]);

  // Realtime transitions via the single existing socket transport.
  useEffect(() => {
    if (!socket) return;
    const onReconnect = () => {
      // Converge after network loss: the snapshot is authoritative.
      void refetchRef.current();
    };
    socket.on('employee-presence', applyEvent);
    socket.on('connect', onReconnect);
    socket.on('reconnect', onReconnect);
    return () => {
      socket.off('employee-presence', applyEvent);
      socket.off('connect', onReconnect);
      socket.off('reconnect', onReconnect);
    };
  }, [socket, applyEvent]);

  const value = useMemo<PresenceContextValue>(
    () => ({
      byEmployeeId,
      loading: isLoading,
      error: isError,
      refresh: () => void refetchRef.current(),
    }),
    [byEmployeeId, isLoading, isError]
  );

  return <PresenceContext.Provider value={value}>{children}</PresenceContext.Provider>;
}

export function usePresenceContext() {
  const ctx = useContext(PresenceContext);
  if (!ctx) throw new Error('usePresenceContext must be used within PresenceProvider');
  return ctx;
}

/**
 * Presence for a single employee.
 *
 * Returns:
 *   online: true | false | null — null means "unknown yet" (snapshot loading
 *           or failed), which callers MUST NOT render as green.
 *   lastSeenAt: newest observed heartbeat (ISO) or null.
 *   loading: true only before the first snapshot resolves.
 */
export function usePresence(employeeId: string | null | undefined): {
  online: boolean | null;
  lastSeenAt: string | null;
  loading: boolean;
} {
  const { byEmployeeId, loading } = usePresenceContext();
  if (!employeeId) return { online: null, lastSeenAt: null, loading: false };
  const state = byEmployeeId[employeeId];
  return {
    online: state ? state.online : null,
    lastSeenAt: state?.lastSeenAt ?? null,
    loading: loading && state === undefined,
  };
}
