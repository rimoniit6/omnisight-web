# Phase 5, STEP 2 — Database / Device Lifecycle Audit

> **Type:** READ-ONLY audit. No production code, schema, migrations, tests, or UI modified.
> **Date:** 2026-08-11
> **Inputs:** `workload/70-Agent-Device-Lifecycle-Audit.md` (STEP 1) · full `prisma/schema.prisma` (821 lines) · all agent routes · background jobs

---

## 1. Executive summary

The current schema **can safely represent** "many registered devices, maximum one active device per employee" **without any migration**. The server-authoritative signal is the **AgentToken** (exists + not expired + bound to a device + satisfies employee/account/device checks). Enforcement must be **application-level**: the schema has **no constraint** (unique index, partial index, or enum) that can express "one active token per employee", and `Prisma` cannot express a partial unique index without a raw-SQL migration.

The single-activation control point is `POST /api/agent/authenticate` (both PATH A and PATH B), which today runs its `deleteMany + create` transaction **without locking the Employee row** — the STEP 1 race (R1) is confirmed against the actual schema and transaction code. The fix is a **transactional employee-row lock (`SELECT … FOR UPDATE`) + in-transaction inspection of existing valid AgentTokens**, returning `409 ACTIVE_DEVICE_EXISTS` instead of the current silent kick.

Secondary confirmed gaps (no code changes made):
- Logout never transitions `Device.status` → stale `online` forever.
- No background job ages `online` or cleans tokens (only `expire_consents` and `retention_cleanup` exist).
- `DELETE /api/devices/[id]` cascades to DeviceClaims, Activities, and Screenshots — device "disconnect" must be a separate, history-preserving operation.
- `validateAgentToken` does **not** check `Organization.status` (org-disable does not fail closed at token validation time).
- PATH A authenticate does **not** check `AgentAccount.status` nor `Device.status` (disabled account / inactive device can still obtain a fresh token; only token-use then fails closed).

## 2. Current schema (device/agent-relevant models)

```
Organization (id PK, status: active|suspended|archived)
 ├─ 1:N Employee (organizationId FK, onDelete: Cascade)
 │    ├─ 1:1 AgentAccount (employeeId UNIQUE FK, onDelete: Cascade)
 │    ├─ 1:N AgentToken (employeeId FK, onDelete: Cascade)   ← NO device relation
 │    ├─ 1:N AgentSession (scalar employeeId/organizationId — NO FK at all)
 │    ├─ 1:N Device (employeeId FK, onDelete: SetNull)
 │    ├─ 1:N DeviceClaim (employeeId FK, onDelete: SetNull)
 │    └─ agentApproved Boolean · status: active|inactive|archived
 ├─ 1:N Device (organizationId FK, onDelete: Cascade)
 │    ├─ status: online|offline|inactive|maintenance|retired (free string)
 │    ├─ agentKey UNIQUE (stable machine identity)
 │    ├─ 1:N DeviceClaim (deviceId FK, onDelete: Cascade)
 │    ├─ 1:N Activity (deviceId FK, onDelete: Cascade)
 │    └─ 1:N Screenshot (deviceId FK, onDelete: Cascade)
 ├─ 1:N DeviceClaim (organizationId FK, onDelete: Cascade)
 │    └─ status: pending|approved|rejected|revoked|expired|cancelled (free string)
 └─ 1:N AuditLog (organizationId FK, onDelete: Cascade) — resource/resourceId are
      free strings, NO FK to devices/employees

AgentToken: id PK · token UNIQUE · employeeId FK(Cascade) · deviceId String? (NO FK!)
            · ipAddress · userAgent · expiresAt (24h) · lastUsedAt
AgentSession: id PK · token UNIQUE · employeeId scalar · organizationId scalar
              · expiresAt (24h) · lastUsedAt   (intentionally FK-free, ephemeral)
```

Indexes: `AgentToken @@index([employeeId])` only. `Device @@index([organizationId]), @@index([employeeId]), @@index([status])`. `DeviceClaim @@index([organizationId]), @@index([status]), @@index([employeeId]), @@index([deviceId])`.

