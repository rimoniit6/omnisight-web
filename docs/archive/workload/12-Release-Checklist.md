# WorkLensAI — Commercial Release Checklist

> **File:** workload/12-Release-Checklist.md · **Created:** 2026-08-02
> Used to gate every release (pre-alpha → beta → v1.0 → v1.x → v2.0). Mark items with `[x]` as they pass. Never delete items; obsolete checks are struck through, not removed.

**Release under test:** `v0.2.1 (pre-alpha)` · **Gate:** Beta (Phase 1)

---

## Application

- [ ] `npm run lint` passes with strict rules (no rule-disabling shortcuts)
- [ ] `npm run build` passes with type checking (`ignoreBuildErrors` removed)
- [ ] No `console.log` of sensitive data in production build
- [ ] All mock/placeholder data paths removed or flagged in UI (no silent fake data)
- [ ] Loading, empty, and error states verified on every page
- [ ] Dark/light theme + responsive layouts verified (mobile/tablet/desktop)
- [ ] Session survives page refresh (session restore)
- [ ] Topbar/notifications show real user & real data

## Database

- [ ] Prisma migrations committed and applied cleanly on a fresh DB
- [ ] `prisma migrate deploy` tested on empty + existing databases
- [ ] Seed/demo data script is guarded against production use
- [ ] Backup/restore verified (see Backup section)
- [ ] No secrets stored in DB in plaintext (AI keys encrypted)

## API

- [ ] All 33+ routes: zod validation, consistent error shape `{error:{code,message}}`
- [ ] Auth enforced at middleware **and** route level (`requireRole`)
- [ ] No sensitive fields in responses (passwordHash, twoFactorSecret, full API keys)
- [ ] Pagination on all list endpoints
- [ ] Rate limiting on login + ingestion endpoints
- [ ] OpenAPI spec in docs matches the shipped API (or spec removed/flagged as draft)

## Security

- [ ] **Auth bypass removed** (X-API-Key/X-Agent-Token passthrough gone)
- [ ] JWT secret required in production (no fallback); rotated if ever leaked
- [ ] Default `admin123` cannot survive first login (forced change)
- [ ] Security headers configured (CSP, X-Frame-Options, etc.)
- [ ] Dependency audit: `npm audit` clean or accepted-risk documented
- [ ] `.env` / secrets not in git history; `.env.example` provided

## Documentation

- [ ] Install guide (Docker + native) validated step-by-step on a fresh VM
- [ ] Windows Agent deployment guide (MSI/EXE + group policy)
- [ ] Admin user guide (dashboard, policies, AI providers)
- [ ] FAQ + troubleshooting + backup/restore runbook
- [ ] README updated with quick start; docs reconciled with actual features

## Docker

- [ ] `docker-compose.yml` builds from clean checkout
- [ ] Persisted volumes for DB + storage; upgrade path documented
- [ ] Health checks + graceful shutdown; logs accessible
- [ ] Image tested on Ubuntu + Windows Server (Docker Engine)

## Windows Agent

- [ ] Signed installer (EV cert); AV scan clean (at least 5 engines)
- [ ] Idle CPU < 2%, RAM < 100 MB; 24h soak test passed
- [ ] Offline queue → sync verified (drop network mid-session)
- [ ] Registration + heartbeat + config push verified against server
- [ ] Uninstall cleanly removes all traces (no orphaned services)

## Testing

- [ ] Unit tests (lib) green in CI
- [ ] API integration tests green (auth, validation, CRUD)
- [ ] Playwright smoke: login → dashboard → devices → screenshots → logout
- [ ] E2E: agent event → dashboard within 30s
- [ ] Regression suite passes on the release branch

## Demo Data

- [ ] Demo seed reflects realistic org (companies, roles, activity) — safe, non-sensitive
- [ ] Demo mode clearly labeled; cannot be confused with production data
- [ ] "Reset demo data" documented for buyers

## AI Providers

- [ ] BYOK gateway works with at least OpenAI + Ollama (tested)
- [ ] Keys encrypted at rest, masked in UI/API
- [ ] Token/cost tracking accurate; no key sent to non-configured endpoints
- [ ] Provider failure → friendly error + no data loss

## Branding

- [ ] Product name/logo consistent (WorkLensAI); favicon + OG images
- [ ] Version string correct everywhere (sidebar, footer, package.json)
- [ ] White-label toggle ready (Phase 3) or removed from UI

## Performance

- [ ] Dashboard load < 2s @ 100 seats / 1M events (SQLite)
- [ ] Timeline/activity queries bounded (indexed, paginated)
- [ ] Screenshot serving cached/optimized; retention job tested
- [ ] Agent upload batch size tuned; no memory spikes

## Backup

- [ ] Automated backup script (DB dump + storage volume) documented
- [ ] Restore procedure tested on a clean machine (DB + files + config)
- [ ] Retention policy documented (screenshots, events, logs)

## Restore

- [ ] Full restore verified: install → restore backup → login → data intact
- [ ] Partial restore (DB only) documented for storage-loss scenarios
- [ ] Corrupt-backup handling documented

---

## Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Product | | | |
| Engineering | | | |
| QA | | | |
| Security | | | |
