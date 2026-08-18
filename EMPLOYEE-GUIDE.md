# OmniSight — Employee Guide

> Previously branded as **WorkLensAI** — legacy identifiers are intentionally preserved.

What employees should know about the desktop agent on their machine, and what managers see in the console.

Related docs: [PRIVACY.md](./PRIVACY.md) · [USAGE.md](./USAGE.md) · [COMPANY-GUIDE.md](./COMPANY-GUIDE.md)

---

## 1. What is installed

The **OmniSight Agent** is a small Windows program (Electron-based, runs from the tray) that tracks how your work time is used, so your employer can analyze productivity. It was deployed by your organization's IT — it is not something you install yourself.

- **App data** lives in `%APPDATA%\worklensai-agent` (logs, encrypted screenshot spool).
- **No Quit option** — the tray menu intentionally has no exit item; the agent lifecycle is managed by your organization.

## 2. What the agent collects

| Type | Details |
|---|---|
| Activity | which app/window you're working in (window titles), for how long |
| Websites | the **domain names** only (e.g. `example.com`) — never full URLs or page content |
| Screenshots | only if enabled by your org; interval ≥ 30 s; OCR text searchable by admins |
| Keystrokes | **counts only** (how much you typed, per minute/app) — never what you typed |
| USB devices | plug/unplug events (device names/IDs), not file contents |
| Location | only if enabled; coordinates only, no street addresses |
| Webcam | only during an operator-initiated live session, and only if consented + enabled; frames are streamed live and **never stored** |

If you're unsure what's enabled, your org's settings determine each type — see the tray agent status window or ask your manager.

## 3. What the agent never collects

- Raw keystrokes, clipboard content, typed text
- Full URLs, browser history, email content
- Webcam recordings (frames are in-memory only, never saved)
- Anything outside an active, granted consent for that type

## 4. Consent

Your organization manages consents (types: monitoring, screenshot, activity tracking, keystroke, USB monitoring, webcam access, location, email monitoring). Collection happens **only** when your org has both the setting enabled and your consent granted.

- **Policies are versioned**: when your org publishes a new policy version for a type, your consent may need renewal.
- **You can revoke** granted consents via the Employee Portal (admin-assisted view) — revocation stops collection immediately.
- **Break / Privacy Mode**: if enabled, you can start a break (agent shows privacy mode); during a break, activity/screenshot/keystroke/location collection pauses until you resume.

## 5. Status window

Opening the agent (tray icon) shows one of:

| State | Meaning |
|---|---|
| Onboarding | enter your server URL (first run only) |
| Login | log in with your Agent Account credentials |
| Pending | waiting for admin approval of your device |
| Rejected / Revoked | admin declined/ended your device's access |
| Conflict | another device is active for your account — contact your manager |
| Offline | server unreachable; telemetry queues and uploads later |
| Status / Monitoring | all good — tracking active per your consent |

## 6. Your data at work

Managers/admins can see: your activity timeline, app/website domains, screenshots (if enabled), keyboard aggregates, location fixes, webcam session metadata, breaks, alerts, anomalies, AI insights and sentiment about your work patterns, and projects/time.

You can see the same per-employee view via **Employee Portal** (manager+): Overview (hours today, weekly productivity, devices, consent status, Break/Privacy Mode card, **Revoke Consent** button), Consents, Anomalies, Projects, and Telemetry tabs.

## 7. What to do if something seems wrong

- Agent stuck on "pending" → ask your manager to approve in **Agent Approvals**.
- "Conflict" → another device is active for you; ask your manager to fix it (never install the agent on a second machine without approval).
- A type you consented to stopped appearing → check org settings (config refresh every 10 min) and the break state.
- Suspected unauthorized access to your data → report to your org admin; the audit log records who accessed what.
