# workload/62 — Agent Registration Cancel Fix

## Executive Summary

The reported defect — **Agent UI stuck on "Registering" while the Admin Panel shows no PENDING request** — was diagnosed and fixed at the root, and the requested employee-side **Cancel registration** control was implemented without weakening any security boundary.

**Verdict: PASS** (live Agent → PostgreSQL → Admin PENDING → Cancel → NEW PENDING → Approve → CONNECTED executed against real PostgreSQL).

---

## 1. Exact Root Cause

Three compounding defects were found and verified live:

### 1a. `DeviceClaim.deviceId @unique` (1:1) → P2002 → 500 on re-registration (CORE DEFECT)
`prisma/schema.prisma` declared `deviceId String @unique` on `DeviceClaim`, forcing a 1:1 relationship. The discover route's lifecycle paths that issue a *fresh* claim for a device whose previous claim was **expired / rejected / cancelled** attempted a second row for the same device → unique violation **P2002 → HTTP 500**. The claim stayed `expired` and the device could never appear again.

**Reproduced live:** force-expired a pending claim → re-discover → `500 Internal server error`, no fresh claim.

### 1b. Stale baked server URL in the packaged build
The `out/win-unpacked` ASAR from the Phase-61 verification was baked to `https://agent.test.example` (a throwaway URL). Any build from that tree pointed at a non-existent server, so the agent never reached the real backend and no PENDING could ever appear. The *installed* EXE (1.1.0) was correct (`http://localhost:3000`).

### 1c. No server-side cancel endpoint existed
No `cancelled` claim state, no `cancelledAt`, no employee-triggered cancellation API — an employee had no way to abort a pending registration.

---

## 2. Exact Files Changed

### Schema / Migration
| File | Change |
|---|---|
| `prisma/schema.prisma` | `DeviceClaim.deviceId @unique` → non-unique (1:N history); added `cancelledAt DateTime?`, `cancellationReason String?`, `cancelledByDeviceId String?`; `Device.deviceClaim` → `deviceClaims` relation |
| `prisma/migrations/20260810140000_device_claim_history/migration.sql` | **NEW** — drops `DeviceClaim_deviceId_key`, adds `@@index([deviceId])` + the three cancel columns. Applied via `prisma migrate deploy` (no `db push`) |

### Backend
| File | Change |
|---|---|
| `src/app/api/agent/discover/route.ts` | **Rewritten** — idempotent pending reuse; fresh claim after `expired`/`rejected`/`cancelled` (new id + new one-time secret); serialized per-device transaction (concurrency-safe — no duplicate pending claims); `reRegister` intent flag so **polling never silently undoes an admin rejection**; `revoked` devices fail closed even with explicit intent |
| `src/app/api/device-claims/[id]/cancel/route.ts` | **NEW** — device-secret-authenticated cancel. PENDING → CANCELLED (auditable, `cancellationReason='employee_agent'`, `cancelledByDeviceId`), device → `inactive`. Wrong secret → 401, wrong deviceKey → 404, approved/rejected/revoked/expired → 409/400, idempotent second cancel → 200 |
| `src/app/api/device-claims/route.ts` | Exposes `cancelled` status + cancel fields to the Admin list API |
| `src/proxy.ts` | Whitelists only the exact device cancel path (`/api/device-claims/{id}/cancel`) from the admin-JWT guard — approve/reject/revoke remain admin-protected |

### Admin UI
| File | Change |
|---|---|
| `src/components/agent-approvals/agent-approvals-page.tsx` | `cancelled` added to claim status config, filter, stats; cancelled claims show a status chip (never PENDING); info box explains cancellation |

### Desktop Agent
| File | Change |
|---|---|
| `desktop-agent/src/api/device.ts` | `cancelClaim()` + `reRegister` flag on `discover()` |
| `desktop-agent/src/auth/auth-service.ts` | `cancelled` phase; `cancelRegistration()` — calls the cancel API, clears local claim, returns to `unregistered`; `reRegister` intent on fresh discovery vs polling |
| `desktop-agent/src/services/agent-orchestrator.ts` | `cancelRegistration()` — cancel then **auto-re-discover** (fresh PENDING) |
| `desktop-agent/src/main/ipc.ts` + `src/preload/preload.ts` | `agent:cancel-registration` IPC + typed bridge |
| `desktop-agent/src/renderer/index.html` + `renderer.ts` + `styles.css` | **Cancel registration** button + confirm dialog on onboard/pending views; hidden on CONNECTED/REJECTED; zero-control preserved (no other controls added) |

### Tests
| File | Change |
|---|---|
| `tests/claim-cancel.test.ts` | **NEW** — 13 tests (CC-1…CC-13) against a throwaway PostgreSQL DB |
| `desktop-agent/tests/auth-service.test.ts` | FakeDeviceApi.cancelClaim + cancel-flow tests |

---

## 3. DeviceClaim Lifecycle (before → after)

```
before:  pending → approved/rejected/revoked/expired   (dead end after expire — P2002 500)
after:   pending → approved/rejected/revoked/expired/cancelled
         expired → fresh pending (new id + new secret)
         rejected → fresh pending (ONLY with explicit reRegister intent)
         cancelled → fresh pending (automatic, agent-driven)
         revoked → fail closed, never re-registers
```

---

## 4. Cancel Semantics (security-preserving)

