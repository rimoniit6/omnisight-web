# OmniSight Desktop Agent — Development

## Prerequisites

- Node 18+ (LTS recommended)
- npm
- Windows 10/11 with **MSVC Build Tools** (for the native addon), or
  node-gyp prerequisites (`npm install -g windows-build-tools` or VS Build
  Tools workload)
- Python 3.x (node-gyp dependency)

The agent code itself only depends on Node builtins + Electron. `tsx` is used
for tests/scripts (already a devDependency of the admin app).

## Setup

```bash
# From the repository root
npm install --prefix omnisight-agent   # electron, electron-builder, typescript
```

`electron` and `electron-builder` are large downloads — they are devDependencies
of `omnisight-agent/` only and never affect the admin app's install.

## Commands

| Command | What it does |
|---|---|
| `npm --prefix omnisight-agent run typecheck` | `tsc --noEmit` |
| `npm --prefix omnisight-agent run test:src` | run `tests/*.test.ts` via tsx/node:test |
| `npm --prefix omnisight-agent run build` | tsc → `dist/` + copy renderer assets |
| `npm --prefix omnisight-agent run dev` | build then launch Electron |
| `npm --prefix omnisight-agent run package` | build + electron-builder Windows installer |
| `npm --prefix omnisight-agent run rebuild-native` | rebuild the native addon (`node-gyp rebuild`) |

Root aliases (non-breaking, admin scripts untouched):

```bash
npm run dev:agent        # dev:agent = npm --prefix omnisight-agent run dev
npm run build:agent
npm run package:agent
npm run test:agent
npm run typecheck:agent
```

## Testing

Tests use the built-in `node:test` runner via `tsx` (no framework installed):

```bash
npm --prefix omnisight-agent run test:src
# or from root:
npm run test:agent
```

Suites:

| Suite | Covers |
|---|---|
| `api-client.test.ts` | auth header, JSON encoding, error mapping, retry/backoff (4xx vs 5xx vs 429), timeout, network error |
| `auth-service.test.ts` | enroll (pending vs already_approved), authenticate, 403 pending/rejected mapping, restore from store, expiry, auto re-auth, logout |
| `consent-gate.test.ts` | fail-closed gate: no snapshot / stale / revoked / disabled / missing type / re-consent |
| `activity-queue.test.ts` | persistence across instances, ack, attempts, corrupt-line recovery, byte bounding, clear |
| `device-identity.test.ts` | stable identity, 64-hex id, binding-mismatch regeneration, corrupt-file recovery |
| `scheduler.test.ts` | interval runs, runNow, exclusive non-overlap, error capture, stopAll |
| `queue-uploader.test.ts` | ack on success, idempotent drain, 5xx retry, permanent-4xx skip, empty drain |

Run everything:

```bash
cd omnisight-agent && npm run test:src
```

## Working with the native addon

The addon (`native/`) exposes Win32 foreground-window + idle sampling and
GDI+ PNG screen capture. The TypeScript side depends only on the typed
`native-bridge.ts` interface, so the agent typechecks and tests without the
addon installed. On a dev machine without MSVC, collection services degrade to
"no data" rather than crashing the app.

## Development flow

1. Keep `omnisight-agent/src/types/api.ts` in sync with the backend contract
   (`src/app/api/agent/*` in the admin app).
2. Run `npm run test:agent` after touching any core module.
3. Never add ad-hoc `setInterval` — register work on the `Scheduler`.
4. Never bypass the consent gate; server 403 remains authoritative.
