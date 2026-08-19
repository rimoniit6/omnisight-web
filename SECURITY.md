# OmniSight — Security

> Previously branded as **WorkLensAI** — legacy identifiers are intentionally preserved.

Describes the security posture of the implementation, with exact mechanisms and their locations.

Related docs: [API.md](./API.md) · [PRIVACY.md](./PRIVACY.md) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [PRODUCTION.md](./PRODUCTION.md) (Phase 3 hardening checklist)

---

## 1. Authentication

**Web/admin (JWT)**

- HS256 via Web Crypto (`crypto.subtle`), **no external JWT library** (`src/lib/jwt.ts`).
- Token claims: `sub` (userId), `role`, `org` (organizationId), `exp`, `iat`.
- Verification: exact algorithm check (`HS256` only), signature, expiry (`Math.floor(Date.now()/1000) >= payload.exp` → 401), and on refresh the current role/org are re-issued from the database.
- **Server-authoritative session revocation**: every login creates a `UserSession` row; the JWT carries `sessionId` and every authenticated request (proxy + handler) re-validates the row (not revoked, not expired). Logout revokes the row, `/api/auth/sessions/revoke-all` revokes every session, admins can force-logout a user (`/api/auth/users/[id]/revoke-sessions`), account disable revokes all sessions, and password change revokes every OTHER session. Revoked/expired tokens get a uniform 401.
- Transport: `worklens_token` httpOnly session cookie (and `Authorization: Bearer`). **Never** stored in localStorage; the client keeps the token in memory only and re-hydrates via `GET /api/auth/me` on reload.
- Password hashing: bcryptjs, cost 12. Login failures return a uniform 401 ("Invalid email or password") — no account enumeration. Account status `deactivated` → 401. `GET /api/auth/users` and `/api/auth/me` never return hashes.

**Agent**

- `AgentSession` (24 h) for discovery/login/logout; `AgentToken` (24 h, device-bound) for telemetry — both 64-character opaque random values stored SHA-256-hashed.
- Agent passwords: `AgentAccount` (bcrypt) or legacy `Employee.agentPassword`; ≥ 12 chars with upper+lower+digit enforced for new passwords. 5 failed logins → 15-minute lockout.
- Claim secrets are one-time, SHA-256-hashed, 409 on reuse/expiry.

## 2. Authorization (RBAC)

- Roles: `super_admin` > `owner` > `admin` > `manager` > `viewer`; unknown → level 0 (denied). Levels live in `src/lib/roles.ts`.
- **Two layers**: (1) proxy prefix rules (`ROLE_RULES` in `src/proxy.ts` — e.g. `/api/settings`, `/api/auth/users`, `/api/agent-registrations` → admin+; `/api/export`, `/api/audit-logs`, `/api/self`, `/api/consent` → manager+); (2) per-route helpers `requireSessionOrg / requireManagerOrg / requireAdminOrg / requireSuperAdmin` (`src/lib/api.ts`). Every consent read (`/api/consent`, `/summary`, `/logs`, `/policies`) and the audit-log list + export enforce manager+ in the handler too — never proxy-only.
- Operations check granular permissions (e.g. viewer may view but not create; only `super_admin` may create `super_admin` users; break toggling requires admin+).

## 3. Tenant isolation (multi-org)

- `organizationId` is **always** derived from the verified JWT — client-supplied `organizationId` is ignored.
- Cross-org reads → **404** (concealment — no existence leakage); cross-org write references → **422**.
- Verified by `tests/multi-org-isolation.test.ts`.

## 4. API hardening (`src/proxy.ts`)

- **Rate limiting**: in-memory sliding window per route-group (full table in [API.md](./API.md) §0) — login 10/5min, agent auth 20/min, AI write 10/min, analytics read 60/min, heartbeat 600/min, webcam frames 900/min, etc. 429 with `Retry-After` headers. **Note:** in-memory → per-process; fine for single instance (Caddy topology), not for multi-instance clusters.
- **CSRF**: non-GET/HEAD/OPTIONS requests carrying an `Origin` header must match `Host` → else 403.
- **Secrets**: never logged (structured logger with redaction).
- **Agent 404 vs 401**: unknown agent auth → 404 to avoid leaking device/employee existence.

