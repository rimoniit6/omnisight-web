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
import { spawn, execSync } from 'node:child_process';
import { createServer } from 'node:net';
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
      if (name === 'live' && code !== 0) {
        console.error(`\n[dev] ✗ realtime service FAILED (code=${code} signal=${signal ?? 'none'})`);
        console.error('[dev]   Check if port 3010 is occupied by another process.');
        console.error('[dev]   Run: netstat -ano | findstr :3010   to find the owning PID.');
      } else {
        console.log(`[${name}] exited (code=${code} signal=${signal ?? 'none'})`);
      }
    }
  });
  return child;
}

/**
 * Check if a TCP port is available by attempting to bind to it.
 * Returns true if the port is free, false if something is listening.
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.on('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * On Windows, try to kill orphaned bun/node processes on a specific port.
 * Uses PowerShell to find the PID from netstat and kills only that process.
 * Best-effort: if anything fails, returns without killing.
 */
async function killPortOwner(port) {
  if (process.platform !== 'win32') return;
  try {
    const output = execSync(
      `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique"`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    if (!output) return;
    const pids = output.split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      // Only kill processes that look like bun or node — never kill system PIDs
      try {
        const procInfo = execSync(
          `powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName"`,
          { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        const name = procInfo.toLowerCase();
        if (name.includes('bun') || name.includes('node')) {
          console.log(`[dev] killing orphaned ${procInfo} (PID ${pid}) on port ${port}…`);
          process.kill(Number(pid), 'SIGKILL');
        }
      } catch {
        // Process may have already exited — ignore
      }
    }
  } catch {
    // PowerShell not available or command failed — non-fatal
  }
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
// SIGHUP is not defined on Windows — guard against it
if (process.platform !== 'win32') {
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

// Ensure child process cleanup on parent exit (covers uncaught exceptions,
// window close, task manager termination, etc.)
process.on('exit', () => {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

// ── Port 3010 pre-flight check ──────────────────────────────────────────────
// Before starting the realtime service, verify port 3010 is available.
// If occupied, attempt to kill the orphaned process (Windows only), then
// re-check. This prevents the confusing "Failed to start server" error
// from bun when a stale child from a previous session still holds the port.
const LIVE_UPDATES_PORT = 3010;

async function main() {
  let portAvailable = await isPortAvailable(LIVE_UPDATES_PORT);

  if (!portAvailable) {
    console.log(`[dev] port ${LIVE_UPDATES_PORT} is occupied — attempting to clean up orphaned process…`);
    await killPortOwner(LIVE_UPDATES_PORT);
    // Wait briefly for the OS to release the port
    await new Promise((r) => setTimeout(r, 1000));
    portAvailable = await isPortAvailable(LIVE_UPDATES_PORT);
  }

  if (!portAvailable) {
    // Try to identify what's using the port for diagnostics
    let portOwner = 'unknown';
    try {
      if (process.platform === 'win32') {
        const output = execSync(
          `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${LIVE_UPDATES_PORT} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess"`,
          { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
        ).trim();
        if (output) {
          const procInfo = execSync(
            `powershell -NoProfile -Command "(Get-Process -Id ${output} -ErrorAction SilentlyContinue).ProcessName"`,
            { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
          ).trim();
          portOwner = procInfo ? `${procInfo} (PID ${output})` : `PID ${output}`;
        }
      }
    } catch {
      // Ignore — diagnostic only
    }
    console.error(`\n[dev] ✗ Cannot start realtime service: port ${LIVE_UPDATES_PORT} is in use by ${portOwner}.`);
    console.error(`[dev]   To investigate: netstat -ano | findstr :${LIVE_UPDATES_PORT}`);
    console.error(`[dev]   To use a different port: set LIVE_UPDATES_PORT=<port> and update NEXT_PUBLIC_LIVE_UPDATES_URL`);
    console.error(`[dev]   Continuing with Next.js only (no realtime service)…\n`);
  }

  console.log('[dev] starting OmniSight admin (3000)' + (portAvailable ? ` + realtime service (${LIVE_UPDATES_PORT})` : ' (realtime service skipped)') + '…');

  if (portAvailable) {
    // Realtime service — bun resolves @prisma/client + socket.io from the root
    // node_modules and auto-loads .env from the repo root (DATABASE_URL,
    // JWT_SECRET). Hot reload via `--hot`.
    start('live', 'bun', ['--hot', 'mini-services/live-updates/index.ts']);
  }

  // Admin app — NEXT_PUBLIC_LIVE_UPDATES_URL lets the browser socket connect
  // straight to the realtime service in dev (production keeps the Caddy
  // transform path when the var is unset).
  start(
    'app',
    process.execPath,
    [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-p', '3000'],
    { NODE_OPTIONS: '--max-old-space-size=768', NEXT_PUBLIC_LIVE_UPDATES_URL: portAvailable ? 'http://localhost:3010' : '' }
  );
}

main();
