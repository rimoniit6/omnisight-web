// R9 red-team probes against the LIVE dev stack.
//   A. XFF spoof rotation: prepending forged entries must NOT rotate the login
//      bucket (canonical resolver uses the right-most entry).
//   B. Realtime room isolation: an org A socket must NOT receive org B events.
import { io } from 'socket.io-client';
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const env = readFileSync('.env', 'utf8');
const jwtSecret = (env.match(/^JWT_SECRET=(.+)$/m) || [])[1]?.trim();
const email = (env.match(/^SUPER_ADMIN_EMAIL=(.+)$/m) || [])[1]?.trim();
const password = (env.match(/^SUPER_ADMIN_PASSWORD=(.+)$/m) || [])[1]?.trim();

function base64url(data) {
  return Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signJWT(payload) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify({ ...payload, iat: now, exp: now + 3600 }));
  const sig = createHmac('sha256', jwtSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

// ─── A. XFF spoof rotation ───────────────────────────────────────────────────
// Right-most IP stays 10.44.44.44; the attacker prepends 20 forged entries.
// All 12 attempts must consume the SAME bucket (10 allowed → 429 on 11+).
const spoofedChain = Array.from({ length: 20 }, (_, i) => `203.0.113.${i + 1}`).join(',') + ',10.44.44.44';
let statuses = [];
for (let i = 0; i < 12; i += 1) {
  const res = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': spoofedChain },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' }),
  });
  statuses.push(res.status);
}
const first429 = statuses.findIndex((s) => s === 429);
const authOk = first429 >= 0 && statuses.slice(first429).every((s) => s === 429);
console.log(`A. XFF spoof: statuses=${statuses.join(',')} → first 429 at attempt ${first429 + 1} — ${authOk ? 'PASS (bucket not rotatable)' : 'FAIL'}`);

// ─── B. Realtime room isolation ──────────────────────────────────────────────
const db = new PrismaClient();
const orgs = await db.organization.findMany({ take: 2, select: { id: true } });
if (orgs.length < 2) {
  // Create a second org + employee so isolation is testable.
  const second = await db.organization.create({ data: { name: 'Red Team Org B', slug: `rt-b-${Date.now()}`, timezone: 'UTC' } });
  orgs.push({ id: second.id });
}
const [orgA, orgB] = orgs;
const empB = await db.employee.create({
  data: { employeeId: `RT-B-${Date.now()}`, firstName: 'RT', lastName: 'B', email: `rtb${Date.now()}@example.com`, organizationId: orgB.id, status: 'active' },
});

const leaked = await new Promise((resolve) => {
  const socket = io('ws://localhost:3010', {
    transports: ['websocket'],
    auth: { token: signJWT({ userId: 'rt-a', email: 'rt@a.local', role: 'admin', organizationId: orgA.id }) },
    reconnection: false,
    timeout: 8000,
  });
  let leakedEvents = 0;
  const timer = setTimeout(() => { socket.close(); resolve(leakedEvents); }, 9000);
  socket.on('connect', async () => {
    // Insert a row for org B — must NOT reach the org A room.
    await db.activity.create({
      data: { type: 'application', title: 'org-b-only', applicationName: 'rt-probe', category: 'neutral', duration: 1, employeeId: empB.id, timestamp: new Date() },
    });
  });
  socket.on('activity-ping', (ev) => {
    if (ev?.title === 'org-b-only') leakedEvents += 1;
  });
  socket.on('connect_error', (err) => { clearTimeout(timer); resolve(-1); });
});

await db.$disconnect();
const isoOk = leaked === 0;
console.log(`B. Room isolation: org A socket received ${leaked} org B events — ${isoOk ? 'PASS (fully isolated)' : 'FAIL (leak!)'}`);

if (!authOk || !isoOk) process.exit(1);
