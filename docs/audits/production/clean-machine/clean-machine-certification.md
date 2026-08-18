# Phase C — Clean-Machine Certification Runbook

**Purpose:** the primary release gate for OmniSight. A fresh Windows machine
(no developer tooling, no prior installs) must install the packaged agent and
complete the true zero-touch journey with the employee doing **nothing**.

---

## Artifacts to bring to the clean machine

| Artifact | Path on the build machine |
|---|---|
| Agent installer | `desktop-agent/out/OmniSight Agent Setup 1.0.0.exe` (82 MB, NSIS, per-user) |
| Admin server URL | The URL of the running Admin Web App (control plane) |
| Certification script | `scripts/clean-machine-certification.ps1` |
| This runbook | `docs/clean-machine-certification.md` |

> **Production note:** the packaged agent resolves its server from the
> `WORKLENSAI_SERVER_URL` environment variable (default `http://localhost:3000`).
> On a clean machine the admin server lives on another host, so the environment
> variable (or a baked-at-build default) must point at it. The certification
> script sets it before launch. For a customer rollout, set this variable
> machine-wide via the installer or a group policy; there is no UI prompt.

---

## PART 4 — Clean Windows Machine Installation

### Machine requirements
- Windows 10/11 x64, **not** containing: Node.js, Git, source repo, VS/VS Code,
  previous OmniSight Agent install, previous `%APPDATA%\worklensai-agent`.

### Steps
1. Copy the installer + `clean-machine-certification.ps1` to the machine.
2. **Manual click-through (required, Part 4 steps 1–8):**
   - Double-click `OmniSight Agent Setup 1.0.0.exe`.
   - Expect the NSIS wizard; accept defaults (per-user install).
   - Wait for "Installation Complete".
   - Open the Start menu → confirm **"OmniSight Agent"** shortcut exists.
   - Launch the agent from the shortcut.
   - Confirm: window appears, **no crash**, and the header shows
     `Setting up this device…` — **never** a stuck "Starting…".
3. **Automated evidence capture:**
   ```powershell
   powershell -ExecutionPolicy Bypass -File clean-machine-certification.ps1 -ServerUrl http://<ADMIN-SERVER>:3000
   ```
   This runs the installer silently (separate from the manual run above),
   verifies install + shortcut + launch + no-crash + native addon packaging,
   and writes `%TEMP%\wl-clean-machine-evidence.txt`.

### Pass criteria (Part 4)
1. Installer launches ✅  2. Installs successfully ✅  3. Start-menu shortcut ✅
4. Agent launches ✅  5. No crash ✅  6. No "Starting…" freeze ✅
7. Native addon loads (`resources/native/worklens_capture.node` present) ✅
8. No developer tooling required ✅

---

## PART 5 — True Zero-Touch First Run

On the clean machine, with the Admin Web App running and reachable:

1. Launch the installed agent (from the Start menu).
2. **Do not enter anything** — no Employee ID, no password, no email, no
   registration code, no department, no project, no organization ID.
3. Expected agent-side states (all automatic):
   - `Setting up this device…` (first paint, immediate)
   - automatic device discovery (`POST /api/agent/discover`)
   - `Waiting for administrator approval` (poll every 20s)
4. On the **Admin** side (control plane):
   - Devices → **Zero-Touch Devices** tab → the machine appears as
     **PENDING** with real metadata (hostname, OS, agent version).
   - Approve & Activate → select the Employee → Department auto-resolves →
     select Project(s) → **Approve & Activate**.
   - Note: approval grants **no consent** — monitoring stays off.
5. Agent-side automatically:
   - detects approval within ~20s
   - authenticates with the one-time device credential
   - transitions to **Connected** and shows Employee / Department / Projects
     (server-derived).
6. Screenshot each state (agent PENDING → admin dialog → agent Connected).

### Pass criteria (Part 5)
- ZERO employee input. ✅
- Agent log contains: `zero-touch-discover-start` →
  `zero-touch-discover-done authPhase=pending_approval` → renderer `PENDING` →
  `approval-poll to=authenticated` → `runtime-started`.

---

## Evidence to return from the clean machine
- `%TEMP%\wl-clean-machine-evidence.txt` (certification PASS/FAIL table)
- Screenshots: (a) PENDING screen, (b) admin approve dialog, (c) Connected
  screen showing Employee/Department/Projects, (d) consent pills showing
  server truth (Not granted).

## Known warnings
- Installer is **unsigned** — Windows SmartScreen shows "unknown publisher".
  Users must click "More info → Run anyway". A code-signing certificate is a
  prerequisite for a friction-free customer rollout.
- The agent is a per-user install (`%LOCALAPPDATA%\Programs\OmniSightAgent`).
