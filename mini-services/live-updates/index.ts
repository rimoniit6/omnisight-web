// OmniSight — Live Updates WebSocket Service (secure)
//
// SECURITY MODEL
//  1. Authentication: every connection must present a valid JWT, either via
//     the socket.io `auth.token` handshake field or the `worklens_token`
//     httpOnly session cookie. Invalid/expired tokens are disconnected.
//  2. Organization isolation: each socket joins its own organization room
//     (`org:<organizationId>`). All broadcasts are room-scoped — an employee
//     in Organization A can never receive events from Organization B.
//  3. Real data only: events are produced by polling the database for actual
//     changes (new rows / status changes). No simulated or random events are
//     ever emitted, and the service never writes to the database.
//  4. CORS is restricted to the configured application origin.

import { createServer } from 'http';
import { Server } from 'socket.io';
import { createHmac, timingSafeEqual } from 'crypto';
import { existsSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { derivePresenceEvents, warmPresenceMap, LIFECYCLE_PINNED_STATUSES, EMPLOYEE_ONLINE_THRESHOLD_MS, type PresenceMap, type PresenceEvent } from './presence';
import { buildActivityPing } from './activity-events';
import { nextPollCursor } from './poll-cursor';
import { loadPersistedCursor, persistCursor } from './cursor-store';
import { NOTIFY_CHANNEL, ensureNotifyTriggers } from './notify-triggers';

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = Number(process.env.LIVE_UPDATES_PORT || 3010);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET;
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'worklens_token';

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('[live-updates] JWT_SECRET must be set and at least 16 characters.');
  process.exit(1);
}

// Resolve the SQLite database relative to the project root (the directory
// containing prisma/schema.prisma), so `file:./db/custom.db` in .env works
// regardless of the process working directory.
function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'prisma', 'schema.prisma'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function resolveDbUrl(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (!fromEnv) return `file:${path.join(findProjectRoot(), 'db', 'custom.db')}`;
  if (!fromEnv.startsWith('file:')) {
    // Cap the connection pool: this service only needs a handful of parallel
    // poll queries, and keeping the pool small prevents `bun --hot` reloads
    // from exhausting the Postgres connection limit (each reload of this
    // module creates a new client; orphaned pools linger until GC).
    const sep = fromEnv.includes('?') ? '&' : '?';
    if (!/connection_limit=/i.test(fromEnv)) return `${fromEnv}${sep}connection_limit=5`;
    return fromEnv; // remote datasource
  }
  const filePart = fromEnv.replace(/^file:/, '');
  if (path.isAbsolute(filePart)) return fromEnv;
  return `file:${path.join(findProjectRoot(), filePart.replace(/^\.\//, ''))}`;
}

const db = new PrismaClient({
  datasources: { db: { url: resolveDbUrl() } },
});

// ─── JWT verification (HS256 — mirrors src/lib/auth.ts) ──────────────────────

interface JwtPayload {
  userId: string;
  role: string;
  organizationId?: string;
  sessionId?: string;
  exp?: number;
  iat?: number;
}

function base64urlDecode(str: string): string {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf-8');
}

function verifyJWT(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;

    const expected = createHmac('sha256', JWT_SECRET!)
      .update(`${header}.${body}`)
      .digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return null;
    }

    const headerObj = JSON.parse(base64urlDecode(header)) as { alg?: string };
    if (headerObj.alg && headerObj.alg !== 'HS256') return null;

    const payload = JSON.parse(base64urlDecode(body)) as JwtPayload;
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return null;
    if (payload.iat && payload.iat > now + 60) return null;
    return payload;
  } catch {
    return null;
  }
}

function extractCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// ─── Server ──────────────────────────────────────────────────────────────────