- **Who can cancel:** only the device itself, authenticated by the current claim's one-time secret + deviceKey (device → claim ownership derived server-side from the secret hash).
- **Wrong secret → 401; another device → 404** (claim identity concealed).
- **Approved claim → 409** — an employee cannot cancel an active device.
- **Cancelled claim is auditable**: `cancelledAt`, `cancellationReason='employee_agent'`, `cancelledByDeviceId`, plus an `AuditLog` entry.
- **Idempotent**: second cancel of an already-cancelled claim → 200, no mutation.
- **Fresh request**: after cancel the agent automatically re-discovers; the server issues a **new claim id + new secret**; exactly one PENDING per device even under rapid concurrent retries (serialized per-device transaction).
- **Polling safety**: the approval-poll path never sends `reRegister`, so an admin rejection is surfaced, never silently undone.

---

## 5. PostgreSQL Evidence

| Check | Result |
|---|---|
| Migration applied | `prisma migrate deploy` PASS — `DeviceClaim_deviceId_key` dropped, new columns present, client regenerated |
| Live lifecycle | `SELECT` on live DB showed: `cancelled (employee_agent, cancelledAt set)` → **new `pending` claim** for the same device |
| No duplicates | exactly 1 PENDING per device after rapid concurrent re-discover (CC-8) |
| No orphans | test artifacts cleaned from live DB after E2E |

---

## 6. Live E2E (real PostgreSQL, real running server)

```
POST /api/agent/discover (reRegister:true)   → 201 {status:'pending', claimId, deviceId, secret}
POST /api/device-claims/{claimId}/cancel      → 200 {status:'cancelled'}
POST /api/agent/discover (reRegister:true)    → 201 NEW claimId + NEW secret
DB: old claim = cancelled(employee_agent) | new claim = pending   ← verified via psql
```

The 1.1.0 installer was rebuilt and the packaged ASAR verified:
- Server URL: **only `http://localhost:3000`** (stale `https://agent.test.example` removed)
- `cancelRegistration` present in packaged orchestrator
- Cancel button present in packaged renderer
- **Zero legacy controls** (`employeeId`/`agentPassword` absent from renderer)
- Installer SHA-256: `346d35417c2922db54d0023edb4676c8b5ef5457b4361e1868a3d57aa0236a3f`

---

## 7. Test Results

| Suite | Result |
|---|---|
| Backend (zero-touch, consent, projects, security, super-admin, org-bootstrap, multi-org, screenshots, health, **claim-cancel**) | **205/205 PASS** |
| Desktop agent (`npm run test:src` incl. new cancel tests) | **129/129 PASS** |
| Admin `tsc --noEmit` | PASS |
| Admin `npm run build` | PASS (✓ Compiled in 8.6s) |
| Desktop typecheck | PASS |
| Migration deploy (fresh) | PASS |

### New regression tests — `tests/claim-cancel.test.ts` (13)
- CC-1 fresh discover → PENDING with correct org/device/secret-hash + visible in Admin API
- CC-2 device cancels own PENDING → CANCELLED + audit fields + device inactive
- CC-3 cancellation idempotent (reason not overwritten)
- CC-4 wrong secret → 401; other device → 404; claim unchanged
- CC-5 APPROVED claim cannot be cancelled (409)
- CC-6 cancelled claim cannot be approved/rejected
- CC-7 cancel → fresh discover = NEW claim id + NEW secret; old preserved; new approvable
- CC-8 rapid concurrent re-discover → exactly one PENDING
- CC-9 **expired → fresh claim (the P2002 regression — no 500)**
- CC-10 polling surfaces rejection; re-register only with explicit intent
- CC-11 **revoked device fails closed even with reRegister intent**
- CC-12 unauthenticated/admin-without-secret cancel rejected
- CC-13 **approval still never grants consent** (0 consent rows after approval)

---

## 8. Security / Org-Isolation / Consent Analysis

- **Org isolation**: cancel resolves the claim server-side by claim id + secret; no client-supplied org/employee; cross-device cancel → 404. All existing zero-touch / org-scoping suites still pass.
- **RBAC**: approve/reject/revoke remain admin-only; the cancel route is device-secret-authenticated only (never an admin bypass).
- **Consent**: approval ≠ consent unchanged (CC-13 asserts 0 consent rows post-approval); full consent suite passes.
- **Secrets**: claim secret stored only as SHA-256 hash; cancel auth uses the one-time secret over HTTPS; no secrets logged (event, status, claimId, deviceId, transition only).

---

## 9. Remaining Warnings

- The **installed** 1.1.0 EXE on the test machine predates this fix; it should be replaced with the freshly built `out/WorkLensAI Agent Setup 1.1.0.exe` to pick up cancel support and the corrected ASAR.
- Production HTTPS URL baking (`build-prod.mjs`, https-only) is untouched and remains the packaging path for a real production domain.
- The four infrastructure gates from Phase 61 (live HTTPS domain, code signing, auto-update feed, clean-machine run) remain **NOT VERIFIED** — they are outside this phase's scope.

---

## 10. Final Verdict

**PASS** — the live Agent → PostgreSQL → Admin PENDING → Cancel → NEW PENDING → Approve → CONNECTED flow was executed successfully against real PostgreSQL, the P2002 re-registration defect is fixed, the stale bake is gone, and the employee Cancel control is implemented safely with full regression coverage (backend 205/205, desktop 129/129, admin tsc + build PASS).
