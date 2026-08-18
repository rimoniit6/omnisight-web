# WorkLensAI — Architecture Decisions (ADR)

> **File:** workload/09-Architecture-Decisions.md · **Renamed:** 2026-08-02 (content preserved)

> **Format:** Decision · Reason · Alternatives · Trade-offs · Date
> Status values: **Accepted** / **Proposed** / **Superseded**

---

## ADR-001 — Single-tenant, self-hosted architecture (no multi-tenancy)

- **Decision:** The product is single-tenant per installation. The `Organization` concept is simplified to the buyer's own company (no org-isolation logic, no tenant scoping in queries).
- **Reason:** Business model is one-time CodeCanyon purchase per buyer. Multi-tenancy adds massive complexity (isolation, quotas, billing) with zero revenue benefit at MVP.
- **Alternatives:** Multi-tenant SaaS (rejected — contradicts the model), "soft multi-tenancy" via `organizationId` (keep the column for data modeling, but no tenant enforcement).
- **Trade-offs:** Cannot upsell "workspaces"; trivial to add true multi-tenancy later if a hosted product ever emerges.
- **Date:** 2026-08-02 · **Status:** Accepted

---

## ADR-002 — Windows Agent stack: C# / .NET 8 (native)

- **Decision:** Agent is a C# .NET 8 application (WinForms-free console service + tray UI) using native Win32 APIs (GetForegroundWindow, hooks for idle, WMI for device info). Ships as a signed installer (.exe/msi) that embeds the buyer's server URL at build time.
- **Reason:** Docs specify C#/.NET/native Windows APIs. Small footprint (CPU/RAM is a top review complaint), no runtime shipping issues (self-contained publish), best access to Windows telemetry, easy signing for AV trust.
- **Alternatives:** Electron (rejected — 100+MB, heavy), Python + pyinstaller (rejected — AV false positives, packaging pain), Rust (viable but slower dev, harder agent-team hiring).
- **Trade-offs:** Windows-only initially (Mac/Linux agents are Phase 4); self-contained publish increases installer size (~60–80MB).
- **Date:** 2026-08-02 · **Status:** Accepted

---

## ADR-003 — SQLite for MVP, PostgreSQL as an option (Phase 3)

- **Decision:** MVP ships on SQLite (WAL mode) — zero-config for the buyer. Phase 3 adds a `DATABASE_URL` provider switch to PostgreSQL with the same Prisma schema.
- **Reason:** CodeCanyon buyers are often non-IT; "it just works" wins. SQLite comfortably handles the expected single-server scale (≤100 seats, hundreds of thousands of events/day) with proper indexes.
- **Alternatives:** PostgreSQL-only (rejected — Docker complexity scares the target buyer), MySQL (no benefit over SQLite at this scale).
- **Trade-offs:** Must keep aggregation queries index-friendly; a Postgres port requires migration tooling (adopt `prisma migrate` in Phase 1, even on SQLite).
- **Date:** 2026-08-02 · **Status:** Accepted

---

## ADR-004 — BYOK via OpenAI-compatible gateway

