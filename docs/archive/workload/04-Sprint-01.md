# Sprint 01 — Security Hardening & Foundation

> **File:** workload/04-Sprint-01.md · **Renamed:** 2026-08-02 (content preserved)

> **Duration:** 2 weeks (10 working days) · **Goal:** Make the current build safe to demo and lay the foundation for the agent.
> **Scope:** Backlog BL-001…BL-008, BL-111, BL-112, BL-113, BL-601–603, BL-605 (housekeeping)

---

## Sprint Goals

1. **No known critical vulnerability remains** (auth bypass, credential leaks, secret handling).
2. **All API routes validate input and return a consistent error shape.**
3. **AI BYOK actually works** with configured providers.
4. **No fabricated data** in any API response.

---

## Tasks

| # | Task | AC (Acceptance Criteria) | Est. | Status |
|---|---|---|---|---|
| S1.1 | Remove `X-API-Key`/`X-Agent-Token` passthrough in `src/middleware.ts`; JWT-only for web routes | `curl -H 'X-API-Key: bogus' /api/users` → 401; valid cookie/Bearer → 200 | 0.5d | Not Started |
| S1.2 | Add route-level auth helper usage: `requireRole('Admin')` on every admin route | Non-admin JWT gets 403 on admin endpoints; `requireAuth` no longer dead code | 1–2d | Not Started |
| S1.3 | Sanitize user responses via `select` whitelists | `/api/users` & `/api/users/[id]` never contain `passwordHash`/`twoFactorSecret`/`ssoProviderId` (integration test) | 0.5d | Not Started |
| S1.4 | Secret handling: throw at boot if `NEXTAUTH_SECRET` missing in prod; add `.env.example`; rotate secrets | `next start` fails fast without secret; no default string in code | 0.5d | Not Started |
| S1.5 | Zod schemas for all POST/PATCH bodies + query params; shared `ApiError` helper | Duplicate email → 409 `{error:{code,message}}`; malformed body → 400; no raw Prisma errors | 3–4d | Not Started |
| S1.6 | try/catch + consistent error JSON on all 33 routes | No unhandled exceptions; all routes return `{error:{code,message}}` on failure | 1d | Not Started |
| S1.7 | BYOK gateway: AI chat/insights read active provider (key, baseUrl, model) from DB; OpenAI-compatible fetch | With a valid configured key, AI chat returns a real response; no key → clear 400 "configure a provider" | 4–6d | Not Started |
| S1.8 | Encrypt provider keys (AES-256-GCM, key from env); mask on read (`sk-•••`) | DB stores ciphertext; GET never returns full key | 1–2d | Not Started |
| S1.9 | Remove `Math.random()` from `analytics/route.ts`, `activity-matrix/route.ts`; compute from data or return null | No `Math.random` in `src/`; metrics reproducible | 2–3d | Not Started |
| S1.10 | Pagination (`take`/`cursor`) on users/devices/orgs/activity/analytics | Lists accept `page`/`limit`; bounded queries | 2–3d | Not Started |
| S1.11 | Session restore: `/api/auth/sessions` returns real user; frontend bootstraps session on load | Refresh keeps admin logged in when cookie valid | 1–2d | Not Started |
| S1.12 | Topbar real user + remove hardcoded "Administrator"; notifications → empty state until real events | Topbar shows logged-in user's name/email/role | 1d | Not Started |
| S1.13 | Seed guard + docs merge conflict cleanup + remove `ignoreBuildErrors` (re-enable strict) | `seed.ts` refuses to run in NODE_ENV=production; build fails on type errors | 1–2d | Not Started |

**Total estimate:** ~18–22 person-days (2 developers ≈ 2 weeks).

---

## Definition of Done (Sprint 01)

- [ ] No P0 backlog items open (BL-001…008, BL-603)
- [ ] All tests in the new Vitest suite pass (route-level auth/validation tests mandatory)
- [ ] `npm run lint` clean with re-enabled rules; `npm run build` type-checks
- [ ] Manual smoke: login → dashboard → create user → AI chat with a test key
- [ ] Progress.md updated; completed items moved Not Started → In Progress → Completed

---

## Risks / Notes

- S1.7 (BYOK) can be validated against Ollama locally with zero cost — use it in tests.
- Removing the header bypass will break the (unused) agent routes — they are re-added properly in Sprint 02 with real device tokens.
