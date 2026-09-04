# V1 SECURITY CERTIFICATION

## 1. Authentication / Sessions

| Item | Evidence | Verdict |
|---|---|---|
| Password hashing | `bcrypt.hash(password, 12)` (`src/lib/auth.ts`); agent accounts use per-account lockout + hashed credentials | PASS |
| JWT signing/validation | HS256, HMAC verified; session-aware `sessionId` on web tokens; realtime re-verifies signature + session row | PASS |
| Cookie flags | `httpOnly: true`, `sameSite: 'lax'` (`src/lib/auth.ts`); Secure flag deployment-dependent (HTTPS required) — env NOT VERIFIED | PASS (code) |
| Session revocation | `UserSession.revokedAt` checked by HTTP auth and the realtime handshake (fail closed) | PASS |
| CSRF | proxy rejects cross-origin state-changing requests (origin vs host); SameSite=lax | PASS |
| Replay resistance | short-lived JWTs + session row revocation; agent tokens per-device with expiry + sweep | PASS |
| Secrets in source | git scan (keys/private-key/api-key patterns) → no matches; `.env` untracked; `.env.example` placeholders | PASS |

## 2. Authorization / RBAC

Verified server-enforced for: user/member management, organizations,
policies, monitoring settings, screenshots, activity, location, USB,
devices, claims, commands, alerts, notifications, anomalies, category rules,
alert rules, reports, exports, AI config, projects, time entries,
organization switching, super-admin selected-org context.

- Helpers `requireSessionOrg` / `requireManagerOrg` / `requireAdminOrg` /
  `hasRolePermission` derive org + role from the verified session only.
- Cross-org resource ids 404 (existence concealed) — verified in
  category-rules, alert-rules, anomalies, screenshots, claims suites.
- UI hiding is never the enforcement point (server checks in every route).

## 3. Tenant Isolation (data paths audited)

Activity, screenshots (+ thumbnails), keyboard aggregates, location, USB,
devices, claims, users/members, projects, time entries, WorkDaySummary,
ActivityBatchReceipt, CategoryRule, AlertRule(+Firing), Alert, Notification,
Anomaly, PolicyViolation, app-policy entries, break sessions, audio
recordings, webcam sessions, exports/reports: every query carries the
session/device org, and client body ids are re-scoped in SQL
(`{ id, organizationId }`). Object-storage keys embed the org segment and are
constructed server-side only. Realtime rooms key on the verified token org;
every broadcast targets the row's org room.

No client-supplied `organizationId`/`employeeId`/`deviceId` is used as an
authorization authority anywhere (grep + route-by-route audit).

## 4. Agent security

Device claims (one-time secret, hash-only), approval binding, per-device
agent tokens with expiry + org scope, token sweeps, per-device sessions,
heartbeat/device integrity, no raw keystrokes stored (aggregate counts
only), domain-only website telemetry, coordinates-only location, encrypted
local spool, screenshot magic-byte + MIME validation and per-request size
caps. Suite evidence: agent-cross-org-attack, agent-auth-login,
claim-cancel, agent-token-sweep, device-integrity, agent-hardening.

## 5. Realtime security

Handshake: JWT (`auth.token` or httpOnly cookie) → signature (timing-safe) →
expiry → session row (non-revoked, unexpired) → org presence. Client cannot
select org or join another org's room (server joins only). Service never
writes; events are DB-derived and org-scoped; payloads are identifiers/
metadata only — no screenshot binaries, no coordinates, no secrets, no
sensitive raw telemetry. Live probe 6/6 (no/garbage/forged/unknown-session →
unauthorized; valid → org handshake). Reconnect re-authenticates; an
`unauthorized` disconnect stops retries.

## 6. Rate limiting

Shared PostgreSQL token bucket, single atomic UPSERT, sliding refill,
fail-closed security prefixes (login, agent auth/login/register/discover,
org create, claims, agent-account writes, AI test), stale-row sweep, client
IP resolved from the proxy-appended XFF tail / x-real-ip (attacker-prepended
entries ignored). Adjudicated gap (agent-write endpoints) = WARN, not FAIL
(see V1-FINAL-CERTIFICATION-AUDIT.md).

## 7. No fake/random metrics

`Math.random` in production source appears only in comments documenting its
absence; dashboard/productivity values derive from stored classification,
summaries and real telemetry (dashboard-consumer proves byte-exact
equivalence).

## Security verdicts by area

Security: **PASS** · Tenant Isolation: **PASS** · Authentication/RBAC:
**PASS** · Realtime: **PASS** · Rate Limits: **PASS with WARN note** ·
Privacy boundaries: **PASS**

**Blockers: none.** Forged/unauthorized realtime access, cross-tenant access,
privilege escalation, secret exposure, and fake metrics were each tested for
and not found.