- **Decision:** All AI features (chat, insights, summaries) call an internal **OpenAI-compatible gateway** that routes to the buyer's configured provider (OpenAI, Gemini-via-compat, OpenRouter, Ollama, etc.) using `baseUrl + model + apiKey` from the AIProviders config. Keys are encrypted at rest and masked on read.
- **Reason:** BYOK is the core marketing promise; today the AI routes use the sandbox `z-ai-web-dev-sdk` and ignore configured providers (verified in audit). A gateway keeps one integration path for every provider.
- **Alternatives:** Per-provider SDKs (rejected — N integrations to maintain), keep z-ai SDK (rejected — not the buyer's key).
- **Trade-offs:** OpenAI-compatible endpoints don't cover 100% of every vendor's features; acceptable for chat/summaries.
- **Date:** 2026-08-02 · **Status:** Accepted

---

## ADR-005 — Auth: JWT + RBAC; kill the header bypass (P0)

- **Decision:** JWT (HS256, 24h) in httpOnly cookie + Bearer. Middleware verifies JWT only (the `X-API-Key`/`X-Agent-Token` passthrough branches are **removed** — they are a verified full auth bypass). Route handlers enforce `requireRole('Admin')`. Agent endpoints use per-device tokens validated against the DB, scoped to that device's own uploads.
- **Reason:** Audit proved any bogus header returns 200 on all routes and leaks password hashes/2FA secrets.
- **Alternatives:** Opaque sessions in DB (rejected — fine but JWT already exists), RS256 (defer; HS256 with strong secret is adequate at MVP).
- **Trade-offs:** Stateless JWTs can't be revoked server-side → keep sessions-short + logout clears cookie.
- **Date:** 2026-08-02 · **Status:** Accepted

---

## ADR-006 — Screenshot storage: local disk volume for MVP

- **Decision:** Screenshots (and later OCR artifacts) stored on the server's local disk under a configurable volume (`STORAGE_PATH`), served through an authenticated API route. S3-compatible storage (MinIO) is a Phase 3 option.
- **Reason:** Self-hosted buyers own storage; local disk is zero-config. Object storage adds setup friction with no MVP revenue.
- **Trade-offs:** Disk fills up → enforce retention policy from day one (already in Settings concept).
- **Date:** 2026-08-02 · **Status:** Accepted

---

## ADR-007 — Telemetry transport: batched HTTPS JSON for MVP

- **Decision:** Agent pushes batched JSON events (activity, screenshots, heartbeat) over HTTPS to `POST /api/agent/ingest`. Compression (gzip) from day one. Protobuf/MessagePack is a Phase 3 optimization only if profiling demands it.
- **Reason:** Simplest reliable pipeline; matches existing stack; the audit shows no transport exists yet.
- **Alternatives:** WebSocket streaming (defer — real-time live view is a later feature), protobuf now (premature).
- **Trade-offs:** Slightly higher bandwidth; fine at MVP scale.
- **Date:** 2026-08-02 · **Status:** Accepted

---

## ADR-008 — Distribution: Docker Compose + signed agent installer

- **Decision:** Ship `docker-compose.yml` (web + db + storage volume) for the backend; the Windows agent ships as a signed installer with the server URL baked in. Provide a manual native install path (Node 20 + SQLite) for buyers without Docker.
- **Reason:** "One command to deploy" is the #1 CodeCanyon conversion factor for this category.
- **Alternatives:** K8s/helm (rejected — enterprise overkill), standalone binary bundle (provide as fallback docs).
- **Trade-offs:** Docker requirement excludes some shared-hosting buyers → document the native path.
- **Date:** 2026-08-02 · **Status:** Accepted

---

## ADR-009 — Licensing: CodeCanyon handles sales; lightweight offline validation

- **Decision:** No vendor license server at MVP. The buyer enters a license key (delivered at purchase) during admin setup; validated offline (HMAC/hash check with grace period + offline renewal file). Major-version upgrades (Phase 4) may add a vendor update/license server.
- **Reason:** CodeCanyon already handles payments/refunds/chargebacks; a license server is vendor infrastructure the business model doesn't need yet.
- **Alternatives:** Full online activation (defer), no licensing at all (rejected — trivial piracy with no check).
- **Trade-offs:** Keys can be shared; mitigated by per-purchase key + buyer support checks.
- **Date:** 2026-08-02 · **Status:** Accepted

---

## ADR-010 — Explicitly deferred to keep MVP focused

- **Decision:** Not in MVP: plugin marketplace, SSO/SCIM, DLP, video recording, mobile/GPS, payroll/invoicing, Redis/Kafka, Kubernetes, multi-tenancy, self-hosted AI models.
- **Reason:** Each adds weeks of work with no first-release revenue. They are tracked in `Future-Ideas.md` / Roadmap Phases 3–4.
- **Trade-offs:** Feature-gap vs Teramind/Hubstaff on paper — mitigated by the one-time-price + self-host positioning and a clear "roadmap" page in docs.
- **Date:** 2026-08-02 · **Status:** Accepted

---

## ADR-011 — Agent identity: Installation + Device + hashed Agent Token

- **Decision:** Identity = `Installation` (per deployment, join-key protected) + `Device` (per machine) + opaque 256-bit `AgentToken` (issued once at registration, stored server-side as SHA-256 hash, DPAPI-protected client-side). `organizationId` is derived, not agent-supplied.
- **Reason:** Single-tenant self-host; join key authorizes enrollment; hashed tokens make DB leaks non-replayable; per-device scoping prevents cross-device data access.
- **Alternatives:** Shared org API key per install (rejected — no per-device revocation), client-generated tokens (rejected — no server control).
- **Trade-offs:** Token issuance requires a one-time registration round-trip.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-012 — HMAC request signing with nonce + timestamp window

- **Decision:** All agent requests sign `METHOD\nPATH\nTIMESTAMP\nNONCE\nsha256(body)` with HMAC-SHA256 keyed by the agent token; server enforces ±300 s clock window and a 10-min nonce cache. TLS remains mandatory.
- **Reason:** Defends against replay/relay even if a token is captured; enterprise-grade posture without certificates per device.
- **Alternatives:** mTLS per device (rejected — cert lifecycle burden for CodeCanyon buyers), plain bearer token (rejected — no replay protection).
- **Trade-offs:** Slightly more agent complexity; clock sync required (mitigated via `X-Server-Time` + tolerant heartbeat).
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-013 — One typed-event ingestion endpoint with client-sequence idempotency

- **Decision:** App/website/idle/session flows share `POST /api/agent/v1/activity` with an additive `kind` discriminator; idempotency via unique `(deviceId, seq)` + server `highWaterMark`; server timestamps authoritative via `createdAt`.
- **Reason:** Avoids 4 near-identical endpoints; makes offline queue + resume trivial; future kinds (AI prompts, video) are additive.
- **Alternatives:** Per-kind endpoints (rejected — N× auth/retry/rate-limit plumbing), protobuf now (deferred — JSON+gzip is adequate at MVP scale).
- **Trade-offs:** One schema per kind; documented in 17-Agent-API-Contract.md.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-014 — Screenshots: two-step chunked upload with content-addressable dedup

- **Decision:** Initiate → `{uploadId, chunkSize}` → resumable `PUT` chunks → sha256 verify; global dedup on `sha256` within retention; files on local `STORAGE_PATH` outside web root; privacy mode stores metadata-only/blurred.
- **Reason:** Resumability under flaky office networks; dedup avoids identical-frame storage blowup; privacy-first posture required by the product promise.
- **Alternatives:** Single-shot base64 JSON (rejected — 33% overhead, no resume), S3 direct-to-bucket (deferred — buyer setup burden at MVP).
- **Trade-offs:** Two-step flow; ticket GC job required.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-015 — API versioning: `/api/agent/v{n}` with additive-only `v1`

- **Decision:** Versioned path prefix; `v1` additive-only (new kinds/fields/commands); breaking changes → `v2` with overlap window; capability negotiation at registration; `x-format-version` header on bodies.
- **Reason:** Long-term support without breaking installed fleets (CodeCanyon buyers don't auto-upgrade).
- **Alternatives:** Accept-header versioning (rejected — less discoverable, proxy-unfriendly), unversioned (rejected — breaks future enterprise features).
- **Trade-offs:** URL prefix churn is permanent.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-016 — Signed update manifests for agent auto-update

- **Decision:** Update flow: heartbeat flag → `GET /api/agent/v1/update` manifest (sha256 MVP, Ed25519 signature enterprise) → resumable download → verify → staged swap with rollback marker; `minAgentVersion` enforcement via 426.
- **Reason:** The buyer's server is the only update source; signed manifests prevent MITM/compromised-server installs.
- **Alternatives:** Vendor-hosted update server (rejected — conflicts with self-host/no-phone-home model), unsigned downloads (rejected — tamper risk).
- **Trade-offs:** Signature verification cost is trivial; cert/key rotation needed for the signing key.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-017 — Policy vs configuration separation (E4 policy / E13 config)

- **Decision:** Telemetry `Policy` (capture rules, categories, privacy — business rules) is versioned and distinct from agent `Config` (runtime: URLs, intervals, log level, queue caps — operational). Both fetched on version-change flags from heartbeat.
- **Reason:** Admins edit policy in UI without touching operational config; agents stay in lock-step via version integers.
- **Alternatives:** Single blob (rejected — mixes concerns, breaks fine-grained change detection).
- **Trade-offs:** Two version counters to track.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-018 — Hybrid event storage: one `ActivityEvent` table (typed columns + payload JSON)

- **Decision:** App/website/idle telemetry is stored in ONE `ActivityEvent` table (evolution of `ActivityLog`) with typed common columns (kind, title, url, domain, browser, duration, focusTime, category, productive, timestamp) plus a `payload` JSON column for kind-specific extras. Sessions stay in `LoginSession` (stateful). `(deviceId, seq)` unique gives one global idempotency ring.
- **Reason:** Timeline reconstruction, rankings, and heatmaps must interleave kinds in one query; separate tables would multiply idempotency keys/high-water-marks and force N-way merges. Fully-generic JSON-only storage can't be indexed in SQLite (the MVP engine) for the 50 ms p95 target.
- **Alternatives:** Separate `AppUsage`/`WebsiteVisit`/`IdleSession` tables (rejected — §6 of 18-Telemetry-Database-Design.md), single row-per-event with everything in JSON (rejected — SQLite can't index it via Prisma).
- **Trade-offs:** `payload` is a schema escape-hatch — anything we need to filter/aggregate later must graduate to a real column (additive, per ADR-015).
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-019 — Screenshot metadata + sha256 dedup; no `ScreenshotChunk` table

- **Decision:** `Screenshot` stores metadata + `sha256` (content-addressable, unique within retention) + `storagePath` (files on local disk per ADR-006). Chunked-upload progress lives in `UploadTicket.receivedBitmap`, NOT a row-per-chunk table. `dedupRef` links duplicate frames to their stored twin.
- **Reason:** Never BLOBs in SQLite; dedup avoids identical-frame storage blowup; the bitmap is compact and resumable; OCR columns already exist for Phase 2.
- **Alternatives:** Row-per-chunk (`ScreenshotChunk`) — rejected (N writes per image, no query value); S3 direct upload — deferred (buyer setup burden).
- **Trade-offs:** A GC job must reconcile tickets, files, and rows hourly.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-020 — `UserDailySummary` rollup is the analytics & AI backbone

- **Decision:** A per-user-per-day rollup table (`UserDailySummary`, `UNIQUE(userId, date)`) feeds dashboards, scores, heatmaps, and AI prompts. Raw `ActivityEvent` is only queried for timelines/drill-downs. Job cadence: nightly full + 15-min incremental for today.
- **Reason:** SQLite cannot serve dashboards from 50M+ raw rows; rollups keep p95 < 50 ms and shrink AI prompt tokens (buyer pays per token under BYOK — ADR-004).
- **Alternatives:** On-the-fly aggregation (rejected — too slow at scale), materialized views (Postgres-only, Phase 3).
- **Trade-offs:** Extra storage (tiny) + a background job to build and keep it correct.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-021 — No raw heartbeat table; `Device.lastHeartbeatAt` + sampled `DeviceHealthSnapshot`

- **Decision:** Heartbeats update `Device.lastHeartbeatAt`/`status` only. Fleet-health history is a sampled `DeviceHealthSnapshot` (default 1/hour/device, 90-day retention) fed by E7 health reports.
- **Reason:** Raw heartbeats at 1/15 s = ~576k rows/day at 100 users of pure write amplification with no analytics value beyond online/offline.
- **Alternatives:** Raw `Heartbeat` table (rejected — write amplification), Redis presence cache (deferred — only needed for future live view).
- **Trade-offs:** Health charts have hour-granularity (acceptable for capacity/uptime reporting).
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-022 — AI outputs are persisted in `AISummary` (deterministic key)

- **Decision:** Generated narratives/insights are stored in `AISummary` keyed `UNIQUE(userId, scope, periodStart)`; regenerate only on miss/force. AI chat history gets `AIConversation` + `AIMessage` (Phase 2).
- **Reason:** Today AI insights are stateless (feature matrix: not persisted); persisting gives caching, auditability, and stable links for the UI — and avoids paying BYOK tokens repeatedly for the same summary.
- **Alternatives:** Regenerate on every view (rejected — token cost + nondeterministic results).
- **Trade-offs:** Stale summaries until re-generation policy (period-based invalidation).
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-023 — Policy = active row + append-only `PolicySnapshot` history

- **Decision:** `AgentPolicy` is a single active row (monotonic `version`, `rules` JSON = exact E4 payload); each change appends a `PolicySnapshot` (version-unique, actor, timestamp). Runtime config (E13) stays out of the DB.
- **Reason:** Fast "current policy" read on every E4 fetch, plus auditable history; keeps business rules and operational config separate (ADR-017).
- **Alternatives:** Full version rows with active flag (rejected — slower active read), no history (rejected — audit requirement).
- **Trade-offs:** Two tiny tables instead of one.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-024 — Device↔User attribution via `DeviceAssignment` windows; existing telemetry tables reused

- **Decision:** `DeviceAssignment` (assignedAt/revokedAt windows) is the source of truth for which employee used a device when; `User.deviceId` remains the current-assignment cursor for existing UI. Existing `FileActivity`/`MouseStat`/`KeyboardStat`/`ClipboardEvent`/`UsbActivity`/`NetworkActivity` tables are reused as-is for current admin reads; Phase 3 agent ingest may write them or use new `ActivityEvent` kinds — no schema change either way.
- **Reason:** Agent never supplies `userId` (anti-spoof, contract E2) — the server must resolve it from assignment windows, which also survive reassignment; ripping out existing tables would break verified UI/API for zero benefit.
- **Alternatives:** Single static `User.deviceId` only (rejected — wrong attribution after reassignment), folding all specialized tables into ActivityEvent now (rejected — unnecessary churn pre-Phase-3).
- **Trade-offs:** Ingest path needs a fast assignment lookup (cache it).
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-025 — Phase 1 baseline migration; adopt Prisma Migrate; Postgres via same history + raw-SQL partitioning

- **Decision:** Replace the current `db push` workflow with `prisma migrate dev`; create a single baseline `0001_telemetry_v1` (full final schema) and reseed demo data in Phase 1. Postgres switch (Phase 3) replays the same migration history via `prisma migrate deploy`, then raw-SQL migrations add monthly partitioning (Prisma has no native partition support).
- **Reason:** Zero production data exists (demo seed only) — restructuring (ActivityLog→ActivityEvent rename, required deviceId) is free now and would be a breaking change after a CodeCanyon v1.0. Migrations are also a hard requirement for PostgreSQL (ADR-003).
- **Alternatives:** Keep `db push` (rejected — no history, dangerous for buyers), defer restructure to v2 (rejected — breaks one-time-purchase buyers).
- **Trade-offs:** The baseline migration is large; must be reviewed before buyers install anything.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-026 — No Prisma enums on SQLite; string constants + optional CHECK constraints

- **Decision:** All enumerated fields stay `String` in the Prisma schema. A TypeScript constants module (`src/lib/enums.ts`) is the single source of truth for value sets; optionally enforce critical sets (`kind`, `category`, `severity`, `role`, device `status`) with raw-SQL CHECK constraints in the same migration.
- **Reason:** Prisma does not support `enum` on the SQLite connector (enums are Postgres/MySQL/Mongo features). Introducing enums would break the SQLite MVP (ADR-003) or fork the schema between engines.
- **Alternatives:** Prisma `enum` on Postgres only (rejected — schema divergence), keep app-only validation (rejected — audit found 1/33 routes validates).
- **Trade-offs:** DB-level integrity is weaker without enums; mitigated by CHECK constraints where integrity matters.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-027 — Referential-action policy: no CASCADE on telemetry or audit data

- **Decision:** Every `onDelete` is declared explicitly. Telemetry/audit links use `RESTRICT` or `SET NULL` only. `CASCADE` is allowed exclusively for device-scoped control rows (`AgentCredential`, `AgentCommand`, `AgentLog`, `AgentError`, `DeviceHealthSnapshot`, `DeviceUpdateHistory`) and the `UserRole` join. Critical traps: `Screenshot.uploadId → UploadTicket` is `SET NULL` (tickets GC in 24 h, screenshots live 365 d); `Screenshot.dedupRef` is `SET NULL` (twin may purge first).
- **Reason:** Screenshots would vanish when their upload ticket is purged; user/device deactivation must preserve history (USER-002: "preserve historical activity"); Prisma's defaults are accidental, not designed.
- **Alternatives:** Leave Prisma defaults (rejected — silent data-loss risk), hard-delete users/devices (rejected — soft status already exists).
- **Trade-offs:** Slightly more verbose schema; explicit behavior is auditable.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-028 — Ten-step migration sequence (M001–M010) with pre-v1 squash option

- **Decision:** Apply the final schema as 10 isolated migrations (M001 baseline capture → M002 RBAC → M003 identity/fleet → M004 telemetry core → M005 media → M006 command/diagnostics → M007 policy/health → M008 rollup → M009 audit → M010 AI). Keep them separate during development; may squash into one `0001_telemetry_v1` baseline at release since zero production data exists.
- **Reason:** Each migration is one domain + one risk class; failures are contained, reversible, and reviewable; the sequence exercises the Prisma Migrate pipeline early (required for Postgres, ADR-025).
- **Alternatives:** One monolithic migration (rejected — unreviewable, opaque failures), schema-first-then-migrate (same thing, worse).
- **Trade-offs:** 10 steps is more ceremony now; M004 must ship together with updated API routes referencing `ActivityLog`.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-029 — Partial unique index (`DeviceAssignment` active window) via raw SQL

- **Decision:** The one-active-assignment invariant is enforced with a partial unique index `UNIQUE(deviceId, revokedAt) WHERE revokedAt IS NULL`, added as a raw-SQL step inside the M003 migration (Prisma cannot express partial unique indexes).
- **Reason:** SQLite (3.8+) and PostgreSQL both support partial indexes; Prisma schema has no partial-index syntax; without it, two "current" assignments could coexist.
- **Alternatives:** App-level enforcement only (rejected — race window), full unique on (deviceId, revokedAt) with sentinel value (rejected — sentinel is a lie).
- **Trade-offs:** Requires hand-editing the generated migration (use `prisma migrate dev --create-only`), and `prisma migrate diff` must confirm it survives.
- **Date:** 2026-08-02 · **Status:** Accepted

## ADR-030 — updatedAt policy: stateful tables yes, immutable event tables no

- **Decision:** `updatedAt` is present on stateful tables (Organization, User, Device, AIProvider, SecurityPolicy, License, Plugin, Report, Alert, SecurityEvent, plus new UploadTicket, AgentCommand, AgentCredential, DeviceAssignment, AgentPolicy, AISummary). Immutable event/telemetry tables (ActivityEvent, Screenshot, LoginSession, FileActivity, MouseStat, KeyboardStat, ClipboardEvent, UsbActivity, NetworkActivity, AgentLog, AgentError, AuditLog, AIMessage) carry only `createdAt`.
- **Reason:** Mutable rows need optimistic concurrency and "last changed" visibility; append-only rows never change, so `updatedAt` is noise that invites accidental UPDATEs.
- **Alternatives:** `updatedAt` everywhere (rejected — implies mutability), `deletedAt` everywhere (rejected — soft-delete via `status` is the existing, consistent pattern).
- **Trade-offs:** Developers must know which tables are immutable — document in the schema comments.
- **Date:** 2026-08-02 · **Status:** Accepted