**Critical structural facts:**
1. `AgentToken.deviceId` is a **plain scalar** — no relation, no FK, no cascade. Device deletion orphans the reference (token fails closed at lookup, row lingers until expiry).
2. **No uniqueness** on `AgentToken.employeeId` or `AgentToken.deviceId` — only `token` itself is unique.
3. `AgentSession` deliberately has **no FK** — a deleted employee/account can never block session expiry (design invariant, session.ts:12-14).
4. `Device.status`, `DeviceClaim.status`, `Employee.status`, `Organization.status`, `AgentAccount.status` are **free strings** — no DB enum constraint; Prisma-level validation is the only guard.
5. `Consent` is **employee-scoped** (`@@unique([employeeId, consentType])`) — consent survives device changes by design; approval ≠ consent (approve route comment, line 22-23).

## 3. Relationship diagram

```
Organization ──1:N──> Device ──1:N──> DeviceClaim
     │                    │ 1          ▲  N:1
     │                    │ N           │ employeeId (SetNull)
     │ 1:N                │ N           │
     └──────> Employee ───┼─────────────┘
              │ 1:N       │ N
              │           ▼
              │      AgentToken ──(deviceId String? — NO FK)──> (orphan-safe)
              │ 1:N
              └──> AgentSession (scalars, no FK)
              │ 1:1
              └──> AgentAccount (employeeId UNIQUE, Cascade)
```

## 4. AgentToken lifecycle (exact references)

| Stage | Location |
|---|---|
| **Create** | `src/app/api/agent/authenticate/route.ts` — PATH B `db.$transaction` lines 86–175 (`deleteMany` 87, token create 139–148); PATH A `authenticateDevice` lines 254–300 (`deleteMany` 255, token create 276–285) |
| **Expire** | `expiresAt` = now+24h (route.ts:137 / 275); enforced at validation |
| **Validate** | `src/lib/agent/auth.ts` `validateAgentToken` 61–164: exists → expiry → employee.agentApproved → employee.status active → AgentAccount.status active → **device.status must be `online`|`offline`** (132–141) → lastUsedAt update. **No Organization.status check.** |
| **Delete (logout)** | `src/app/api/agent/logout/route.ts` 46–57 (exact-token delete) |
| **Delete (expiry)** | `auth.ts:102` — deleted on sight during validation only |
| **Delete (kick)** | `authenticate/route.ts` 87 (PATH B) / 255 (PATH A) — `deleteMany({employeeId})` inside the tx, **no row lock** |
| **Revoke (admin)** | `src/app/api/device-claims/[id]/revoke/route.ts` — claim→`revoked`, device→`inactive` + unbind; **tokens NOT deleted**, fail closed via device-status check |
| **Disconnect (admin)** | **Does not exist** — only `DELETE /api/devices/[id]` (`src/app/api/devices/[id]/route.ts` 82–103) |
| **Device delete** | No FK from AgentToken → tokens orphaned; fail closed (`auth.ts:137` `!device`), rows linger |
| **Employee disable** | `auth.ts:112` — fails closed at use; rows remain |
| **Account disable** | `auth.ts:119–126` — fails closed at use; rows remain |
| **Org disable** | **Not checked anywhere in validateAgentToken** — tokens keep validating |

## 5. Device lifecycle

```
(no row) → discover → Device(status 'online', employeeId null) + DeviceClaim PENDING
  → admin approve ([id]/approve) → Device employeeId bound, 'online', agentApproved=true,
    other employee devices → 'inactive'  (Employee FOR UPDATE — the ONLY locked tx today)
  → authenticate PATH A/B → AgentToken created, device 'online'
  → heartbeat → 'online' + lastHeartbeat
  → logout → token deleted — Device.status UNCHANGED (stale 'online')
  → admin revoke → 'inactive', unbound, claim 'revoked' (terminal)
  → admin DELETE → row + claims + activities + screenshots cascade-deleted
```

## 6. DeviceClaim lifecycle

`pending → approved | rejected | expired | cancelled | revoked` (revoke only from approved). `expiresAt` enforced at approve (`[id]/approve/route.ts:70–75`) and at discover (fresh claim issuance). Employee binds at approval; `approvedBy/approvedAt/rejectionReason/cancelledAt/…` preserved for history. Cross-org access → 404 (org-scoped `findFirst`).

## 7. Registration vs authentication vs connection model

The three planes are **already separable with existing fields** — and must stay separable:

| Plane | Authority | Fields |
|---|---|---|
| **Registration** | Device + DeviceClaim | `Device.agentKey` (unique), `DeviceClaim.status` (pending/approved/revoked/…) |
| **Authentication** | AgentToken | `AgentToken.token/deviceId/expiresAt` + validation predicate |
| **Connection health** | Heartbeat | `Device.status`, `Device.lastHeartbeat` — display/health only, **never authorization authority** |

