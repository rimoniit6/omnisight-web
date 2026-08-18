// OmniSight dev runner (LM-1)
//
// `npm run dev` now starts BOTH:
//   1. the Next.js admin app        (port 3000)
//   2. the live-updates realtime service (port 3010, mini-services/live-updates)
//
// The realtime socket is org-scoped and DB-driven (never fake events). In
// development the browser connects DIRECTLY to http://localhost:3010 via
// NEXT_PUBLIC_LIVE_UPDATES_URL; in production the same client falls back to
// the Caddy XTransformPort=3010 proxy when the env var is absent.
//
// Ctrl+C terminates both children. Each child failing independently does not
// kill the other, so a realtime-service crash never takes down the admin app.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
let shuttingDown = false;

function prefixLines(prefix, stream) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) console.log(`[${prefix}] ${line}`);
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) console.log(`[${prefix}] ${buffer}`);
  });
}

function start(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: false,
  });
  children.push(child);
  prefixLines(name, child.stdout);
  prefixLines(name, child.stderr);
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.log(`[${name}] exited (code=${code} signal=${signal ?? 'none'})`);
    }
  });
  return child;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev] received ${signal} — stopping all processes…`);
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  // Give children a moment, then force-kill stragglers (Windows is lenient).
  setTimeout(() => {
    for (const child of children) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  }, 2500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('[dev] starting OmniSight admin (3000) + realtime service (3010)…');

// Realtime service — bun resolves @prisma/client + socket.io from the root
// node_modules and auto-loads .env from the repo root (DATABASE_URL,
// JWT_SECRET). Hot reload via `--hot`.
start('live', 'bun', ['--hot', 'mini-services/live-updates/index.ts']);

// Admin app — NEXT_PUBLIC_LIVE_UPDATES_URL lets the browser socket connect
// straight to the realtime service in dev (production keeps the Caddy
// transform path when the var is unset).
start(
  'app',
  process.execPath,
  [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', '3000'],
  { NODE_OPTIONS: '--max-old-space-size=768', NEXT_PUBLIC_LIVE_UPDATES_URL: 'http://localhost:3010' }
);
