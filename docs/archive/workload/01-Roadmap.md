# WorkLensAI — Product Roadmap

> **File:** workload/01-Roadmap.md · **Status:** Active · **Owner:** Product/Eng · **Updated:** 2026-08-02
> **Business model:** Self-hosted commercial product sold on CodeCanyon (one-time license). No SaaS, no subscription, no multi-tenancy, no hosted cloud.

---

## 1. Product Vision

WorkLensAI is a **self-hosted AI workforce-intelligence platform**: the buyer deploys the backend on their own server, installs the Windows Agent on employee machines, and brings their own AI keys (OpenAI, Gemini, OpenRouter, Ollama…). All employee data stays on the buyer's infrastructure.

**Positioning for CodeCanyon:** the one-time-purchase alternative to Teramind / ActivTrak / Time Doctor for privacy-conscious SMBs, agencies, MSPs, and regulated industries (healthcare, finance, legal, government contractors) that cannot or will not send employee activity data to a third-party cloud.

---

## 2. Market Intelligence (Research Summary — Aug 2026)

### 2.1 Competitor landscape

| Product | Model | Self-host | Core identity | Pricing (approx) |
|---|---|---|---|---|
| Teramind | SaaS + On-prem (Enterprise) | Yes (enterprise) | Security/DLP, UEBA, insider threat | $14–32/user/mo, 5-seat min |
| ActivTrak | SaaS | No | Privacy-first analytics, coaching, benchmarks | $10–19/user/mo |
| Insightful | SaaS + On-prem (250+ seats) | Yes (enterprise) | Time mapping, hybrid-team analytics | $6–12/user/mo |
| Hubstaff | SaaS | No | Field/GPS, payroll, invoicing | $4.99–25/user/mo |
| Time Doctor | SaaS | No | Accountability, distraction alerts, screencasts | $6.70–16.70/user/mo |
| DeskTime | SaaS | No | Zero-effort time tracking, private time | $6.42–11.08/user/mo |
| Veriato | SaaS + On-prem | Yes (enterprise) | Forensics, insider risk, psycholinguistics | ~$18/user/mo, 5-seat min |
| Kickidler | Cloud + Self-hosted | Yes | Live multi-screen viewing, video recording | $7–9.99/user/mo |

### 2.2 Features every competitor has (table stakes for us)

1. **App & website tracking** (active window, URLs, domains)
2. **Idle detection** (configurable keyboard/mouse threshold)
3. **Screenshots** (periodic capture; blur option is a differentiator)
4. **Productivity classification** (Productive / Neutral / Distracting)
5. **Time & activity reports** (active vs idle hours, daily/weekly timelines)
6. **Team/employee dashboards**
7. **Private time / pause** (employee trust feature — DeskTime, Time Doctor)

### 2.3 What buyers complain about (review research — G2/Capterra)

- Pricing friction & tier-gating of essential features → **our one-time price is the moat**
- Inaccurate idle detection penalizing reading/meetings → build accurate idle + configurable categories
- Heavy agent resource footprint / AV false positives → lightweight agent, signed binaries
- Surveillance backlash → employee transparency portal + private time
- Missing: HRIS/PM integrations, calendar-aware auto-pause, privacy-first employee portal

### 2.4 CodeCanyon market reality

- Buyers: budget-conscious SMBs, digital agencies, resellers/MSPs; expect $30–100+ one-time
- Self-hosted server module + **Windows agent .exe that must be compiled with the buyer's server URL**
- Support burden is on us (no SaaS to control) → **excellent install docs + Docker Compose are MVP-critical**

---

## 3. Strategic Product Decisions (summary — see Architecture-Decisions.md)