`REGISTERED ≠ ACTIVE`: a registered device with no valid AgentToken is inactive even if `status='online'` (stale). The Active indicator must be computed as *"device holds the employee's sole valid AgentToken"*, not from `Device.status`.

## 8. Current single-device behavior

Partial — silent kick: `deleteMany({employeeId})` at each authenticate. Sequential: exactly one token per employee (last writer wins). **No 409 semantics. No lock.** Admin approve additionally deactivates the employee's other devices (`[id]/approve/route.ts:145–153`) with a proper Employee `FOR UPDATE` — this is the only race-safe single-device mechanism that exists, and it is approval-time only.

## 9. Multi-device behavior

- Sequentially: one device at a time (kick model). Employee cannot *choose* the active device.
- Concurrently: **both can win** (R1) → two valid tokens, two `online` devices, two successful responses. Confirmable from schema (no unique constraint) + transaction code (no lock).
- Displaced device auto-recovery (`auth-service.ts recover()` → re-auth) → **ping-pong war** (R2).

## 10. Concurrency risks (race-by-race audit)

| Race | Current | With recommended design |
|---|---|---|
| **PC-01 + Laptop-01 login, same employee, same moment** | RACE: both commit → 2 tokens, 2 successes | Both take `FOR UPDATE` on the same Employee row → serialized: first creates token; second **re-reads under lock**, sees a valid token on another device → `409 ACTIVE_DEVICE_EXISTS`. Exactly one success. |
| **Login + Logout** | Token exact-delete; if logout(device A) races login(B), B may see A's still-valid token → 409 → retry after A logs out. Deterministic per order; benign. | Same, now serialized on the Employee row; a 409 on retry resolves cleanly. |
| **Login + Admin disconnect** | Order-dependent: if disconnect commits first, login sees no token → activates (disconnect "lost" — admin disconnects again). | Same but deterministic per lock order. Documented, acceptable. |
| **Login + Device revoke** | Revoke flips claim→revoked + device→inactive (no employee lock). If login(B) commits before revoke, A's token fails closed at use. No corruption. | Unchanged; still safe. |
| **Login + Employee disable** | PATH B checks `status !== 'active'` pre-tx (route.ts:79–81); PATH A checks pre-tx (244–247). A disable landing between pre-check and tx commits would still mint a token (use-time check then rejects). | Re-check `employee.status` + `AgentAccount.status` **inside the locked tx** → fully deterministic. |
| **Login + Account disable** | PATH A does NOT check account at all today; PATH B neither. Token minted, then fails at validation. | Add account-status re-check inside the locked tx. |
| **Login + Token expiry** | Expired token is ignored as a blocker only if the predicate excludes expired tokens — today the single-active check does not exist. | The in-tx "valid token" lookup must filter `expiresAt > now`, so expiry can never block a new login and never counts as "another active device". |

## 11. Logout behavior

Current: revokes the exact AgentSession or AgentToken (idempotent), audits (`logout/route.ts:36–91`). Missing: `Device.status` transition. **Minimum safe transition:**

```
ACTIVE (valid token) → logout → delete token + device.status='offline' + lastHeartbeat=now + audit
```

- `offline`, **not** `inactive` — `inactive` is excluded by `validateAgentToken`'s device check (auth.ts:137) and would block re-login; `offline` keeps the device re-login-eligible.
- Registration, DeviceClaim history, Employee, AgentAccount: **untouched** (already true).
- Clearing heartbeat: unnecessary (no pre-approval gating on it); setting `lastHeartbeat=now` gives admins an accurate "last seen".

## 12. Admin disconnect/delete behavior

`DELETE /api/devices/[id]` (org-scoped RBAC, `devices/[id]/route.ts:82–103`) is **not appropriate** as the everyday lifecycle op: `onDelete: Cascade` removes DeviceClaim rows, all Activity rows, and all Screenshot rows (schema 234/516), orphaning monitoring history and claims history. Anomaly.deviceId is SetNull (safe). AgentTokens orphan (no FK) and fail closed.

Required: **new `POST /api/devices/[id]/disconnect`** — org-scoped admin action that: deletes tokens bound to the device, sets `status='offline'`, writes AuditLog; preserves registration/claims/history/ownership. Keep `DELETE` only as a deliberate, confirmed, separately-documented destructive op (with the cascade impact surfaced in UI), or remove it entirely if no consumer needs it.

## 13. Heartbeat behavior

