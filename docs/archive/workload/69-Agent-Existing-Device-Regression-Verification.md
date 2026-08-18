# Phase 4 — Existing-Device Rediscovery Regression & Extended Verification

> **Scope:** TEST + VERIFICATION ONLY. No production source code modified in this phase.
> **Date:** 2026-08-11
> **Predecessor:** `workload/68-Agent-Existing-Device-Security-Hardening.md` (Phase 3, complete).
> **Status:** ✅ All verification gates PASS.

---

## 1. Scope

Prove that the Phase 3 existing-device authorization hardening did not regress any agent/device/claim flow, and that the security properties hold under full regression. Per the phase mandate, the only files touched are documentation: `workload/69-Agent-Existing-Device-Regression-Verification.md` (this file).

## 2. Previous hardening summary

`src/app/api/agent/discover/route.ts` now enforces, inside the existing `SELECT ... FOR UPDATE` device-row transaction and against a **fresh re-read of the locked row**:

- Rule B — wrong employee → uniform 404
- Rule C — wrong organization → uniform 404
- Rule D — unassigned device bound only to the session employee/org (transactional)
- Rule E — revoked devices terminal, never rebound
- Rule F — request-body identity fields ignored (never read)
- Rule G — authorization against the freshly locked row (TOCTOU-safe)
- Rule H — anonymous zero-touch unchanged (authz block skipped when no session)

Rule A (session authoritative) is the foundation of B–G.

## 3. Targeted test result

```
npx tsx --test tests/agent-existing-device-security.test.ts
tests 21 | pass 21 | fail 0 | skipped 0
```

All AUTH-EXIST-01..25 cases pass (EX-18..23 grouped, EX-17 split 17a/17b).

## 4. Full backend result

```
npx tsx --test tests/*.test.ts
tests 281 | pass 281 | fail 0
```

Baseline 260 + 21 new = **281/281 PASS**, identical to Phase 3. Suites verified green: agent authentication (agent-auth-login), agent account (agent-account, agent-account-admin), existing-device security (new), device claims (claim-cancel), zero-touch (zero-touch), consent, projects, security, multi-org isolation, screenshots, health, super-admin, employee API, organization bootstrap.

## 5. Desktop result

```
npm run test:src                      (desktop-agent)
tests 134 | pass 134 | fail 0
```

Covers login UI, session persistence, logout, discover, pending, cancel, re-discover, approved/connected, reconnect, zero-control renderer, no self-registration, no server-URL editing. **Desktop agent not modified.**

## 6. Admin result

- `npx tsc --noEmit` → **PASS**
- `npx next build` → **PASS** (proxy middleware route listing complete, no errors)

Claim management API surface (approve/reject/cancel/revoke) exercised end-to-end in the green backend suites (AUTH-21 cross-org approval denial, ZT approvals, claim-cancel lifecycle, AUTH-EXIST-06/10/12). Cross-org device invisibility enforced at the API layer by `requireAdminOrg` + org-scoped claim lookup (approve/reject/revoke) and verified by tests.

## 7. PostgreSQL result