## 5. AI security (`src/lib/ai-insights/`)

- **BYOK only** — keys supplied by the operator, encrypted at rest (AES-256-GCM, `ENCRYPTION_KEY`), never returned by the API (`REDACTED`).
- **SSRF guard**: `safeFetch` — allowlisted HTTPS origins (api.openai.com, api.anthropic.com, generativelanguage.googleapis.com, api.mistral.ai, api.groq.com) **or** loopback for Ollama; requires `https` (except loopback); certificate validation on; no redirects; 10 MB response cap; 30 s timeout; fetches that follow redirects to disallowed hosts fail.
- **Schema enforcement**: every AI response passes `z.strictObject` validation — unknown fields → rejected. AI-provided values must match the measured dataset (evidence matching); a hallucinated field is rejected, never stored.
- Analysis is **on-demand only** — no scheduled/silent AI. Screenshot analysis is admin+.

## 6. Agent security

- Native addon (N-API) runs in-process; collectors **fail closed** — a missing/incompatible addon means "not available", never fake data.
- `worklens_capture.node` is a C++ addon (C++17, MSVC v143, SDK 10.0.26100); the agent refuses to start without required modules when configured.
- Tray has no "Quit" item — agent lifecycle is admin-controlled.
- Update service: only downloads from an HTTPS feed URL (`WL_UPDATE_URL`); auto-update disabled when unset.

## 7. Transport & headers

- `next.config.ts`: strict CSP (all self, WebSocket wss, blob), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, HSTS, `Referrer-Policy`, `Permissions-Policy` (denies camera/mic/geolocation in the web app).
- Deployments should terminate TLS at the edge (Caddy config in repo) — the app itself serves HTTP.

## 8. Data at rest

- Passwords: bcrypt (cost 12). Agent/claim secrets: SHA-256. AI keys: AES-256-GCM (`ENCRYPTION_KEY` must be a 32-byte key encoded base64).
- Files (`uploads/screenshots`): outside the web root; served by authenticated route handlers with `nosniff`, cross-org → 404.
- Screenshots: validated PNG/JPEG/WebP (magic bytes, ≤ 5 MB); agent spool encrypted at rest.

## 9. Audit logging

- `AuditLog` model; every sensitive mutation audits: admin/user writes, organization changes, settings, consent transitions, device approvals/revocations, commands, screenshots, reports, imports, policy changes. Employee/user create/edit includes diffs of changed fields. Audit logs are append-only (no API to edit/delete); consent logs are immutable by design.

## 10. Known limitations (honest)

- **No MFA/2FA**, no password reset flow, no refresh-token rotation (single JWT with sliding expiry via refresh endpoint).
- Rate limiting is per-process (not shared); CSRF check requires the `Origin` header to be present (defense in depth — CORS is not permissive).
- Enrollment codes are single-use and shown once, but a leaked *active* enrollment code grants zero-touch registration until rotated/deleted.
- The AI providers receive prompt data as configured by the operator (see [PRIVACY.md](./PRIVACY.md) §7).
- Agent tamper/anomaly reporting endpoints exist server-side but the agent client is not currently wired to send them (dormant).
- Native addon and agent are Windows-only; macOS/Linux agents are **not implemented**.

## 11. Security testing

- `tests/security.test.ts`, `tests/rbac.test.ts`, `tests/multi-org-isolation.test.ts`, `tests/rate-limit.test.ts`, `tests/csrf.test.ts`, `tests/ai-security.test.ts`, `tests/agent-security.test.ts`, `tests/screenshot-security.test.ts`, `tests/export-security.test.ts`, `tests/upload-security.test.ts` — run via `npm run test:security` (requires throwaway PostgreSQL databases; see [DEVELOPMENT.md](./DEVELOPMENT.md)).
- Original repository audit scored **36/100** (mock data era); re-audit during certification (see [docs/audits](./docs/audits) and [DOCUMENTATION-AUDIT.md](./DOCUMENTATION-AUDIT.md)).
