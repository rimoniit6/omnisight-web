# WorkLensAI — Windows Agent Roadmap

> **File:** workload/10-Agent-Roadmap.md · **Created:** 2026-08-02
> Companion to 01-Roadmap.md (Phase 1/2 items) and 09-Architecture-Decisions.md (ADR-002 = C#/.NET 8, ADR-007 = batched HTTPS JSON).

---

## 1. Positioning

The Windows Agent is **the product's data source** — without it, the platform is an empty shell. Competitor pain points to avoid: high CPU/RAM (Teramind complaints), AV false positives, inaccurate idle detection (Hubstaff complaints).

**Guiding constraints:**
- Idle CPU < 2%; RAM < 100 MB
- Signed binaries (EV code-signing cert) to avoid AV flags
- Offline-first: never lose events (local SQLite queue, delta sync)
- Per-device authentication token; device can only read/write its own data
- Configurable telemetry policies pushed from the server

---

## 2. Version Plan

| Version | Scope | Effort | Status |
|---|---|---|---|
| **Agent v0.1 (Sprint 02)** | Core telemetry: active window, app/website title+URL, idle detection, login/logout sessions, heartbeat, registration, offline queue, silent install + tray | 15–20 pd | Not Started |
| **Agent v0.2 (Sprint 02/03)** | Screenshot capture (interval, DPI-aware, JPEG/WebP, blur option), upload + retry, retention awareness | 6–8 pd | Not Started |
| **Agent v0.3 (Phase 2)** | Auto-update channel (silent), uninstall-protection toggle, config push from server, app-category overrides | 5–7 pd | Not Started |
| **Agent v1.0 (release)** | Hardened, signed, documented; MSI + EXE installers; group-policy deployment guide | 3–4 pd | Not Started |
| **Agent v2.x (Phase 3)** | Event-triggered video clips (DLP), advanced idle calibration, network/USB forensics | 12–16 pd | Deferred |
| **Agent v3.x (Phase 4)** | macOS + Linux agents, mobile (Android/iOS) | 12–16 pd | Deferred |

---

## 3. Feature Backlog (Agent)

| Feature | Description | Business Value | Complexity | Deps | Effort | Priority | Status |
|---|---|---|---|---|---|---|---|
| Active window + app tracking | Foreground app name/title via Win32 `GetForegroundWindow` | Table stakes | M | — | 4–5 | P0 | Not Started |
| Website/URL tracking | Browser title + URL from accessibility APIs / extensions | Table stakes | M | app tracking | 3–4 | P0 | Not Started |
| Idle detection | Keyboard/mouse hook; configurable threshold | Table stakes | S | — | 1–2 | P0 | Not Started |
| Session tracking | Login/logout/lock/unlock timestamps | Reports need hours | S | — | 1–2 | P0 | Not Started |
| Local offline queue | SQLite buffer with delta sync + conflict handling | Never lose data | M | — | 3–4 | P0 | Not Started |
| Device registration + heartbeat | One-time token enrollment; status pings | Fleet visibility | S | server side | 2–3 | P0 | Not Started |
| Screenshot capture | Configurable interval; blur/PII option; WebP | Visual monitoring | L | app tracking | 6–8 | P0 | Not Started |
| Config push | Server → agent policy (interval, categories, private time) | Trust + customization | M | heartbeat | 3–4 | P1 | Not Started |
| Private-time toggle | User pauses tracking (visible to admin) | Trust feature | M | — | 3–4 | P1 | Not Started |
| Auto-update | Silent download/install of new version | Fleet hygiene | L | signing | 5–7 | P1 | Not Started |
| Uninstall protection | Optional PIN/registry hardening | Tamper deterrence | M | — | 2–3 | P1 | Not Started |
| Resource guarantees | CPU/RAM caps, AV-signing, crash reporting (opt-in, no user data) | Operational trust | M | — | 2–3 | P0 | Not Started |

---

## 4. Milestones

| Milestone | Target | Gate |
|---|---|---|
| Spike: proof of active-window + idle capture | Week 1 Sprint 02 | Demo on 2 machines |
| v0.1 beta internal | Week 2 Sprint 02 | 24h soak, <2% CPU |
| v0.2 with screenshots | Week 3 Sprint 02 | Screenshot viewer E2E |
| v1.0 signed release + docs | Beta (end Phase 1) | 3 pilot buyers installed |