`src/app/api/agent/heartbeat/route.ts`: token-validated, updates `device.status='online'`, `lastHeartbeat`, `ipAddress`. Interval server-driven (default 60s, clamp [10,600], `jobs/settings.ts:24`). **No offline-aging job exists** (`src/lib/jobs/run.ts` runs only `expire_consents` + `retention_cleanup`).

Answers: (1) "online" = "a valid token beat at some point"; (2) "active" = "holds the employee's current valid AgentToken"; (3) **Yes** — a device stays `online` forever after logout; (4) **No** — a stale online device without a valid token must NOT block another device (the single-active check inspects tokens, not status); (5) enforcement must **not** rely on heartbeat; (6) heartbeat = connection-health indicator only. (Optional, non-blocking: a future aging job could flip stale `online`→`offline` after N missed beats — display-only.)

## 14. Device deletion / cascade analysis

| Event | Cascade / effect |
|---|---|
| Device deleted | DeviceClaims (Cascade), Activities (Cascade), Screenshots (Cascade) removed; Anomalies keep row (SetNull); AgentTokens orphaned (no FK) → fail closed, rows linger ≤24h; AuditLog unaffected (string refs); Consent unaffected (employee-scoped) |
| Device revoked | Claim→`revoked`, device→`inactive`+unbound; tokens fail closed (not deleted) |
| Device disconnected (new) | Tokens deleted, device→`offline`, everything else preserved |
| Device reinstalled | Same `agentKey` (stable, `Device.agentKey` unique) → existing-device rediscovery per Phase 4 rules; new key → brand-new Device + PENDING claim |
| Same employee, another PC | New device row + claim; single-active rule governs activation |
| Same hostname reused | Legacy PATH B matches `(employeeId, hostname)` → **reuses** the existing device row (route.ts:96–98); PATH A/zero-touch never matches hostname |
| Delete device then rediscover | Fresh Device + fresh claim (history intentionally wiped by the delete) |

**Deleting a device destroys claims, activities and screenshots — this is why disconnect, not delete, is the default lifecycle operation.**

## 15. Security analysis

| Requirement | Status |
|---|---|
| Employee identity server-derived | ✓ `login` (AgentAccount → Employee), `discover` authenticated branch, PATH A (claim → device.employeeId) |
| Organization server-derived | ✓ everywhere except legacy PATH B (org comes from the password-authenticated employee — authenticated, not trusted) |
| Device ownership server-derived | ✓ device binding set at approve; PATH A uses claim.deviceId |
| Body cannot choose employee/org/owner | ✓ authenticated paths ignore body identity; PATH B authenticates employeeId via password |
| Cross-org device cannot activate | ✓ deviceId is unguessable cuid + claim secret required; org derived from the device's own row |
| Cross-employee device cannot activate | ✓ PATH A requires the claim's bound employee; Phase 4 404 rules |
| Revoked devices cannot activate | ✓ claim must be `approved` (PATH A 225–233); **gap:** PATH A never checks `device.status` — an `inactive` device with an approved claim can re-auth (defense-in-depth fix needed) |
| Disabled employees cannot activate | ✓ checked pre-tx (PATH A 244–247, PATH B 79–81); re-check inside locked tx recommended |
| Disabled AgentAccounts cannot activate | **GAP** — neither authenticate path checks `AgentAccount.status`; only token-use fails closed |
| Disabled orgs cannot activate | **GAP** — `validateAgentToken` has no `Organization.status` check (session.ts does, auth.ts does not) |

## 16. Compared implementation options

