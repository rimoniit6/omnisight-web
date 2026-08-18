// R2 latency probe: measure ingestion→socket delivery over the wake-up path.
//
//   1. Sign an org-scoped admin JWT (same HS256 scheme as src/lib/auth.ts).
//   2. Connect a socket.io client to ws://localhost:3010 (org room).
//   3. Insert a real Activity row directly into PostgreSQL.
//   4. Measure INSERT-completion → 'activity-ping' receipt delta.
//
// The DB insert fires the omnisight_notify trigger → pg_notify → the service's
// LISTEN wakes the poller (debounced 250 ms) → org-scoped broadcast. The
// durable cursor and 5 s poll remain as catch-up; this measures the fast path.
import { io } from 'socket.io-client';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

// HS256 JWT — mirrors src/lib/auth.ts exactly (base64url + HMAC-SHA256).
function base64url(data) {
  return Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signJWT(payload, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, iat: now, exp: now + 3600 }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

const env = readFileSync('.env', 'utf8');
const jwtSecret = (env.match(/^JWT_SECRET=(.+)$/m) || [])[1]?.trim();
if (!jwtSecret) throw new Error('JWT_SECRET missing');

const db = new PrismaClient();
const SOCKET_URL = process.env.LIVE_UPDATES_URL || 'ws://localhost:3010';
const ROUNDS = parseInt(process.env.LATENCY_ROUNDS || '8', 10);

const emp = await db.employee.findFirst({
  where: { status: 'active' },
  include: { organization: { select: { id: true } } },
});
if (!emp || !emp.organization) {
  console.error('no active employee with org found');
  process.exit(1);
}
const orgId = emp.organization.id;
console.log(`target employee ${emp.id.slice(0, 8)} org ${orgId.slice(0, 8)}`);

const token = signJWT(
  { userId: 'latency-probe', email: 'probe@test.local', role: 'admin', organizationId: orgId },
  jwtSecret
);

const insertedAt = new Array(ROUNDS).fill(0); // insert-completion time per round
const arrivedAt = new Array(ROUNDS).fill(0); // ping-receipt time per round (index = round-1)
let nextRound = 0;
const deltas = [];

await new Promise((resolve, reject) => {
  const socket = io(SOCKET_URL, {
    transports: ['websocket'],
    auth: { token },
    reconnection: false,
    timeout: 8000,
  });

  const timer = setTimeout(() => { socket.close(); reject(new Error('socket connect timeout')); }, 10000);

  socket.on('connect', () => {
    console.log('socket connected');
    clearTimeout(timer);
    void (async () => {
      for (let i = 0; i < ROUNDS; i += 1) {
        insertedAt[i] = Date.now();
        await db.activity.create({
          data: {
            type: 'application',
            title: 'Latency Probe',
            applicationName: 'latency-probe',
            category: 'neutral',
            duration: 1,
            employeeId: emp.id,
            timestamp: new Date(insertedAt[i]),
          },
        });
        insertedAt[i] = Date.now(); // after the INSERT completed
        // Wait for the ping for this round (up to 4 s).
        const deadline = insertedAt[i] + 4000;
        while (Date.now() < deadline && arrivedAt[i] === 0) {
          await new Promise((r) => setTimeout(r, 20));
        }
        if (arrivedAt[i] === 0) {
          console.log(`round ${i + 1}: TIMEOUT (no ping within 4 s)`);
        } else {
          deltas.push(arrivedAt[i] - insertedAt[i]);
        }
      }
      socket.close();
      resolve();
    })();
  });

  socket.on('activity-ping', () => {
    const now = Date.now();
    if (nextRound < ROUNDS) {
      arrivedAt[nextRound] = now;
      nextRound += 1;
    }
  });

  socket.on('connect_error', (err) => {
    clearTimeout(timer);
    reject(new Error(`connect_error: ${err.message}`));
  });
});

await db.$disconnect();

if (deltas.length === 0) {
  console.log('NO pings received — wake-up path not delivering');
  process.exit(1);
}

const sorted = [...deltas].sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length * 0.5)];
const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
const max = sorted[sorted.length - 1];
console.log(`\ndeltas (ms): ${deltas.join(', ')}`);
console.log(`rounds: ${deltas.length}`);
console.log(`p50: ${p50} ms | p95: ${p95} ms | max: ${max} ms`);
