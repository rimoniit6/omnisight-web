# OmniSight — Privacy

> Previously branded as **WorkLensAI** — legacy identifiers are intentionally preserved.

A plain-language description of how employee data flows through the system, what is stored, what is never stored, and how consent is enforced. Every statement reflects the actual implementation.

Related docs: [COMPANY-GUIDE.md](./COMPANY-GUIDE.md) · [EMPLOYEE-GUIDE.md](./EMPLOYEE-GUIDE.md) · [SECURITY.md](./SECURITY.md) · [FEATURES.md](./FEATURES.md)

---

## 1. Consent model

- **8 consent types**: `monitoring`, `screenshot`, `activity_tracking`, `keystroke`, `usb_monitoring`, `webcam_access`, `location`, `email_monitoring`.
- Statuses: `pending | granted | denied | revoked | expired` (pending for auto-created at employee creation; expired → re-consent).
- Consent is **versioned**: each grant binds the currently **published** policy version (`policyVersion`). Publishing policy v2 archives v1 and requires re-consent from employees bound to v1.
- **Fail-closed**: telemetry of a type is accepted only when org setting + active granted consent + agent capability all allow it. Missing/granted-without-policy → denied. Revocation stops collection immediately (server 403s uploads, and agent enforces locally).
- Every transition is written to the immutable `ConsentLog` (who, from, to, policy version).
- Bulk grant/revoke available to managers (batch, bounded); admin can change individual rows directly.

## 2. What the system collects (per type)

| Type | Stored | Never stored |
|---|---|---|
| Activity tracking | app name + category (server-derived), window title (activity rows), duration, website **bare domains** | full URLs, browser history, typed text |
| Screenshots | PNG/JPEG/WebP images (magic-byte validated, ≤ 5 MB) + agent-side OCR text | — (see §6 for retention) |
| Keystroke | aggregate counts and typing intervals (1-min buckets, per-app breakdown) | raw keystrokes, key content, clipboard, input text |
| USB monitoring | device vendor/product/serial/device IDs at insert/remove, aggregated event counts | file contents, data transferred |
| Webcam access | session metadata (start/end, reason) only | video frames (in-memory relay only, TTL 60 s, never persisted) |
| Location | lat/long coordinates, accuracy, timestamp | street addresses, reverse-geocoded names |
| Email monitoring | — (setting + consent type exist; no server collector implemented) | email contents |

## 3. Enforcement points

1. **Agent-side**: collectors check local config + cached consent + addon capability before capturing (fail-closed — no addon ⇒ no data).
2. **Server-side**: every `/api/agent/*` ingestion re-validates org setting + consent (`hasActiveConsent`, policy-bound) + device binding; violations → 403, data dropped.
3. **Read-side**: employee telemetry endpoints gate on the same consent/config before returning data.
4. **Break mode**: during an active break, activity/screenshot/keyboard/location collectors suspend; `BreakSession` keeps the boundary canonical (unique partial index: one active break per employee).

## 4. Data minimization guarantees

- **Websites**: server converts any input to **bare domains** (e.g. `https://sub.example.com/path?q=1` → `example.com`) before storage; realtime broadcasts send domains only; the browser extension (Manifest V3) reports the active tab's domain only.
- **Keystrokes**: raw-key fields are rejected by the API (422); only aggregate intervals/active-seconds are stored.
- **Location**: only coordinates; no reverse geocoding, no addresses.
- **Webcam**: `webcam.start` command required + consent + config; frames relayed in-memory to a single live viewer and **never written to disk or the database**; sessions end on timeout/disconnect/revocation/config disable.
- **Screenshots**: capture cadence from org settings (min 30 s); OCR text is searchable; images served privately with `nosniff`.
- **Agent collector consent window**: `GET /api/agent/consent` returns the employee's consent state; the agent refreshes every 60 s.

## 5. Roles & access control

- `viewer` — read-only telemetry (no management).
- `manager` — consent management, notifications, anomalies, reports, self-portal view of individual employees.
- `admin` — employees/devices/settings/commands/screenshot analysis; `owner` adds org settings + user management; `super_admin` — system settings, any-org support, first org creation.
- Agents never see other employees' data; tokens are device-bound and org-scoped.

## 6. Retention & deletion

- Per-class retention (days, 0 = keep forever) in `Settings → Monitoring → Data Retention`: activity/screenshots/keystrokes/location/audit logs/reports/notifications/consent logs/sentiment.
- Enforced by the hourly `retention_cleanup` job (deletes rows; screenshots delete files; audit + consent logs **anonymized, never deleted**).
- Deleting an employee archives the record; screenshots remain reviewable. Employees' data is never sold or shared — it stays in your PostgreSQL instance.

## 7. AI & third parties

- AI is **on-demand only** (insights, sentiment, daily summary, screenshot analysis — manager/admin initiated). No background/scheduled AI processing.
- Prompts carry measured, aggregated, consent-gated data; when a provider is unavailable the app shows a deterministic **Data Summary** with a reason — no fabricated AI content.
- **No telemetry to AI providers at rest**: keys stay on your server (AES-256-GCM). Data leaves your network only when an operator explicitly runs an analysis against a BYOK provider.
- The desktop agent checks updates against `WL_UPDATE_URL` (HTTPS) — when unset, no update checks occur.

## 8. Employee rights (as implemented)

Employees can: view their own data via the Employee Portal (manager-assisted view), revoke any granted consent themselves (portal **Revoke Consent** with confirmation; manager can also revoke), and request re-consent after policy updates (v1→v2 transition marks consent for renewal). There is **no employee self-service login** — consent and data access are governed by the organization's admins.

## 9. Guidance (not legal advice)

- Post a clear privacy notice and obtain consent *before* enabling monitoring (system enforces consent gating but not notice).
- Publish consent policies (versions) and re-consent on material changes — the system supports both.
- The email monitoring consent type exists and can be granted, but **no email content is ever collected** by the current implementation.
- See `docs/company-guide/` background materials (present in git history) and the audit evidence in `docs/audits/`.
