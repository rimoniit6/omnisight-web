# M005 Stage-6 — E16 Agent Token Rotation — Implementation Report

> **Scope:** `POST /api/agent/v1/token/rotate` — seamless agent-token rotation with a 60-second grace window for the old token. Reuses `AgentCredential` (single-row dual-token model, contract §2.5). No screenshots, commands, updates, analytics, OCR, AI, or rate limiting.

---

## 1. Files changed

| File | Change |
|---|---|
| `src/app/api/agent/v1/token/rotate/route.ts` | **NEW** — E16 endpoint: `authenticateAgentRequest` (`requireAssignment`, no `allowPending`) → old-token rotation rejected → zod `tokenRotationSchema` → `rotateAgentToken` → `{ token, expiresAt, graceUntil, serverTime }` |
| `src/lib/agent.ts` | **MODIFIED** — +`rotateAgentToken()` (one-transaction rotation; verifies device/installation/assignment/credential-not-revoked, generates 256-bit token, moves `tokenHash→prevTokenHash`, sets `rotatedAt`/`issuedAt`/`expiresAt`) |
| `src/lib/agent-auth/context.ts` | **MODIFIED** — +`resolveValidCredential()` (dual-token: current | grace), `CredentialMatch`, `credentialMatch` on resolved context, `authenticatedByCurrentToken` on authenticated request; `resolveAgentContext` now delegates to it |
| `src/lib/agent-auth/loaders.ts` | **MODIFIED** — `loadCredentialByTokenHash` → `findFirst` OR-match `tokenHash \| prevTokenHash` (deterministic, most-recent row) |
| `src/lib/agent-auth/schemas.ts` | **MODIFIED** — +`tokenRotationSchema { clientTime }` |
| `scripts/verify-e16.mjs` | **NEW** — live E16 verification, **63 checks** |

**No migration** — `AgentCredential.prevTokenHash / rotatedAt / issuedAt / revokeReason` were designed in M003 and already present (verified via `PRAGMA table_info`).

## 2. Rotation algorithm

`POST /api/agent/v1/token/rotate` — body `{ clientTime }` only; server-authoritative. Inside **one Prisma transaction** (`rotateAgentToken`):

1. Load device (missing → 401 `AGENT_DEVICE_NOT_FOUND`).
2. Verify installation active (defense-in-depth; verifier also checks).
3. Verify device not `Retired`/`Suspended` (→ 403 `AGENT_DEVICE_REVOKED`).
4. Verify an **active `DeviceAssignment`** exists (→ 403 `AGENT_DEVICE_UNASSIGNED` — rotation is part of the authorized data plane).
5. Load current credential; **re-verify it is not revoked** (mission step 2; closes the TOCTOU window).
6. Generate a fresh 256-bit token (`createToken` → base64url 43 chars).
7. Hash with SHA-256 (only the hash is ever stored — ADR-011).
8. In-place update: `tokenHash ← new hash`, `prevTokenHash ← old tokenHash`, `rotatedAt ← now`, `issuedAt ← now`, `expiresAt ← now + 180 d`.
9. Commit. Return plaintext exactly once.

## 3. Credential lifecycle

```
E1 register  → AgentCredential(tokenHash, prev=null, rotatedAt=null)
E16 rotate   → tokenHash=H(new), prevTokenHash=H(old), rotatedAt=now
   old token valid ≤ 60 s from rotatedAt (grace, in-flight requests)
   new token valid immediately (until expiresAt)
E16 rotate again → tokenHash=H(newer), prevTokenHash=H(new), rotatedAt=now
   2-back token dropped entirely (matches neither hash → AGENT_UNAUTHORIZED)
Admin suspend/retire → Device.status → 403 AGENT_DEVICE_REVOKED (all tokens dead)
```

Repeated rotation keeps only the immediately-previous token in grace (contract §2.5 lists a single `prevTokenHash`).

## 4. Grace window behavior

- **New token → valid immediately** (verified: heartbeat → 200 right after rotation).
- **Old token → valid during the 60 s grace** measured from `rotatedAt` (verified: heartbeat → 200).
- **Old token after 60 s → `401 AGENT_TOKEN_EXPIRED`** (verified by shifting `rotatedAt` 61 s into the past — deterministic, no ambiguity).
- **Token 2 rotations back → `401 AGENT_UNAUTHORIZED`** (matches neither stored hash — dropped).
- **Old token cannot rotate** — the route rejects grace-authenticated rotation with `401 AGENT_TOKEN_EXPIRED` (`authenticatedByCurrentToken` gate): a captured old token can never mint a fresh one.

## 5. Verifier changes

