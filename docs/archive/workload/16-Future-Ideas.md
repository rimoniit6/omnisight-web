# WorkLensAI — Future Ideas & Research Notes

> **File:** workload/16-Future-Ideas.md · **Renamed:** 2026-08-02 (content preserved)

> Post-MVP / non-core ideas collected from market research, competitor analysis, and review mining. Nothing here is committed; revisit after MVP launch.

---

## 🟣 Enterprise-only (deferred deliberately)

| Idea | Source | Why deferred |
|---|---|---|
| SSO (OIDC/SAML) + SCIM provisioning | Teramind/Insightful enterprise tier | Only 1% of CodeCanyon buyers; big auth work (Backlog BL-405) |
| DLP engine (USB/file/clipboard blocking, OCR content rules) | Teramind core | Real value, but Phase 3 after MVP revenue (BL-301) |
| UEBA / anomaly detection baselines | Teramind, Veriato | Needs months of real telemetry data to tune (BL-306) |
| Forensic video recording (continuous/event-triggered) | Kickidler, Veriato | Storage + privacy complexity (BL-403) |
| Psycholinguistic/sentiment analysis | Veriato | Ethical + accuracy concerns; not for MVP |
| Legal hold / chain of custody | Veriato | Niche compliance; after audit log exists |
| On-prem air-gapped + offline license renewal files | docs | Already designed; implement with ADR-009 licensing |

## 🟡 Nice-to-have (competitive differentiators)

| Idea | Source | Notes |
|---|---|---|
| **Employee transparency portal** (see own data, private-time toggle, blur/delete personal activity) | DeskTime, review complaints | Strong trust + GDPR story → Phase 2 (BL-203) |
| **Calendar-aware auto-pause** (auto-pause tracking during meetings) | review requests | Phase 2; requires Google/Outlook calendar integration |
| Blur-sensitive screenshot regions (auto-redact passwords/PII) | ActivTrak add-on | Phase 2 with OCR (BL-201) |
| Pomodoro / break nudges | DeskTime, Time Doctor | Cheap to add; employee-side |
| Distraction pop-ups (nudge back to work) | Time Doctor | Polarizing — make optional per policy |
| Idle-accuracy calibration (reading/meeting detection) | Hubstaff complaints | Improve agent heuristics; high trust impact |
| Mobile agent (Android/iOS) + GPS/geofence | Hubstaff | Field teams; Phase 4 (BL-404) |
| Payroll/invoicing integrations | Hubstaff | Different buyer segment; likely out of scope |
| Live multi-screen grid viewing | Kickidler | Phase 4; real-time infra needed |
| Workload balance & burnout analytics | ActivTrak | Phase 3 (BL-302) |
| Benchmark data vs industry | ActivTrak | Requires anonymized telemetry — conflicts with privacy-first story; careful |

## 💡 Product/marketing ideas

| Idea | Notes |
|---|---|
| **Ollama one-click local LLM** (no external API needed) | Killer self-host story: zero external calls. Phase 3+. |
| White-label reseller tier (brand + domain) | MSPs/resellers will pay extra (BL-304) |
| CodeCanyon listing assets: 60–90s demo video, 8 screenshots, comparison table vs Teramind/ActivTrak | Required for listing conversion |
| Free "Community" limited edition to drive reviews | Consider after v1.0 revenue confirms |
| Plugin marketplace (signed add-ons) | Phase 4 revenue (BL-402) |
| Paid major-version upgrades via vendor update server | Business model per PRD (BL-406) |

## ❌ Explicitly not planned (tracked to avoid re-litigating)

- Multi-tenant SaaS / workspaces (contradicts one-time self-host model)
- Redis/Kafka queue infrastructure at MVP scale
- Kubernetes/helm (Docker Compose is the target)
- Managed cloud hosting by vendor (conflicts with "no hosted cloud" promise)