| Criterion | A: Employee lock + AgentToken inspect | B: Employee lock + Device status | C: Employee lock + "active token" flag | D: `Employee.activeDeviceId` | E: Partial unique index | F: App tx + DB constraint |
|---|---|---|---|---|---|---|
| Correctness | ✓ authority = credential | ✗ status is stale/not authoritative | = A (flag = derived token presence) | ✓ but duplicates derivable truth | ~ | ✓ |
| Race safety | ✓ FOR UPDATE serializes | ✓ but wrong signal | ✓ | ✓ | ✓ unique | ✓ |
| PostgreSQL | ✓ | ✓ | ✓ | ✓ | ✓ (raw SQL `WHERE status='active'` partial unique on employeeId) | ✓ |
| Prisma compat | ✓ | ✓ | ✓ | ✓ (schema field + migration) | ✗ partial unique not expressible in Prisma schema | ✗ same |
| Migration | **none** | none | none | 1 (add field + backfill) | **1** (raw SQL) | 1+ |
| Complexity | low (mirrors approve route) | low | low | medium (maintain flag, backfill, drift) | low (but schema-file divergence) | medium |
| Failure behavior | 409, no kick, no mutation | could 409 while another valid token exists on a stale-online device ✗ | same as A | drift risk if flag desyncs | constraint violation → 500 unless mapped; no audit context | 500 unless mapped |
| Stale-token handling | expiry filter in lookup | n/a | must still consult tokens | n/a | constraint ignores expired (partial index can't express time) | partial index can't express time |
| Logout behavior | token delete → slot free | needs status flip + still ambiguous | same as A | must clear activeDeviceId | free | free |
| Admin disconnect | token delete → slot free | ambiguous | same as A | must clear field | free | free |

**Recommendation: OPTION A.** It is the only option that is race-safe, authoritative (credential-based), migration-free, Prisma-idiomatic, and exactly matches the approved product behavior (409, no kick). Options B/D misplace authority; E/F would require a migration and still cannot express time-relative predicates, so the application check would be needed anyway — a constraint would add no enforcement value over the lock.

## 17. Recommended architecture (for STEP 3)

```
POST /api/agent/authenticate (PATH A + PATH B share one code path)

  pre-checks (outside tx): credentials / claim+secret · employee exists+active
                           · AgentAccount active · (PATH A: device.status check)

  db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${employeeId} FOR UPDATE`;
    // re-check employee.active + account.active under the lock
    const active = await tx.agentToken.findFirst({
      where: { employeeId, expiresAt: { gt: new Date() } },
      select: { deviceId: true },
      orderBy: { createdAt: 'desc' },
    });
    if (active && active.deviceId && active.deviceId !== requestingDeviceId) {
      throw new ACTIVE_DEVICE_EXISTS();        // → 409, NO mutation, NO kick
    }
    if (active && active.deviceId === requestingDeviceId) {
      await tx.agentToken.delete({ where: { id: active.id } });  // re-login: replace
    }
    // existing behavior: bind/update device, create token, audit
  })

  on ACTIVE_DEVICE_EXISTS → 409 { error: 'ACTIVE_DEVICE_EXISTS' }  // safe fields only