const httpServer = createServer();
const io = new Server(httpServer, {
  path: '/socket.io',
  cors: {
    origin: ALLOWED_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Handshake authentication: auth.token first, then the session cookie.
io.use(async (socket, next) => {
  const authToken = socket.handshake.auth?.token as string | undefined;
  const cookieToken = extractCookie(socket.handshake.headers.cookie, SESSION_COOKIE_NAME);
  const token = authToken || cookieToken;

  if (!token) {
    return next(new Error('unauthorized'));
  }

  const payload = verifyJWT(token);
  if (!payload) {
    return next(new Error('unauthorized'));
  }

  // Server-authoritative session revocation (S-04): the web JWT carries a
  // sessionId that must still map to an ACTIVE UserSession row. A revoked or
  // expired session is disconnected exactly like an invalid token — the same
  // 401 semantics as the HTTP API.
  if (payload.sessionId) {
    try {
      const session = await db.userSession.findUnique({
        where: { id: payload.sessionId },
        select: { revokedAt: true, expiresAt: true },
      });
      if (!session || session.revokedAt !== null || session.expiresAt.getTime() < Date.now()) {
        return next(new Error('unauthorized'));
      }
    } catch {
      // Fail closed: a store error must not let a possibly-revoked session in.
      return next(new Error('unauthorized'));
    }
  }

  // Organization identity comes from the verified token — never from the client.
  if (!payload.organizationId) {
    // Users without an organization must not receive any tenant's data.
    return next(new Error('no-organization'));
  }

  socket.data.userId = payload.userId;
  socket.data.role = payload.role;
  socket.data.organizationId = payload.organizationId;
  next();
});

io.on('connection', async (socket) => {
  const orgId: string = socket.data.organizationId;
  socket.join(`org:${orgId}`);
  console.log(`[live-updates] client connected: ${socket.id} (org ${orgId})`);

  socket.on('disconnect', (reason) => {
    console.log(`[live-updates] client disconnected: ${socket.id} (${reason})`);
  });

  socket.on('error', (err) => {
    console.error(`[live-updates] socket error (${socket.id}):`, err);
  });

  // ─── Connected handshake (LM-2) ───────────────────────────────────────
  // The Admin UI expects a `connected` payload carrying REAL org-scoped
  // device/employee counts right after the authenticated handshake. Counts
  // come from the database for THIS organization only — never fabricated,
  // never cross-org.
  (async () => {
    try {
      const [deviceCount, employeeCount] = await Promise.all([
        db.device.count({ where: { organizationId: orgId } }),
        db.employee.count({ where: { organizationId: orgId } }),
      ]);
      socket.emit('connected', {
        serverTime: new Date().toISOString(),
        deviceCount,
        employeeCount,
        message: 'Connected',
      });
    } catch (err) {
      console.error('[live-updates] connected-handshake error:', err);
    }
  })();

  // ─── Latency probe (LM-3) ─────────────────────────────────────────────
  // The client pings with a client timestamp and we echo it back untouched;
  // the round-trip is measured on the client (never a fabricated value).
  socket.on('latency-ping', (data) => {
    socket.emit('latency-pong', data ?? { t: Date.now() });
  });

  // Org-scoped device summary — counts only for this organization.
  // Live online count = non-lifecycle devices with a heartbeat inside the
  // centralized presence window (a dead agent's sticky 'online' must not
  // count). Mirrors the admin API's effective status semantics.
  socket.on('request-device-summary', async () => {
    try {
      const [total, online] = await Promise.all([
        db.device.count({ where: { organizationId: orgId } }),
        db.device.count({
          where: {
            organizationId: orgId,
            status: { notIn: [...LIFECYCLE_PINNED_STATUSES] },
            lastHeartbeat: { gte: new Date(Date.now() - EMPLOYEE_ONLINE_THRESHOLD_MS) },
          },
        }),
      ]);
      socket.emit('device-summary', {
        total,
        online,
        offline: Math.max(0, total - online),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[live-updates] device-summary error:', err);
    }
  });
});

// ─── Real database-driven event polling ──────────────────────────────────────

// Last known device status per device — only real status changes are emitted.
const deviceStatus = new Map<string, string>();
// Last known claim status per device claim — only real status transitions
// (pending → approved/rejected/cancelled/expired, and back to pending on
// re-registration) are emitted. Deliberately NOT warm at startup (same
// rationale as deviceStatus): the first poll after a restart emits each
// existing claim once, matching the device-status behavior.
const claimStatus = new Map<string, string>();
// Per-employee live presence (derived from heartbeat freshness, NOT Device.status).
const employeePresence: PresenceMap = new Map();
// Department id → name lookup for activity events.
const departmentNames = new Map<string, string>();

// Poll cursor: events strictly after this timestamp are broadcast.
//
// DURABLE CURSOR (P2-5): the cursor is persisted to SystemSetting after every
// successful poll round and restored on startup, so a service restart no
// longer resets the stream to "now" and silently drops the events that were
// committed while the service was down. Semantics are at-least-once:
//   - a crash between broadcasting a round and persisting its cursor replays
//     those events once on restart (clients dedupe by id and reconcile from
//     the API on reconnect — see websocket-provider reconnect invalidation);
//   - a crash before broadcasting never advances the cursor (nothing is lost);
//   - a DB outage in pollOnce skips persistence entirely — the old cursor is
//     retried next round.
// Catch-up note: the per-table `take` limits mean a LONG outage is caught up
// newest-first; middle rows are skipped by the STREAM only — the client
// refetches full state from the API on reconnect/refresh (the DB is the
// source of truth, the socket is a delta layer).
let cursor: Date;

const POLL_INTERVAL_MS = 5000;

async function loadCursor(): Promise<Date> {
  const t = await loadPersistedCursor(db, () => new Date());
  console.log(
    `[live-updates] poll cursor: ${t.toISOString()}${t.getTime() < Date.now() - 60_000 ? ' (resumed after downtime — catching up)' : ''}`
  );
  return t;
}

async function refreshDepartments(): Promise<void> {
  try {
    const depts = await db.department.findMany({ select: { id: true, name: true } });
    departmentNames.clear();
    for (const d of depts) departmentNames.set(d.id, d.name);
  } catch (err) {
    console.error('[live-updates] refreshDepartments error:', err);
  }
}

async function pollOnce(): Promise<void> {
  const since = cursor;
  // `now` is captured BEFORE the queries (never loses a row: anything
  // committed after this instant stays eligible next round). The cursor is
  // NOT advanced here — it is raised AFTER the queries to the newest row this
  // round actually processed (see the advance below). Advancing before the
  // queries let rows committed between the capture and the query execution be
  // broadcast TWICE (same id over the socket → duplicate React keys).
  const now = new Date();

  try {
    const [changedDevices, newActivities, newNotifications, newScreenshots, newUsbEvents, breakActivities, newAutoTimeEntries, newClaims, newAnomalies, changedAppPolicy, newPolicyViolations, newAlerts, newLocations] =
      await Promise.all([
        db.device.findMany({
          where: { updatedAt: { gt: since } },
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, organizationId: true } },
          },
        }),
        db.activity.findMany({
          where: { createdAt: { gt: since }, type: { in: ['application', 'website'] } },
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, departmentId: true, organizationId: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
        db.notification.findMany({
          where: { createdAt: { gt: since } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        db.screenshot.findMany({
          where: { createdAt: { gt: since } },
          include: {
            employee: { select: { firstName: true, lastName: true, organizationId: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
        // UsbEvent has no `employee` relation in the schema — it carries the
        // employeeId/organizationId columns directly, so select them explicitly
        // (the poll previously crashed on the missing relation include).
        db.usbEvent.findMany({
          where: { createdAt: { gt: since } },
          select: {
            id: true,
            eventType: true,
            deviceName: true,
            vendorName: true,
            blocked: true,
            employeeId: true,
            organizationId: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 5,
        }),
        db.activity.findMany({
          where: { createdAt: { gt: since }, title: { contains: 'Break Mode' } },
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, organizationId: true } },
          },
          orderBy: { createdAt: 'desc' },
          // Generous cap so a burst of break toggles within one 5s poll window
          // is never truncated (previously take:5 silently dropped the oldest).
          take: 50,
        }),
        // Automatically-tracked project time (source = ACTIVITY_AUTO, written by
        // the project-time sync engine). Broadcast so Project Tracking refreshes
        // in real time without polling. Polled on `updatedAt` (NOT createdAt):
        // the sync engine ACCUMULATES into one row per employee/project/day, so
        // a row's hours change via updates — those updates must re-broadcast too
        // (Prisma sets updatedAt = createdAt on create, so creation is covered).
        // Manual TimeEntry rows are deliberately NOT broadcast: their own
        // mutations already invalidate the client cache.
        db.timeEntry.findMany({
          where: { source: 'ACTIVITY_AUTO', updatedAt: { gt: since } },
          select: {
            id: true,
            projectId: true,
            employeeId: true,
            hours: true,
            organizationId: true,
            createdAt: true,
            updatedAt: true,
            project: { select: { name: true } },
          },
          orderBy: { updatedAt: 'desc' },
          take: 10,
        }),
        // Device claims — the admin approval queue. Polled on
        // `updatedAt` so claim creation AND lifecycle transitions (approved /
        // rejected / revoked / cancelled / expired, plus re-registration back
        // to pending) reach the org's admins in real time. Emission is
        // transition-only via claimStatus.
        db.deviceClaim.findMany({
          where: { updatedAt: { gt: since } },
          include: {
            device: { select: { id: true, name: true, hostname: true, organizationId: true } },
            employee: { select: { id: true, firstName: true, lastName: true } },
          },
          orderBy: { updatedAt: 'desc' },
          take: 5,
        }),
        // New anomalies (auto-detected by the scheduler/on-demand run or
        // reported by an agent). New rows only (createdAt poll): status
        // changes are already reflected by the anomalies page's own mutation
        // invalidation, so broadcasting them again would be redundant noise.
        db.anomaly.findMany({
          where: { createdAt: { gt: since } },
          select: {
            id: true,
            organizationId: true,
            employeeId: true,
            deviceId: true,
            type: true,
            severity: true,
            status: true,
            title: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        // App whitelist/blacklist policy changes — creation AND soft-delete
        // (isActive) transitions. Polled on `updatedAt` so second-admin
        // sessions see policy edits in real time (Prisma sets updatedAt =
        // createdAt on create, so creation is covered).
        db.appListEntry.findMany({
          where: { updatedAt: { gt: since } },
          select: {
            id: true,
            appName: true,
            listType: true,
            isActive: true,
            organizationId: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: 'desc' },
          take: 10,
        }),
        // N-10: new alerts (createdAt cursor) — org room event so the Alerts
        // page refreshes without a manual reload.
        db.alert.findMany({
          where: { createdAt: { gt: since } },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        // New policy violations (agent enforcement events) — new rows only.
        db.policyViolation.findMany({
          where: { createdAt: { gt: since } },
          select: {
            id: true,
            organizationId: true,
            employeeId: true,
            deviceId: true,
            executableName: true,
            severity: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        // Location events — new GPS fixes from agents. Polled on createdAt
        // (each row is immutable). Emission is org-scoped so only the
        // affected organization's admin receives the update. The client uses
        // the event as a signal to refetch the employee's location API —
        // coordinates are NEVER sent through the WebSocket (privacy).
        db.locationEvent.findMany({
          where: { createdAt: { gt: since } },
          select: {
            id: true,
            employeeId: true,
            organizationId: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);

    // Advance the poll cursor past every EVENT row this round actually
    // processed — a row committed after the pre-query `now` capture but before
    // its query ran satisfies `createdAt > since`, and without this raise it
    // would be re-fetched — and re-broadcast — by the next round (the
    // duplicate activity-ping / live-feed entry bug). Device rows are
    // deliberately excluded: their status/presence broadcasts are already
    // transition-only (in-memory maps), so re-fetching is harmless and
    // leaving them out keeps this change surgical. Claims are likewise
    // transition-only (claimStatus), so their rows contribute their
    // `updatedAt` (the poll filter) for cursor hygiene but can never
    // double-broadcast.
    cursor = nextPollCursor(now, [
      ...newActivities.map((a) => ({ ts: a.createdAt })),
      ...newNotifications.map((n) => ({ ts: n.createdAt })),
      ...newScreenshots.map((s) => ({ ts: s.createdAt })),
      ...newUsbEvents.map((u) => ({ ts: u.createdAt })),
      ...breakActivities.map((b) => ({ ts: b.createdAt })),
      ...newAutoTimeEntries.map((te) => ({ ts: te.updatedAt })),
      ...newClaims.map((c) => ({ ts: c.updatedAt })),
      ...newAnomalies.map((a) => ({ ts: a.createdAt })),
      ...changedAppPolicy.map((p) => ({ ts: p.updatedAt })),
      ...newPolicyViolations.map((v) => ({ ts: v.createdAt })),
      ...newLocations.map((l) => ({ ts: l.createdAt })),
    ]);

    // Persist the new cursor AFTER the round's broadcasts. Failure is logged
    // but never fatal — the next successful round retries from the old value
    // (at-least-once: a crash here only ever replays, never loses).
    persistCursor(db, cursor).catch((err) =>
      console.error('[live-updates] failed to persist poll cursor:', err)
    );

    // Employee presence: transition-only events derived from heartbeat
    // freshness. A fresh heartbeat on an already-online employee is NOT an
    // event; ONLINE→OFFLINE is detected by the in-memory sweep when the
    // newest heartbeat goes stale (no DB writes, no per-employee timers).
    const presenceEvents: PresenceEvent[] = derivePresenceEvents(
      employeePresence,
      changedDevices.map((dev) => ({
        employeeId: dev.employeeId,
        organizationId: dev.organizationId,
        lastHeartbeat: dev.lastHeartbeat,
        employeeName:
          dev.employee && (dev.employee.firstName || dev.employee.lastName)
            ? `${dev.employee.firstName} ${dev.employee.lastName}`.trim()
            : null,
      })),
      now
    );
    for (const ev of presenceEvents) {
      io.to(`org:${ev.organizationId}`).emit('employee-presence', ev);
    }

    // Device status changes (only when status actually changed — heartbeats
    // alone do not produce events).
    for (const dev of changedDevices) {
      const prev = deviceStatus.get(dev.id);
      if (prev === dev.status) continue;
      deviceStatus.set(dev.id, dev.status);
      const emp = dev.employee;
      if (!emp) continue;
      io.to(`org:${emp.organizationId}`).emit('device-status', {
        deviceId: dev.id,
        deviceName: dev.name,
        oldStatus: prev || dev.status,
        newStatus: dev.status,
        employeeId: emp.id,
        employeeName: `${emp.firstName} ${emp.lastName}`,
        timestamp: now.toISOString(),
      });
    }

    // New application/website activities. The payload builder exposes ONLY
    // the persisted normalized domain for website rows (never a raw URL);
    // org scoping is applied here via the employee's organization room.
    for (const a of newActivities) {
      const emp = a.employee;
      if (!emp) continue;
      io.to(`org:${emp.organizationId}`).emit(
        'activity-ping',
        buildActivityPing(a, emp, departmentNames.get(emp.departmentId || '') || 'Unassigned')
      );
    }

    // New notifications.
    for (const n of newNotifications) {
      io.to(`org:${n.organizationId}`).emit('notification', {
        id: n.id,
        title: n.title,
        message: n.message,
        type: n.type,
        priority: n.priority,
        timestamp: n.createdAt.toISOString(),
      });
    }

    // New alerts (N-10): org-room event — bounded payload, never leaks across
    // organizations. Alert updates (acknowledge/resolve/escalate) are NOT
    // re-broadcast here (transition events would need an updatedAt cursor and
    // a status map like registrations/claims); new alerts cover the common
    // "a high-severity incident just appeared" case.
    for (const a of newAlerts) {
      io.to(`org:${a.organizationId}`).emit('alert-event', {
        id: a.id,
        title: a.title,
        type: a.type,
        severity: a.severity,
        status: a.status,
        timestamp: a.createdAt.toISOString(),
      });
    }

    // Break mode start/end (real activity rows titled "Break Mode …").
    // Emits BOTH the legacy `break-status` event (backward compatible with
    // existing listeners) and the dedicated `break-started` / `break-ended`
    // events — all org-scoped, all driven by real persisted rows.
    for (const b of breakActivities) {
      const emp = b.employee;
      if (!emp) continue;
      const ended = (b.title || '').includes('Ended');
      const payload = {
        employeeId: emp.id,
        employeeName: `${emp.firstName} ${emp.lastName}`,
        action: ended ? 'ended' : 'started',
        timestamp: b.createdAt.toISOString(),
      };
      io.to(`org:${emp.organizationId}`).emit('break-status', payload);
      io.to(`org:${emp.organizationId}`).emit(ended ? 'break-ended' : 'break-started', payload);
    }

    // New screenshots.
    for (const s of newScreenshots) {
      const emp = s.employee;
      if (!emp) continue;
      io.to(`org:${emp.organizationId}`).emit('new-screenshot', {
        id: s.id,
        employeeId: emp.id,
        employeeName: `${emp.firstName} ${emp.lastName}`,
        appWindow: s.appWindow || 'Unknown',
        timestamp: s.capturedAt.toISOString(),
      });
    }

    // Device claims (creation AND lifecycle transitions — the
    // claimStatus map keeps re-fetched rows silent; status is included so the
    // client can render approved/rejected/cancelled/expired accurately).
    for (const c of newClaims) {
      const prev = claimStatus.get(c.id);
      if (prev === c.status) continue;
      claimStatus.set(c.id, c.status);
      const dev = c.device;
      if (!dev) continue;
      io.to(`org:${dev.organizationId}`).emit('device-claim', {
        id: c.id,
        deviceId: dev.id,
        deviceName: dev.name,
        hostname: dev.hostname,
        employeeName: c.employee ? `${c.employee.firstName} ${c.employee.lastName}`.trim() : null,
        status: c.status,
        timestamp: c.updatedAt.toISOString(),
      });
    }

    // New USB events. No employee relation exists — emit the raw id/org so the
    // event stays honest (employee name resolution would require the relation).
    for (const u of newUsbEvents) {
      if (!u.organizationId || !u.employeeId) continue;
      io.to(`org:${u.organizationId}`).emit('usb-event', {
        id: u.id,
        employeeId: u.employeeId,
        employeeName: null,
        eventType: u.eventType,
        deviceName: u.deviceName || 'Unknown Device',
        vendorName: u.vendorName || null,
        blocked: u.blocked,
        timestamp: u.createdAt.toISOString(),
      });
    }

    // Automatically-tracked project time changed → Project Tracking refreshes
    // in real time (the client invalidates projects / project-detail /
    // project-time-entries / project-members / employee-projects).
    for (const te of newAutoTimeEntries) {
      io.to(`org:${te.organizationId}`).emit('project-time-update', {
        id: te.id,
        projectId: te.projectId,
        projectName: te.project?.name ?? 'Unknown',
        employeeId: te.employeeId,
        hours: te.hours,
        timestamp: te.createdAt.toISOString(),
      });
    }

    // New anomalies → org-scoped room only (no cross-org leakage). The
    // client invalidates ['anomalies'] list queries + dashboard aggregates.
    for (const a of newAnomalies) {
      io.to(`org:${a.organizationId}`).emit('anomaly', {
        id: a.id,
        organizationId: a.organizationId,
        employeeId: a.employeeId,
        deviceId: a.deviceId,
        type: a.type,
        severity: a.severity,
        status: a.status,
        title: a.title,
        timestamp: a.createdAt.toISOString(),
      });
    }

    // App policy changes (creation OR soft-delete) → org room. Second-admin
    // sessions refresh their app-list cache in real time.
    for (const p of changedAppPolicy) {
      io.to(`org:${p.organizationId}`).emit('app-policy', {
        id: p.id,
        appName: p.appName,
        listType: p.listType,
        isActive: p.isActive,
        timestamp: p.updatedAt.toISOString(),
      });
    }

    // New policy violations (agent enforcement events) → org room.
    for (const v of newPolicyViolations) {
      io.to(`org:${v.organizationId}`).emit('policy-violation', {
        id: v.id,
        organizationId: v.organizationId,
        employeeId: v.employeeId,
        deviceId: v.deviceId,
        executableName: v.executableName,
        severity: v.severity,
        timestamp: v.createdAt.toISOString(),
      });
    }

    // Location events — notify the admin's org that a new location fix
    // arrived. The event carries NO coordinates (privacy); the client
    // refetches the employee's location API to get the actual data.
    for (const loc of newLocations) {
      io.to(`org:${loc.organizationId}`).emit('location-update', {
        id: loc.id,
        employeeId: loc.employeeId,
        timestamp: loc.createdAt.toISOString(),
      });
    }

  } catch (err) {
    console.error('[live-updates] pollOnce error:', err);
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────

// Models the poll depends on. If the generated Prisma client was produced from
// a stale/partial schema (e.g. a `prisma generate` inside this directory that
// ignored the root schema), a missing model would throw inside pollOnce's
// Promise.all and silently silence the ENTIRE live stream. Fail loudly at boot
// instead. Generation is pinned to the authoritative root schema — see
// `npm run generate` (prisma/schema.prisma).
const REQUIRED_POLL_MODELS: (keyof PrismaClient)[] = [
  'device',
  'activity',
  'notification',
  'alert',
  'screenshot',
  'usbEvent',
  'timeEntry',
  'anomaly',
  'employee',
  'department',
  'appListEntry',
  'policyViolation',
  'locationEvent',
];

async function assertPollModels(): Promise<void> {
  for (const model of REQUIRED_POLL_MODELS) {
    const delegate = (db as unknown as Record<string, unknown>)[model];
    if (!delegate || typeof (delegate as { findMany?: unknown }).findMany !== 'function') {
      throw new Error(
        `[live-updates] Prisma client is missing required model "${model}". ` +
        `Regenerate the client from the authoritative root schema: ` +
        `cd mini-services/live-updates && npm run generate`
      );
    }
  }
}

let notifyClient: Client | null = null;

// ─── Realtime wake-up (R2: eliminate the 5s poll latency) ───────────────────
// Ingestion writes fire `pg_notify('omnisight_events', <table>)` via the
// wake-up triggers (notify-triggers.ts). This service LISTENs on that channel
// and wakes the poller immediately (debounced 250 ms). The notify is a WAKE
// SIGNAL ONLY — the poller still reads the database (source of truth) and
// broadcasts through the org-scoped, row-derived path, so authorization,
// ordering, dedupe and the durable cursor are unchanged. The 5s poll and the
// durable cursor remain as the catch-up/recovery net (restart, DB outage,
// missed notify). SLA: ingestion→delivery P95 < 1 s.
let wakeQueued = false;
let pollRunning = false;

function scheduleWake(): void {
  if (wakeQueued) return;
  wakeQueued = true;
  setTimeout(() => {
    wakeQueued = false;
    void runPollSafe();
  }, 250);
}

// Re-entrancy guard: a wake that arrives while a poll is running is coalesced
// into one queued poll instead of overlapping pollOnce executions.
async function runPollSafe(): Promise<void> {
  if (pollRunning) {
    scheduleWake();
    return;
  }
  pollRunning = true;
  try {
    await pollOnce();
  } catch (err) {
    console.error('[live-updates] pollOnce error:', err);
  } finally {
    pollRunning = false;
  }
}

async function startNotifyListener(): Promise<Client> {
  const url = new URL(resolveDbUrl());
  url.searchParams.delete('connection_limit'); // Prisma-only pool param
  const client = new Client({ connectionString: url.toString() });
  client.on('notification', (msg) => {
    if (msg.channel === NOTIFY_CHANNEL) scheduleWake();
  });
  client.on('error', (err) => {
    // Non-fatal: the 5s poll + durable cursor are the safety net while the
    // listener is down; the listener reconnects on the next service boot.
    console.error('[live-updates] notify listener error:', err.message);
  });
  await client.connect();
  await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
  return client;
}

async function start(): Promise<void> {
  // Fail fast on a stale/partial generated client (LM-P2-1): never start a
  // service that would throw every poll cycle.
  await assertPollModels();

  // Create the wake-up triggers idempotently (also applied by the production
  // migration). Failure is non-fatal — the 5s poll still runs — but logged.
  try {
    await ensureNotifyTriggers(db);
  } catch (err) {
    console.error('[live-updates] failed to ensure notify triggers:', err);
  }

  // Warm the device-status map so existing devices don't emit on first poll.
  try {
    const existing = await db.device.findMany({ select: { id: true, status: true } });
    for (const d of existing) deviceStatus.set(d.id, d.status);
  } catch (err) {
    console.error('[live-updates] initial device load failed:', err);
  }
  // Warm the presence map from fresh heartbeats WITHOUT emitting — the
  // snapshot API covers initial page state; events are transitions only.
  try {
    const fresh = await db.device.findMany({
      where: { lastHeartbeat: { not: null } },
      select: {
        employeeId: true,
        organizationId: true,
        lastHeartbeat: true,
        employee: { select: { firstName: true, lastName: true } },
      },
    });
    warmPresenceMap(
      employeePresence,
      fresh.map((d) => ({
        employeeId: d.employeeId,
        organizationId: d.organizationId,
        lastHeartbeat: d.lastHeartbeat,
        employeeName:
          d.employee && (d.employee.firstName || d.employee.lastName)
            ? `${d.employee.firstName} ${d.employee.lastName}`.trim()
            : null,
      }))
    );
  } catch (err) {
    console.error('[live-updates] initial presence warm failed:', err);
  }
  await refreshDepartments();
  cursor = await loadCursor();

  httpServer.listen(PORT, () => {
    console.log(`⚡ OmniSight Live Updates WebSocket service on port ${PORT}`);
    console.log(`   Auth: JWT handshake + session cookie | Org-scoped rooms | DB-driven events`);
  });

  // LISTEN for wake-up notifications (best-effort; the poll is the safety net).
  try {
    notifyClient = await startNotifyListener();
    console.log(`[live-updates] realtime wake-up listening on pg_notify('${NOTIFY_CHANNEL}')`);
  } catch (err) {
    console.error('[live-updates] notify listener failed to start (5s poll remains):', err);
  }

  setInterval(refreshDepartments, 60_000);
  setInterval(() => void runPollSafe(), POLL_INTERVAL_MS);
}

start().catch((err) => {
  console.error('[live-updates] failed to start:', err);
  process.exit(1);
});

function shutdown(): void {
  httpServer.close(() => {
    const closeNotify = notifyClient ? notifyClient.end().catch(() => {}) : Promise.resolve();
    void closeNotify.then(() => {
      db.$disconnect();
      process.exit(0);
    });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