- **`resolveValidCredential(loaders, tokenHash, now)`** — the single dual-token resolution (mission's "resolveValidCredential() or equivalent"): revoked/expired → `AGENT_TOKEN_EXPIRED`; `tokenHash` match → current (valid); `prevTokenHash` match → grace iff `now ≤ rotatedAt + 60 s` else `AGENT_TOKEN_EXPIRED`; neither → `AGENT_UNAUTHORIZED`.
- **Deterministic lookup** — `prevTokenHash` was previously a unique `tokenHash`, so a presented token can match at most one row; the loader `findFirst`s with `orderBy updatedAt desc` for the single-row model.
- **`storedTokenHash` is the matched half** — the HMAC compare uses `tokenHash` for current and `prevTokenHash` for grace (never the wrong half of the pair).
- Replay/nonce/clock/signature checks are unchanged — rotation rides the exact same composed pipeline.

## 6. Verification

**`verify-e16.mjs` 63/63 live** — normal rotation · new-token-works-immediately · old-token-grace-works · repeated rotation (2-back dropped) · grace expiry (shifted `rotatedAt`) · expired token · revoked token · disabled installation · suspended device · **assignment required** (403 UNASSIGNED, E2 re-activates) · **old-token rotation rejected** (401) · replay nonce → 409 (same nonce on rotate AND on heartbeat) · response DTO audit (exactly `token/expiresAt/graceUntil/serverTime`) · **transaction rollback** (mid-tx failure → hash unchanged, token still authenticates) · **concurrent rotations** (both 200, distinct tokens; one stored current + one riding grace; pre-race token superseded; both live tokens authenticate; self-heal rotation works) · pending-device gate (403 PENDING before activation, 200 after) · **hash-at-rest proof** (no stored column equals any plaintext; all stored hashes are 64-char sha256 hex).

**Full live regression:** E2 **53/53** · E1 **23/23** · E3 **32/32** · E5 **46/46** — the Register → Activate → Heartbeat → Activity flow is unchanged. E0 **107/107** · S2 **30/30** · `prisma validate` ✅ · `tsc` 0 errors · `eslint` clean · **`npm run build` ✅** (`ƒ /api/agent/v1/token/rotate` in manifest; standalone assets copied). DB clean post-run (10 demo devices, 0 test rows).

## 7. Security review

- **No plaintext ever persisted** — SHA-256 only (ADR-011); hash-at-rest proven by test.
- **Old-token rotation blocked** — a captured grace token cannot self-rotate; it only rides the 60 s window for in-flight data requests, then dies (`AGENT_TOKEN_EXPIRED`).
- **TOCTOU closed** — the service re-verifies the credential is not revoked inside the same transaction as the update.
- **Concurrent-rotation race is self-healing** — last-writer-wins; the agent's next `401 AGENT_TOKEN_EXPIRED` triggers one rotation retry with its stored current token (contract §2.6).
- **No token/hash/signature/nonce logging** — rotate logs device/credential/assignment IDs only.

## 8. Risks

- **`prevTokenHash` persists after grace expiry** (never cleared). A captured old token keeps returning `AGENT_TOKEN_EXPIRED` (not `AGENT_UNAUTHORIZED`) indefinitely — a mild error-code oracle. Not exploitable (route gate blocks old-token rotation); a lazy cleanup (clear `prevTokenHash` once grace passes) is future work.
- **Concurrent rotations** can transiently drop one just-minted token (last-writer-wins); the agent self-heals via the contract's rotate-once rule. Verified, documented.
- **Rotation is not rate-limited yet** (E16 limit pending the centralized per-device limiter — planned next).

## 9. Rollback

- Code: revert the 5 touched files (delete the rotate route + `rotateAgentToken` + `resolveValidCredential` dual-token path, restoring `loadCredentialByTokenHash` to `findUnique({ tokenHash })`).
- DB: none — no migration was added; existing `prevTokenHash/rotatedAt` columns are simply unused if code is reverted.
- Test rows are self-cleaning; demo data untouched.

## 10. Git commit message

```
feat(agent): E16 token rotation — 60s dual-token grace on AgentCredential (M005 Stage-6)

- POST /api/agent/v1/token/rotate: one-tx rotation (tokenHash→prevTokenHash,
  rotatedAt/issuedAt/expiresAt); plaintext returned once, sha256 stored only
- Verifier: resolveValidCredential dual-token (current | grace ≤60s from
  rotatedAt; after → AGENT_TOKEN_EXPIRED); deterministic OR-match loader
- Old-token rotation rejected (authenticatedByCurrentToken gate); replay/nonce
  unchanged; assignment required (data-plane gate); TOCTOU revoked re-check
- verify-e16.mjs 63/63 live (rotation, repeat, grace works/expiry, revoked/
  expired/disabled/suspended, assignment gate, replay, rollback, concurrent
  race, hash-at-rest) · E1 23/23 · E2 53/53 · E3 32/32 · E5 46/46 · build ✅
```