- All backend suites ran against throwaway PostgreSQL databases (`workai_test_agentauth`, `workai_test_agexist`, and the other suites' PG test DBs) via `scripts/pg-test-db.mjs` — **no SQLite anywhere**.
- `git diff prisma` → empty → **no migration required**; existing schema sufficient.
- Device ownership consistency + DeviceClaim history verified: AUTH-EXIST-15 (all claims stay in device org), AUTH-EXIST-06 (claim count frozen after revoke), ZT-27 (one active device per employee — no duplicate active ownership).

## 8. Zero-touch result (STEP 9)

Anonymous flow verified end-to-end in `zero-touch.test.ts` (29 tests) + AUTH-EXIST-09/10: anonymous discover → device created → employee unassigned → PENDING claim → admin approval → employee assignment → device online → PATH A AgentToken → connected. The authenticated authz block is skipped entirely when `validateAgentSession` yields no session (`authenticatedEmployee === null`), so the hardening does not apply to anonymous requests.

## 9. Re-registration result (STEP 10)

- PENDING → CANCEL → new discover → fresh PENDING: AUTH-EXIST-13 + claim-cancel suite ✅
- PENDING → ADMIN REJECT → reRegister → fresh PENDING per existing rules (poll without intent surfaces `rejected`): AUTH-EXIST-12 ✅
- Expired claim → discover → fresh claim (old closed to `expired`, history preserved): AUTH-EXIST-14 ✅
- No duplicate active claim: FOR UPDATE serialization + AUTH-EXIST-17a (single pending claim after concurrent rediscovery) ✅

## 10. Cross-employee result

AUTH-EXIST-02/16: same-org wrong employee → 404, device never rebound, ownership preserved. ✅

## 11. Cross-org result

AUTH-EXIST-03/15: different org → 404, no claim created in the target org, all existing claims stay in the device org. Admin-side cross-org approval also denied (AUTH-21). ✅

## 12. Concurrency result

AUTH-EXIST-17a (same employee, concurrent) → single claim, same claimId. AUTH-EXIST-17b (two employees racing on one unassigned device) → exactly one success + one 404, device bound to exactly one employee, exactly one claim. ZT-27 concurrently approves two devices for one employee → one active device. ✅

## 13. TOCTOU verification (STEP 8)

Transaction order in `discover/route.ts` (verified line-by-line):

```
188  SELECT ... FOR UPDATE          ← row lock acquired FIRST
194  fresh re-read (locked row)     ← stale pre-lock snapshot discarded
210  authorization (Rules B/C/D/E)  ← against locked row
236  claim state evaluation         ← against locked row
268  claim/bind mutation            ← same transaction, still locked
```

There is **no** unlocked-authorization-then-locked-mutation sequence; the pre-transaction `findFirst` is used only to decide the new-device vs existing-device branch and to obtain the row id for locking. TOCTOU cannot be reintroduced. ✅

## 14. Security scan (STEP 12)

Scanned `discover/route.ts`, `login/route.ts`, `logout/route.ts`, `session.ts`, `agent/auth.ts`, `agent-account.ts` for `console.log/warn`, `password`, `token`, `secret`, bypass headers (`x-agent`, `debug`, `bypass`):

- No `console.log` / `console.warn` in any of the six files. Only `console.error` in the discover catch for unexpected 500s (pre-existing).
- No password/passwordHash logging; `toPublicAccount` strips the hash at every boundary (agent-account.ts:59/151/268).
- Raw tokens never logged — session.ts:43 invariant; login logs only an employeeId slice + IP; logout logs employeeId slice + IP.
- Claim secrets only ever returned to the owning agent in responses (discover/route.ts:176/361), never logged.
- No bypass headers, no debug authentication path, no client-supplied org/employee identity trusted (body destructures only `deviceKey/hostname/os/osVersion/processor/memory/agentVersion/arch/reRegister`). ✅

## 15. Build verification (STEP 13)

| Command | Result |
|---|---|
| `npx tsx --test tests/agent-existing-device-security.test.ts` | 21/21 PASS |
| `npx tsx --test tests/*.test.ts` | 281/281 PASS |
| `npm run test:src` (desktop-agent) | 134/134 PASS |
| `npx tsc --noEmit` (admin) | PASS |
| `npx next build` (admin) | PASS |

All commands actually completed with the recorded results.

## 16. Residual risks

1. Status-code distinguishability: valid session + unknown key → 201 vs existing key owned elsewhere → 404 (existence-only; no content leak). Accepted per the 404 concealment requirement.
2. Approved-but-inactive (replaced) device still returns `approved` from discover; `validateAgentToken` continues to fail closed (device status check) — unchanged, consistent with the current design; no security vulnerability demonstrated.
3. Legacy PATH B (`/api/agent/authenticate` + `Employee.agentPassword`) — pre-existing, unchanged, out of scope.
4. Desktop UX on 404 denial (reused laptop bound to a departed employee) — surfaces as discover error until admin revokes/unbinds; intended fail-closed.

## 17. Final verdict

**PASS** — the Phase 3 hardening introduces zero regressions across all 19 protected flows; all security properties hold under full regression. This phase certifies only existing-device rediscovery regression/security behavior; it is not a production-readiness statement.

---

*Phase 4 complete — STOP per the strict stop rule. Phase 5 not started.*
