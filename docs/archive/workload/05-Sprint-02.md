# Sprint 02 — Windows Agent, Telemetry & Real Dashboards

> **File:** workload/05-Sprint-02.md · **Renamed:** 2026-08-02 (content preserved)

> **Duration:** 3 weeks (15 working days) · **Goal:** The product's core loop works end-to-end: agent → server → dashboards → screenshots.
> **Prerequisite:** Sprint 01 done. Scope: BL-101…BL-110, BL-114.

---

## Sprint Goals

1. A buyer can install the Windows Agent on a PC and see real data in the dashboard within minutes.
2. Screenshots are captured, stored, and viewable with blur/retention controls.
3. Docker Compose deploy + buyer docs are ready for beta buyers.

---

## Tasks

| # | Task | AC | Est. | Status |
|---|---|---|---|---|
| S2.1 | Windows Agent skeleton (C#/.NET 8, self-contained, signed) | Installs silently; tray icon; runs as service; <2% CPU idle | 4–5d | Not Started |
| S2.2 | Agent telemetry: active window, app/website URL+title, idle detection, login/logout sessions | Events persisted to local SQLite queue; correct idle thresholds configurable | 4–5d | Not Started |
| S2.3 | Agent registration + heartbeat + per-device token (server side) | Device registers once → stable token; heartbeat updates status; Devices UI live | 3–4d | Not Started |
| S2.4 | Ingestion API `POST /api/agent/ingest` (gzip, batched, validated, rate-limited) | Agent uploads; data appears in activity timeline with device+user attribution | 4–5d | Not Started |
| S2.5 | Screenshot capture (configurable interval, DPI-aware, JPEG/WebP) + upload | Files on `STORAGE_PATH`; retention job purges per policy | 4–5d | Not Started |
| S2.6 | Screenshot viewer UI (list, lightbox, blur-sensitive toggle, search by time) | Admin views screenshots per employee/device; blur works client-side | 3–4d | Not Started |
| S2.7 | Analytics engine v1: productivity/focus/risk/trends from real events (SQL aggregation) | Numbers change only when data changes; charts render from API | 4–5d | Not Started |
| S2.8 | Dashboard/Activity/Profile consume ingestion data end-to-end | E2E: agent event → visible on dashboard trend within 30s | 2–3d | Not Started |
| S2.9 | CSV export (activity + timesheet per user/team) | Real file download; no mock | 2–3d | Not Started |
| S2.10 | Docker Compose (web + db + storage) + native install docs + `.env.example` | Fresh VM: `docker compose up -d` → login → register agent → see data | 4–5d | Not Started |
| S2.11 | Buyer docs: install guide, agent deployment (group policy/MSI), quick start, FAQ, screenshots | A non-technical buyer can self-serve | 3–4d | Not Started |
| S2.12 | Simple offline license key validation (setup wizard step) | Install requires key; offline grace period works; no phone-home | 2–3d | Not Started |
| S2.13 | Playwright smoke suite (login→dashboard→devices→screenshots) in CI | Green CI on every PR | 2–3d | Not Started |

**Total estimate:** ~38–47 person-days (2 developers ≈ 3 weeks; agent work can proceed in parallel with backend).

---

## Definition of Done (Sprint 02)

- [ ] Beta build available: Docker image + agent installer bundle
- [ ] 3 pilot buyers installed and seeing real data (beta)
- [ ] No `Math.random`/mock data paths in the app
- [ ] Backup/restore runbook drafted (finish in Sprint 03 as BL-208)
- [ ] Progress.md + Completed.md updated

---

## Risks / Notes

- **Agent build time is the critical path** — start S2.1 immediately; backend ingestion can be mocked with a dev uploader script.
- Signed binaries (EV cert) reduce AV false positives — budget for a signing cert.
- Screenshot storage privacy: blur-by-default toggle per policy (Settings) to pre-empt surveillance complaints.
