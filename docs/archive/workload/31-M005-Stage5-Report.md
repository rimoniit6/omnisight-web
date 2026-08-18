# M005 Stage-5 — E2 Agent Activation (DeviceAssignment) — Implementation Report

> **Scope:** `POST /api/agent/v1/activate` — server-side binding of a registered device to its employee via `DeviceAssignment`. After this stage, **DeviceAssignment (not `Device.status`) is the source of truth that authorizes data ingestion.** No token rotation, screenshots, commands, analytics, policies, or AI.

---

## 1. Files changed

| File | Change |
|---|---|
| `prisma/schema.prisma` | **MODIFIED** — `DeviceAssignment.revokeReason String?` (mission step 8 requires setting a reason on revocation) |
| `prisma/migrations/<ts>_m005_stage5_deviceassignment_revoke_reason/migration.sql` | **NEW** — clean `ALTER TABLE ADD COLUMN` (no table-recreate ⇒ ADR-029 partial unique index survives); verified present after deploy |
| `src/lib/agent-auth/errors.ts` | **MODIFIED** — +`AGENT_DEVICE_UNASSIGNED` (403) + `AgentDeviceUnassignedError` |
| `src/lib/agent-auth/context.ts` | **MODIFIED** — +`ActiveDeviceAssignment` type, `loadActiveAssignmentByDeviceId` loader slot on `AgentAuthLoaders`, `requireAssignment` option, `assignment` in returned context, **`assertAssignedDevice()`** reusable gate |
| `src/lib/agent-auth/loaders.ts` | **MODIFIED** — Prisma `loadActiveAssignmentByDeviceId` (active window: `revokedAt: null`, latest `assignedAt` first) |
| `src/lib/agent.ts` | **MODIFIED** — +`activateDevice()` (11-step activation transaction) + `ActivateAgentResult` |
| `src/app/api/agent/v1/activate/route.ts` | **NEW** — E2 endpoint: `authenticateAgentRequest` (`allowPending`, no `requireAssignment`) → zod `activationSchema` → `activateDevice` → contract + mission DTO |
| `src/app/api/agent/v1/heartbeat/route.ts` | **MODIFIED** — `requireAssignment: true` (keeps `allowPending: true` — E3 is the pending poll channel, contract §2.6) |
| `src/app/api/agent/v1/activity/route.ts` | **MODIFIED** — `requireAssignment: true` |
| `scripts/verify-e2.mjs` | **NEW** — live E2 verification, **53 checks** |
| `scripts/verify-e3.mjs` · `scripts/verify-e5.mjs` | **MODIFIED** — setup now ACTIVATES the device after E1 (mission's only valid flow: Register → Activate → Heartbeat → Activity); fixed double-`Date.now()` timestamp flake (signing vs `X-Timestamp` header ms-exact) |
| `db/custom.db.bak-m005s5` | DB backup before migration |

**Migration:** `DeviceAssignment.revokeReason` (additive). ADR-029 partial unique index (`DeviceAssignment_deviceId_active_idx … WHERE revokedAt IS NULL`) confirmed present before **and** after the migration (M003 fragility note honored — no table-recreate).

## 2. Activation flow

`POST /api/agent/v1/activate` — body is **only** `{ clientTime }` (contract E2). No `userId`/`deviceId`/`assignmentId` in the body — everything is resolved server-side (anti-spoof).

Inside **one Prisma transaction** (`activateDevice`):

1. Load current device (missing → 401 `AGENT_DEVICE_NOT_FOUND`).
2. Verify installation active (defense-in-depth; verifier already checks).
3. Device exists (same as 1).
4. Reject `Retired` → 403 `AGENT_DEVICE_REVOKED`.
5. Reject `Suspended` → 403 `AGENT_DEVICE_REVOKED`.
6. **Resolve target user** — server-authoritative (ADR-024): admin UI sets `User.deviceId` (current-assignment cursor); E2 finds the user by that cursor. No user → 403 `AGENT_DEVICE_PENDING` ("admin must assign first").
7. If an active assignment to the **same user** exists → idempotent success (same `assignmentId`).
8. If another active assignment exists (reassignment) → close its window: `revokedAt = now`, `revokeReason = 'reassigned'`.
9. Create new `DeviceAssignment` (`deviceId`, `userId`, `assignedAt`, `assignedBy = 'system'`, `revokedAt = null`).
10. Update `Device` → `status = 'Online'`, `lastSeen`, `lastHeartbeatAt` (presence only).
11. Commit.

## 3. Database behavior

- **Idempotency:** repeat activation returns the existing active window unchanged (never a duplicate). Only one active assignment per device — enforced at the app layer **and** the ADR-029 partial unique index (verified with a raw-SQL insert → `UNIQUE` violation).
- **Reassignment:** old window gets `revokedAt` + `revokeReason = 'reassigned'`; the historical windows remain (ADR-024 attribution model).
- **Authorization change:** `Device.status` is now presence only (`Online`/`Offline`). Data ingestion (E3 heartbeat, E5 activity, future screenshots) requires an active `DeviceAssignment`.

## 4. Authorization changes

| Endpoint | `allowPending` | `requireAssignment` | Semantics |
|---|---|---|---|
| E1 register | — | — | join-key bootstrap (unchanged) |
| E2 activate | ✅ | — | **creates** the assignment |
| E3 heartbeat | ✅ | ✅ | Pending devices may poll (contract §2.6); once `Online`, must have an assignment |
| E5 activity | — | ✅ | must have an active assignment (Pending already rejected) |

`assertAssignedDevice(loaders, device, { allowPending })` is the single reusable gate — the only assignment lookup in the system. It runs with the other state checks (before the crypto pipeline), so a missing assignment never burns a legitimate nonce. No duplicated lookup logic in any route.

## 5. Assignment lifecycle

```
E1 register (Pending) → admin sets User.deviceId → E2 activate
  → DeviceAssignment (assignedBy=system, active) + Device=Online
  → E3/E5 authorized by the active window
  → admin revoke → revokedAt+reason → E3/E5 → 403 AGENT_DEVICE_UNASSIGNED
  → reassign (User.deviceId moved) + E2 → old window closed (reassigned), new active
```

## 6. Verification

**`verify-e2.mjs` 53/53 live** — first activation · repeat activation (idempotent) · gate integration (E3 200 / E5 202 with assignment) · revoked assignment (E3/E5 → 403 `AGENT_DEVICE_UNASSIGNED`, E2 re-activates with a new id) · reassignment (exactly 1 active, old window revoked with reason) · duplicate activation (never >1) · **partial unique index** (raw SQL 2nd active insert → UNIQUE violation) · unauthorized (bad token 401, missing headers 401) · expired token (401 `AGENT_TOKEN_EXPIRED`) · disabled installation (403) · suspended device (403) · retired device (403) · pending-without-assignment (E2 403 `AGENT_DEVICE_PENDING`; activity 403 `AGENT_DEVICE_PENDING` while Pending, then 403 `AGENT_DEVICE_UNASSIGNED` after heartbeat flips Online — status vs assignment separation proven) · assignment lookup · **transaction rollback** (mid-tx failure rolls back inserted assignment; active count unchanged) · response DTO field audit · build.

**Full live regression:** E2 **53/53** · E1 **23/23** · E3 **32/32** (was 30; +2 Stage-5 setup checks) · E5 **46/46** (was 44; +2) — 154 checks, zero failures, run back-to-back.

**Static:** `prisma validate` ✅ · `migrate status` 7/7 up-to-date ✅ · E0 **107/107** · S2 **30/30** · `tsc --noEmit` 0 new errors · `eslint` clean · **`npm run build` ✅** (`ƒ /api/agent/v1/activate` in route manifest; standalone assets copied).

## 7. Security review

- **Server-authoritative identity:** agent cannot influence `userId`/`deviceId`/`assignmentId` — all resolved server-side from the `User.deviceId` cursor set by the admin UI.
- **Assignment gate before crypto:** a missing/expired assignment fails fast without consuming the device's nonce (extends E0 anti-DoS).
- **Error codes consistent with contract §3 envelope** (401/403/409/422); details never leak secrets.
- **Migration safety:** `ALTER TABLE ADD COLUMN` only — the ADR-029 partial unique index is confirmed intact post-migration (verified via `sqlite_master`).
- No tokens/signatures/nonces logged; activate logs device/assignment/user IDs only.

## 8. Reviewer fixes (post-implementation review)

- **P1 — Concurrent-activation race:** two parallel `activateDevice` calls (no active window yet) could both pass the pre-check; the loser's `create` hit ADR-029's partial unique index → P2002 → 500. Added a bounded single retry on P2002 (mirrors `persistActivityEvents`) — the retry sees the winner's committed window and resolves to idempotent success.
- **P2 — Deterministic user resolution:** `User.deviceId` has no unique constraint; if an admin reassigns without clearing the old cursor, `findFirst` was non-deterministic. Added `orderBy: { updatedAt: 'desc' }` — the most recently assigned owner wins.
- **P3 — Size gate consistency:** the >8 KB activation body now returns **413 `AGENT_PAYLOAD_TOO_LARGE`** (contract §5.4) via `agentPayloadTooLarge`, matching E5 — not 422.

Verified again after fixes: E2 **53/53** · E1 **23/23** · E3 **32/32** · E5 **46/46** · `tsc` 0 errors · `eslint` clean · `npm run build` ✅.

## 9. Risks

- **`User.deviceId` cursor is the assignment mechanism** — it is a single-column cursor, not a full audit trail. Admin UI changes to it are not yet themselves audit-logged (out of scope; ADR-024 accepts the cursor for current UI).
- **E3-with-Pending is deliberately assignment-exempt** (poll channel). A Pending device that heartbeats flips `Online` but stays unassigned → data endpoints return `AGENT_DEVICE_UNASSIGNED` until E2 runs. This is the intended semantic, but operators must know to assign before expecting telemetry.
- **No rate limiter yet** on E2 (Stage-4 note — planned for a later stage).
- **One assignment per device** is enforced by the partial unique index; concurrent admin+agent activation races resolve to one window (index backstop), no error path observed.

## 10. Rollback

- Code: revert the 10 touched files (drop the `requireAssignment` flags on E3/E5 to restore pre-Stage-5 gating; delete the activate route + `activateDevice` + gate plumbing).
- DB: `prisma migrate resolve --rolled-back <m005_stage5_deviceassignment_revoke_reason>` then delete the migration folder and `prisma migrate deploy` (column drop via `db:push`). Restore point: `db/custom.db.bak-m005s5`.
- Assignment windows already created can be left (historical attribution) or cleared (`DELETE FROM DeviceAssignment`).

## 11. Git commit message

```
feat(agent): E2 activate — DeviceAssignment as the data-ingest authorization (M005 Stage-5)

- POST /api/agent/v1/activate: 11-step server-authoritative activation in one
  transaction (verify install/device → resolve user via User.deviceId cursor →
  idempotent window / close prior window → create assignedBy=system → Online)
- DeviceAssignment is now the source of truth: heartbeat/activity require an
  active assignment (assertAssignedDevice); Device.status is presence only
- +revokeReason column (migration; ADR-029 partial unique index preserved)
- +AGENT_DEVICE_UNASSIGNED 403; reusable assertAssignedDevice gate (no dup logic)
- verify-e2.mjs 53/53 live; E1 23/23 · E3 32/32 · E5 46/46 · E0 107/107 · S2 30/30
- prisma validate/generate/migrate ✅ · tsc ✅ · eslint ✅ · build ✅
```