| Decision | Choice |
|---|---|
| Deployment | Docker Compose (single command) + Windows agent installer |
| Agent stack | C# / .NET 8 (native Win32 APIs, small footprint) |
| Database | SQLite for MVP (zero-config); Postgres upgrade path |
| AI | BYOK via OpenAI-compatible gateway (uses buyer's key, no markup) |
| Auth | JWT + role-based; **remove header bypass** (P0) |
| Licensing | CodeCanyon handles sales; simple offline license validation at install |
| Explicitly NOT in MVP | Plugin marketplace, SSO/SCIM, DLP, video recording, mobile/GPS, payroll, Redis/Kafka/K8s, multi-tenancy |

---

## 4. Phases

Legend — Complexity: S/M/L/XL · Effort: person-days (dev) · Priority: P0–P3 · Status: Not Started / In Progress / Completed / Deferred / Cancelled

### Phase 1 — MVP: Launch on CodeCanyon *(~6–8 weeks)*

Goal: **a secure, sellable, self-hosted product**: Windows Agent collects real telemetry → backend stores it → dashboards & AI reports are driven by real data. Everything the buyer needs to deploy on day one.

| # | Feature | Description | Business Value | Complexity | Dependencies | Effort | Priority | Status |
|---|---|---|---|---|---|---|---|---|
| 1.1 | **Security hardening (P0 fixes)** | Kill X-API-Key/X-Agent-Token bypass; sanitize user API responses (no passwordHash/2FA secrets); enforce `requireRole('Admin')`; remove hardcoded JWT fallback; zod validation + unified error handling on all routes | Without this the product is compromised on day one; CodeCanyon reviewers & buyers will exploit it | M | — | 4–6 | P0 | Not Started |
| 1.2 | **Windows Agent v1 (C#/.NET 8)** | Track active window, app/website titles+URLs, idle time, sessions; heartbeat + registration; offline SQLite queue with sync; low CPU/RAM; signed installer exe | **Core differentiator — the product's data source.** Without an agent there is no product | XL | — | 15–20 | P0 | Not Started |
| 1.3 | **Agent registration & device management** | Devices register with a token → appear in Devices UI; status (Online/Offline/Idle); agent version | Buyers must see their fleet | M | 1.2 | 3–4 | P0 | Not Started |
| 1.4 | **Telemetry ingestion API** | Batched POST of activity events from agent; per-device auth token; rate limits; validation; idempotency | Reliable data pipeline | M | 1.2, 1.1 | 4–5 | P0 | Not Started |
| 1.5 | **Real analytics engine** | Remove `Math.random()` fabricated metrics; compute productivity/focus/risk/trends from real ingested data; SQL aggregation + pagination | **Trust.** Buyers must trust the numbers before paying | L | 1.4 | 5–7 | P0 | Not Started |
| 1.6 | **Screenshot capture + viewer** | Configurable interval capture; upload + local storage; in-app viewer with blur-sensitive option; retention setting | Table-stakes visual monitoring (Teramind/ActivTrak have it) | L | 1.2, 1.4 | 6–8 | P0 | Not Started |
| 1.7 | **BYOK AI wiring** | AI Providers config actually drives AI chat/insights (OpenAI-compatible gateway; baseUrl/model/key); token + cost tracking; masked keys at rest/read | **Core promise ("Bring Your Own Key") must actually work** | L | 1.1 | 4–6 | P0 | Not Started |
| 1.8 | **Dashboards on real data** | Dashboard/Activity/Analytics/Employee-profile views consume real telemetry; remove hardcoded "Administrator" & fake notifications | Buyers evaluate the UI before purchase | M | 1.5, 1.6 | 4–5 | P0 | In Progress (existing UI) |
| 1.9 | **Export & reporting (CSV)** | Real CSV export of activity/timesheets; replace "export (mock)" | Buyers need to justify purchases to management | M | 1.5 | 2–3 | P1 | Not Started |
| 1.10 | **Packaging, installer & buyer docs** | Docker Compose + one-command start; Windows agent installer; install guide, quick start, FAQ; `.env.example`; screenshots | **CodeCanyon conversion depends on "it just works"** | M | 1.2, 1.7 | 5–7 | P0 | Not Started |
| 1.11 | **Automated tests + CI** | Vitest (lib/API), Playwright smoke (login→dashboard), GitHub Actions | Protects the paid product from regressions | M | — | 4–6 | P1 | Not Started |
| 1.12 | **Simple offline licensing** | License key generated per purchase; validated at install/admin setup (offline, hash-based); grace period | Basic piracy deterrent; CodeCanyon handles payments | S | 1.10 | 2–3 | P2 | Not Started |
| 1.13 | **Session restore & real topbar** | Restore session on refresh; topbar shows actual user; notifications from real events | UX polish buyers notice | S | 1.1 | 2 | P2 | Not Started |

**Explicitly deferred from MVP:** OCR pipeline, email/Slack notifications, employee self-portal, PDF reports, DLP, video recording, agent auto-update, audit log UI, backup tooling, plugin marketplace, SSO/SCIM, mobile/GPS, multi-tenant, Redis/Kafka/K8s.

---

### Phase 2 — Intelligence & Engagement *(~6–8 weeks)*

Goal: turn raw telemetry into insight; make employees feel seen, not spied on.

| # | Feature | Description | Business Value | Complexity | Dependencies | Effort | Priority | Status |
|---|---|---|---|---|---|---|---|---|
| 2.1 | **OCR pipeline** | Tesseract OCR on screenshots → searchable text; keyword search | "Search my team's screenshots" is a headline feature | L | 1.6 | 6–8 | P1 | Not Started |
| 2.2 | **AI summaries persisted + scheduled** | Daily/weekly/executive summaries generated on schedule, stored, emailed | Recurring value; keeps buyers opening the app | M | 1.7 | 4–5 | P1 | Not Started |
| 2.3 | **Employee self-view portal** | Employees see their own data; private-time toggle; blur/delete personal activity | Trust + compliance; top review complaint | L | 1.5 | 6–8 | P1 | Not Started |
| 2.4 | **Notifications (email + webhook)** | SMTP email alerts; Slack/Teams webhooks; threshold rules (idle, overtime, risk) | Buyers expect alerting | M | 1.5 | 4–6 | P1 | Not Started |
| 2.5 | **Real audit log** | Append-only audit trail (login, admin actions); UI view | Compliance buyers (healthcare/finance) | M | 1.1 | 3–5 | P1 | Not Started |
| 2.6 | **PDF report generation** | Time/productivity reports as PDF | Deliverable to stakeholders | M | 1.9 | 3–4 | P2 | Not Started |
| 2.7 | **Agent auto-update + tamper basics** | Silent update channel; uninstall protection toggle | Fleet hygiene | L | 1.2 | 5–7 | P2 | Not Started |
| 2.8 | **Backup & restore utilities** | DB + screenshot volume backup script; restore guide | Self-hosted buyers own ops | S | — | 2–3 | P2 | Not Started |

---

### Phase 3 — Security & Scale *(~8 weeks)*

Goal: enterprise-credibility features that unlock higher-value buyers (finance, healthcare, defense).

| # | Feature | Description | Business Value | Complexity | Dependencies | Effort | Priority | Status |
|---|---|---|---|---|---|---|---|---|
| 3.1 | **DLP basics** | USB / file-copy / clipboard rules from Security Policies; alert + (optional) block | Teramind-lite; major upsell | XL | 1.4, 2.4 | 10–14 | P2 | Not Started |
| 3.2 | **Advanced analytics** | Heatmaps, trend benchmarks, workload balance, burnout signals (real data) | Competitive parity with ActivTrak | L | 1.5 | 6–8 | P2 | Not Started |
| 3.3 | **Scoped customer API keys** | Real API-key auth (fixed properly, validated against DB), rate-limited, role-scoped | Integration buyers | M | 1.1 | 3–4 | P2 | Not Started |
| 3.4 | **White-label branding** | Configurable brand color/logo/domain (real persistence) | Reseller/MSP market | M | — | 3–5 | P2 | Not Started |
| 3.5 | **PostgreSQL option + pagination everywhere** | Provider switch via env; index strategy; paginate all list APIs | Scale to 100+ seats | L | 1.5 | 6–8 | P2 | Not Started |
| 3.6 | **Anomaly detection** | Behavioral baseline → risk score from real signals (not random) | Insider-risk credibility | L | 3.2 | 6–8 | P3 | Not Started |

---

### Phase 4 — Ecosystem *(~quarter)*

Goal: ecosystem moat — integrations, plugins, mobility.

| # | Feature | Description | Business Value | Complexity | Dependencies | Effort | Priority | Status |
|---|---|---|---|---|---|---|---|---|
| 4.1 | **Integrations** (Slack, MS Teams, Jira, HRIS) | Two-way webhooks/connectors | Buyers live in these tools | L | 2.4 | 6–10 | P3 | Not Started |
| 4.2 | **Plugin system** | Signed JS/container plugins with extension API | Recurring revenue via add-on sales | XL | — | 12–16 | P3 | Not Started |
| 4.3 | **Event-triggered screen recording** | Short video clips on policy trigger | Kickidler/Veriato parity | XL | 1.6, 3.1 | 12–16 | P3 | Not Started |
| 4.4 | **Mobile agent** (Android/iOS) | Location + app tracking | Field teams (Hubstaff segment) | XL | 1.2 | 12–16 | P3 | Not Started |
| 4.5 | **SSO (OIDC/SAML) + SCIM** | Enterprise identity | Enterprise-only deals | L | 1.1 | 8–12 | P3 | Not Started |
| 4.6 | **Upgrade/license server** | Self-hosted updater + paid major upgrades | Version-upgrade revenue model | L | 1.12 | 6–8 | P3 | Not Started |

---

## 5. Release Targets

| Milestone | Scope | Target |
|---|---|---|
| **Alpha (internal)** | 1.1–1.8 core | Week 4 of Phase 1 |
| **Beta (3 pilot buyers)** | 1.1–1.10 | Week 6 of Phase 1 |
| **CodeCanyon v1.0 launch** | Phase 1 complete + docs + screenshots | End of Phase 1 |
| v1.x maintenance | Bug fixes + minor features (free) | Ongoing |
| **v2.0 (paid upgrade)** | Phase 2 complete | After Phase 2 |
| v3.0 (paid upgrade) | Phase 3 | After Phase 3 |

---

## 6. Related Files

- `workload/00-Product-Vision.md` — vision, buyers, success metrics
- `workload/02-Feature-Matrix.md` — full feature × stack matrix
- `workload/03-Backlog.md` — every outstanding item with priority/effort/dependencies
- `workload/04-Sprint-01.md`, `workload/05-Sprint-02.md` — current sprint plans
- `workload/07-Progress.md` — append-only work history
- `workload/08-Known-Issues.md` — audit findings tracked to resolution
- `workload/09-Architecture-Decisions.md` — ADRs
- `workload/10-Agent-Roadmap.md`, `workload/11-AI-Roadmap.md` — component roadmaps
- `workload/12-Release-Checklist.md`, `workload/13-CodeCanyon-Checklist.md` — release gates
- `workload/14-Deployment.md` — deployment guide
- `workload/15-Release-History.md` — SemVer history
- `workload/16-Future-Ideas.md` — deferred ideas & research notes
- `workload/06-Completed.md` — verified-done features