```

Concurrency model: exactly the pattern already proven in `[id]/approve/route.ts:122` — same query, same isolation guarantees. Under the lock, the "valid token on another device" predicate is race-free; the second login deterministically sees the first's committed token.

## 18. Exact transaction strategy

1. **Lock order:** Employee row (single lock point — all competing writers, including admin approve/disconnect, use the same row).
2. **Predicate:** `agentToken.findFirst({ employeeId, expiresAt > now })` — expiry-aware, so stale/expired tokens never block and never falsely trigger 409.
3. **Same-device rule:** existing token on the *same* device → delete + re-issue (re-login works); token on *another* device → 409.
4. **Guarded mutations:** re-verify `employee.status`, `AgentAccount.status`, and (PATH A) `device.status` *inside* the tx before creating the token.
5. **Audit:** `login` audit inside the same tx (as today); `409` outcomes audited as `login_denied` with `reason=active_device_exists` (safe fields only).
6. **Rollback:** any failure inside the tx aborts everything — no token, no status change, no partial state (matches the existing `$transaction` semantics in authenticate/approve).

## 19. Migration requirement

**A — NO MIGRATION REQUIRED.**

Existing columns suffice: `AgentToken.token/employeeId/deviceId/expiresAt` (authority), `Employee.id` (lock point), `Device.status/lastHeartbeat` (health display), `DeviceClaim.status` (registration plane). No new field, index, enum, or constraint. STEP 3's design must therefore stay within this schema; any proposal requiring a schema change should be rejected.

## 20. Exact files STEP 3 would touch (implementation phases)

| File | Change |
|---|---|
| `src/app/api/agent/authenticate/route.ts` | unify PATH A/B token issuance; Employee FOR UPDATE; 409 check; in-tx status re-checks; PATH A device.status check |
| `src/app/api/agent/logout/route.ts` | set `device.status='offline'` (+ lastHeartbeat) when an AgentToken is revoked |
| `src/lib/agent/auth.ts` | optional shared helper for the locked single-active predicate; add `Organization.status` check to `validateAgentToken` |
| `src/app/api/devices/[id]/route.ts` or new `src/app/api/devices/[id]/disconnect/route.ts` | admin disconnect: token delete + offline + audit, org-scoped RBAC |
| `src/components/devices/*` | status vocabulary (Registered/Active/Inactive…), Last login (from AuditLog), Active indicator, Disconnect action, DELETE confirmation/cascade warning |
| `src/components/agent-approvals/agent-approvals-page.tsx` | consistent status labels |
| `desktop-agent/src/api/device.ts` | 409 typing |
| `desktop-agent/src/auth/auth-service.ts` | `active_device_exists` phase; no auto-retry into 409 (no kick-war) |
| `desktop-agent/src/services/agent-orchestrator.ts` | surface ACTIVE_DEVICE_EXISTS; suppress ping-pong recovery |
| `desktop-agent/src/renderer/**` | distinct "already active on another device" screen |
| `tests/agent-single-active-device.test.ts` | NEW suite (AD-01…AD-28, throwaway PostgreSQL) |

## 21. Tests required for STEP 3

AD-01..AD-28 as specified in the phase brief (multi-device, first/second login, logout→re-login, concurrent race → exactly one active, cross-employee/org, forged-identity rejection, revoked/disabled/expired fail-closed, idempotent logout, admin disconnect RBAC + preservation + revocation, no passwordHash/token/secret leaks, zero-touch/pending/consent/org-isolation/claim-history regressions, concurrent logout/login race). Plus: 409 body shape, 409 on stale-online device without token (must NOT 409), same-device re-login after logout, in-tx employee/account disable race.

## 22. Risks and mitigations

| Risk | Mitigation |
|---|---|
| R1 double-activation race | Employee FOR UPDATE at authenticate (mirrors approve) |
| R2 ping-pong kick war | 409 semantics + desktop maps it to a terminal user-facing state, no auto-retry |
| R3 admin deactivation undone by re-auth | 409 prevents re-auth while another device holds the token |
| R4 stale `online` misleads admin | Active indicator derived from token presence, not status; optional future aging job (display-only) |
| R5 PATH A re-auth of inactive device | add `device.status` check in PATH A |
| R6 disabled account/org token issuance | in-tx account check; org check added to validateAgentToken |
| R7 DELETE destroys history | disconnect = default op; DELETE guarded + confirmed + cascade impact documented in UI |
| R8 legacy PATH B hostname device-reuse | unchanged (out of scope); single-active still applies to its token issuance |

---

```
STEP:   2 — Database / Device Lifecycle Audit
STATUS: COMPLETE (read-only)

Files inspected:
  prisma/schema.prisma (full, 821 lines)
  src/app/api/agent/authenticate/route.ts · logout/route.ts · heartbeat/route.ts
  src/app/api/device-claims/[id]/{approve,revoke}/route.ts
  src/app/api/devices/{route,[id]/route}
  src/lib/agent/auth.ts · src/lib/agent/session.ts
  src/lib/jobs/{run.ts,retention.ts,expire-consents.ts,settings.ts}
  desktop-agent/src/auth/auth-service.ts · services/agent-orchestrator.ts
  workload/70-Agent-Device-Lifecycle-Audit.md

Files modified:   none
Files created:    workload/71-Agent-Database-Device-Lifecycle-Audit.md

Migration required:
  NO — existing AgentToken/Device/Employee columns + Employee row lock express
  "many registered devices, max one active" without schema changes.

Recommended architecture:
  OPTION A — Employee FOR UPDATE → inspect existing valid AgentToken (expiry-
  aware) → another device ⇒ 409 ACTIVE_DEVICE_EXISTS (no kick, no mutation);
  same device ⇒ delete + re-issue; guarded in-tx re-checks (employee/account/
  device status). Plus: logout sets device 'offline'; admin disconnect endpoint;
  Active indicator derived from token presence; PATH A device-status check;
  Organization.status added to validateAgentToken.

Critical findings:
  1. Schema has NO uniqueness on AgentToken.employeeId/deviceId — application
     enforcement mandatory; no migration can express time-relative predicates.
  2. authenticate runs deleteMany+create with NO employee row lock → confirmed
     concurrent double-activation race (R1).
  3. Logout never transitions Device.status → stale 'online' forever; no aging job.
  4. DELETE /api/devices/[id] cascades DeviceClaims+Activities+Screenshots —
     disconnect must be a separate history-preserving operation.
  5. validateAgentToken lacks Organization.status check; PATH A authenticate
     lacks AgentAccount.status and Device.status checks (fail-closed gaps).

Tests:
  NOT RUN — READ ONLY

Regression:
  NOT RUN — NO CODE CHANGED

Next step:
  STEP 3 — Single-Active-Device Design
```
