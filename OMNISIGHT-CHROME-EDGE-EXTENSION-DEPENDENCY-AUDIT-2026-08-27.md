# OMNISIGHT CHROME/EDGE EXTENSION DEPENDENCY AUDIT

**Date:** 2026-08-27
**Mode:** READ-ONLY AUDIT — no source, configuration, or build modifications
**Scope:** Complete dependency analysis of the Chrome/Edge Browser Extension requirement
**Repositories:** omnisight-web (admin panel + server) · omnisight-agent (desktop agent, separate repo) · browser-extension/

---

## 1. Executive Summary

**The Chrome/Edge Extension ID is NOT genuinely required by the current OmniSight Agent.**

The extension is an **optional, best-effort accuracy enhancement** for website domain tracking. The core Agent can build, start, authenticate, and collect website domains **without** the extension being installed or an Extension ID being provided.

The Extension ID is currently made mandatory in the **desktop agent's build pipeline** (`omnisight-agent/scripts/install-native-host.mjs`) and in the **native messaging host manifest template** (`browser-extension/native-messaging/com.worklensai.website.json`), but this requirement is only necessary when the browser extension feature is actually enabled. The extension and native messaging host are not required for the Agent to function.

**Recommendation: OPTION C — Browser Extension functionality is optional and should be feature-gated behind a configuration flag, with the Extension ID requirement made conditional (not mandatory).**

---

## 2. Current Product Requirement

The stated product requirement is:

> Chrome/Edge Browser Extension is NOT part of the current OmniSight release. The current OmniSight Agent should be able to build and operate without requiring a Chrome/Edge Extension ID.

This is **confirmed as correct by codebase evidence**:

- `FEATURES.md` line 37: `Website tracking (browser extension) | Partial | Best-effort (websiteNativeTracking opt-in)`
- `USAGE.md` line 98: "the agent's website collector works without a browser extension; the **browser extension** is an optional extra source"
- `README.md` line 32: "Partially implemented: website tracking via browser extension (`websiteNativeTracking` is best-effort)"
- `TROUBLESHOOTING.md` line 41: "the browser extension is optional (`website_native_tracking_enabled`)"
- `ADMIN-GUIDE.md` line 44: `website_native_tracking_enabled (false) | allow browser-extension path`

---

## 3. Extension References — Complete Inventory

### 3.1 Browser Extension Source Code

| File | Purpose | Runtime-Critical | Build-Critical |
|---|---|---|---|
| `browser-extension/manifest.json` | MV3 manifest, pins public key for deterministic ID, permissions: tabs/webNavigation/nativeMessaging | NO (extension only) | NO |
| `browser-extension/package.json` | Package metadata for `worklensai-website-tracker` | NO | NO |
| `browser-extension/src/background.js` | Service worker: active-tab tracking, native messaging connection, domain normalization, bounded buffer (100 events) | NO (extension only) | NO |
| `browser-extension/src/shared/domain.js` | Domain-only normalization (mirrors `src/lib/domain.ts` and `omnisight-agent/src/lib/domain.ts`) | NO (extension only) | NO |
| `browser-extension/tests/domain.test.mjs` | Unit tests for domain normalization | NO | NO |

### 3.2 Native Messaging Host Manifests

| File | Purpose | Runtime-Critical | Build-Critical |
|---|---|---|---|
| `browser-extension/native-messaging/com.worklensai.website.json` | Chrome/Edge native host manifest with `allowed_origins` using `__CHROME_EXTENSION_ID__` and `__EDGE_EXTENSION_ID__` placeholders | NO (extension only) | NO |
| `browser-extension/native-messaging/com.worklensai.website.firefox.json` | Firefox native host manifest using `allowed_extensions: website-tracker@worklens.ai` | NO (extension only) | NO |

### 3.3 Server-Side References

| File | Line | Purpose |
|---|---|---|
| `src/lib/domain.ts` | 16 | Comment referencing extension's `shared/domain.js` mirror |
| `src/lib/jobs/settings.ts` | 94 | `website_native_tracking` setting (boolean, default false) |
| `src/app/api/agent/config/route.ts` | 66 | Sends `websiteNativeTracking` to agent in config |
| `src/components/settings/settings-page.tsx` | 430 | Helper text: "Website tracking requires either the OmniSight browser extension OR Native Website Tracking" |
| `tests/website-100.test.ts` | 175-207 | Source invariants for extension + native host manifest |

### 3.4 Desktop Agent References (omnisight-agent — separate repo)

| Component | Location | Purpose |
|---|---|---|
| Website Bridge Server | `desktop-agent/src/services/website-bridge.ts` | Loopback TCP + token handshake; receives events from native host |
| Website Bridge Client | `desktop-agent/native-host/launcher.c` | Relays stdin↔socket between native host and bridge |
| Native Messaging Host Mode | `desktop-agent/src/main/native-host.ts` | `--native-messaging-host` flag entry point |
| Website Collector | `desktop-agent/src/collectors/website-collector.ts` | Aggregates domain events into visit slices |
| BrowserActivityMonitor | `desktop-agent/src/services/browser-activity-monitor.ts` | Agent-native website source (reads foreground window title) |
| Install Native Host Script | `desktop-agent/scripts/install-native-host.mjs` | Registers native host in Windows registry, validates extension ID |

---

## 4. Website Bridge Analysis

### 4.1 Why Does website-bridge Exist?

The website bridge exists as the **transport mechanism** between the browser extension and the desktop agent's WebsiteCollector. When the browser extension reports a domain change via Chrome Native Messaging, the message flows:

```
Extension (browser-extension/src/background.js)
  → chrome.runtime.connectNative('com.worklensai.website')
    → Native Messaging Host (worklens-native-host.exe, launcher.c)
      → WebsiteBridgeClient (TCP 127.0.0.1 + token)
        → WebsiteBridgeServer (website-bridge.ts)
          → WebsiteCollector (website-collector.ts)
```

### 4.2 Does It Require Chrome/Edge Extension?

**YES — the bridge only receives data FROM the extension.** It cannot generate events on its own. Without the extension installed, the bridge simply has no connections and sits idle.

### 4.3 Does It Communicate Through Native Messaging?

**YES.** The data flow is:
1. Extension calls `chrome.runtime.connectNative(HOST_NAME)` (line 40 of `background.js`)
2. Native messaging host (`worklens-native-host.exe`) reads framed messages from stdin
3. Host connects to the bridge via TCP loopback with a shared 32-byte token
4. Bridge forwards events to WebsiteCollector

### 4.4 Is the Extension Required For These Features?

| Feature | Extension Required? | Evidence |
|---|---|---|
| Browser activity collection (general) | **NO** | `BrowserActivityMonitor` provides best-effort collection without extension |
| Domain tracking (extension-based, high accuracy) | **YES** | Extension is the only source of true active-tab domain data |
| Active tab detection (exact) | **YES** | Only the extension knows which tab is active in the focused window |
| Visit duration (exact) | **YES** | Extension provides `isActive` flag for precise slice boundaries |
| Website categorization | **NO** | `categorizeDomain()` runs server-side on any domain string |
| Working-hours enforcement | **NO** | Config-driven gate in the agent, independent of extension |

### 4.5 Can website-bridge Operate Without an Extension?

**YES — it simply idles.** The bridge is a TCP server that accepts connections. Without the native messaging host connecting (which requires the extension), no data flows. The agent continues operating normally with all other collectors.

### 4.6 Is It Production or Legacy?

**Production — but optional.** The bridge is fully implemented and tested (unit tests pass, live E2E verified in audit docs). It is NOT deprecated or unused — it is an **optional feature** that provides higher-accuracy website tracking when the extension is installed. The `DESKTOP-AGENT-FINAL-AUDIT.md` confirms the bridge is live and working with real extension connections.

---

## 5. Native Messaging Audit

### 5.1 Native Messaging Host Manifest Location

- `browser-extension/native-messaging/com.worklensai.website.json` (template with placeholders)
- `desktop-agent/native-host-manifests/{chrome,edge,firefox}.json` (runtime manifests, generated by `install-native-host.mjs`)

### 5.2 Host Executable

- `worklens-native-host.exe` — C launcher (`desktop-agent/native-host/launcher.c`)
- Reads agent's `website-bridge.json` for loopback port + token
- Connects to bridge via TCP, relays framed stdin↔socket↔stdout
- Compile via `desktop-agent/scripts/build-native-host.mjs`

### 5.3 Host Registration

- `install-native-host.mjs` registers under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.worklensai.website` (and Edge equivalent)
- **Fails closed on placeholder/wildcard extension IDs**

### 5.4 Extension ID Injection

The native messaging host manifest contains:
```json
{
  "allowed_origins": [
    "chrome-extension://__CHROME_EXTENSION_ID__/",
    "chrome-extension://__EDGE_EXTENSION_ID__/"
  ]
}
```

The `install-native-host.mjs` script replaces these with the actual extension ID derived from the manifest's pinned public key (`deriveExtensionIdFromKey()`). The test `WEBSITE-100-16` verifies this derivation is deterministic.

### 5.5 Key Answers

| Question | Answer |
|---|---|
| **A. Is Native Messaging always required?** | **NO.** Only when browser extension tracking is enabled AND the extension is installed |
| **B. Is it required only when browser monitoring is enabled?** | **YES.** `website_native_tracking=false` (default) means no native host is needed |
| **C. Is it required for the Agent to start?** | **NO.** The Agent starts, authenticates, and operates all core collectors without it |
| **D. Is it required for core Agent features?** | **NO.** Activity, screenshot, keyboard, location, webcam, USB, policy — all work without it |
| **E. Does the Agent fail if the extension is missing?** | **NO.** The bridge sits idle; the agent continues with other data sources |
| **F. Does the Agent Builder fail if extension ID is missing?** | **YES — currently.** This is the exact issue under investigation |

---

## 6. Feature Dependency Matrix

| Agent Feature | Requires Extension? | Requires Native Messaging? | Works Without Extension? | Evidence |
|---|---|---|---|---|
| Agent startup | NO | NO | **YES** | Lifecycle phases in `main.ts` have no extension dependency |
| Authentication | NO | NO | **YES** | `POST /api/agent/authenticate` — no extension fields in payload |
| Device registration | NO | NO | **YES** | `POST /api/agent/discover` — hostname+OS only |
| Device approval | NO | NO | **YES** | Admin action; no extension dependency |
| Heartbeat | NO | NO | **YES** | `POST /api/agent/heartbeat` — device status only |
| Screenshot | NO | NO | **YES** | Native addon capture; no browser involvement |
| Location | NO | NO | **YES** | OS GPS fix via native addon |
| File management | NO | NO | **YES** | Queue uploader; no browser involvement |
| Camera | NO | NO | **YES** | Native addon camera API |
| USB monitoring | NO | NO | **YES** | Native addon USB API |
| Website monitoring (basic) | **NO** | **NO** | **YES** | `BrowserActivityMonitor` — reads foreground window title |
| Domain tracking (extension-based) | **YES** | **YES** | **NO** | Only source of exact active-tab domains |
| Working hours | NO | NO | **YES** | Config + org timezone |
| Consent | NO | NO | **YES** | `hasActiveConsent()` — no extension involvement |
| Policy enforcement | NO | NO | **YES** | `processList()` via native addon |
| Auto-update | NO | NO | **YES** | HTTPS feed; no browser involvement |
| Admin communication | NO | NO | **YES** | REST API; no browser involvement |
| Browser monitoring (extension) | **YES** | **YES** | **NO** | Extension is the exclusive data source for this path |

---

## 7. Build Pipeline Audit

### 7.1 Where Is Extension ID Validated?

The Extension ID validation occurs in the **desktop agent's build pipeline**, specifically in:

1. **`omnisight-agent/scripts/install-native-host.mjs`** — Generates the native host manifest with real extension IDs (replaces `__CHROME_EXTENSION_ID__` / `__EDGE_EXTENSION_ID__` placeholders)
2. **`omnisight-agent/scripts/build-prod.mjs`** — The production build script that orchestrates the NSIS installer

### 7.2 What Happens When It Is Missing?

Based on documentation and test invariants:
- The `install-native-host.mjs` script **refuses to register the host** with placeholder or wildcard extension IDs
- The agent build can proceed without the native host, but the installer won't include the browser extension bridge
- The `WEBSITE-100-16` test verifies that `allowed_origins` must match the derived ID (fail-closed)

### 7.3 Why Was It Made Mandatory?

The extension ID was made mandatory because:
1. Chrome/Edge **require** an exact extension ID in `allowed_origins` for native messaging security
2. Without a valid ID, the browser will refuse to connect to the native host
3. The build pipeline was designed to always include the browser extension feature

### 7.4 Is This Requirement Still Justified?

**NO — not for the current product scope.** The browser extension is:
- Explicitly documented as "best-effort" and "partial"
- Opt-in via `website_native_tracking` (default false)
- Not part of the current OmniSight release per product requirements
- The agent works fully without it

The Extension ID should be **optional** — required only when `website_native_tracking` is enabled.

---

## 8. Legacy/Current Status

### 8.1 Is This Code Legacy?

**The code is current and functional — but it is an OPTIONAL feature, not a core requirement.**

Evidence:
- `FEATURES.md` line 37: `Website tracking (browser extension) | Partial | Best-effort (websiteNativeTracking opt-in)`
- `README.md` line 32: "Partially implemented"
- `FEATURES.md` line 261: `website_native_tracking` defaults to false (fail-closed)
- The extension was E2E verified on 2026-08-13 (real machine, real Chrome + Edge)
- Browser extension tests: 7/7 PASS
- Desktop agent tests: 282/282 PASS (including native messaging host tests)

### 8.2 What IS the Status?

| Aspect | Status |
|---|---|
| Browser extension source code | **Complete** — MV3, Manifest pinned, domain normalization, native messaging |
| Native messaging host | **Complete** — C launcher, Windows registry registration, Chrome/Edge/Firefox support |
| Website bridge | **Complete** — loopback TCP + token auth |
| WebsiteCollector | **Complete** — event-driven, visit-slice aggregation |
| BrowserActivityMonitor | **Complete** — agent-native, best-effort (no extension needed) |
| Integration tests | **Passing** — 7/7 extension, 282/282 agent |
| Admin Panel configuration | **Incomplete** — no Extension ID configuration UI |
| Production deployment | **Gap** — "Extension not installed in current Chrome profile" (documented P3) |

### 8.3 Historical Evidence

The `REPOSITORY-CLEANUP-AUDIT.md` confirms:
- `browser-extension/` directory is intentional and tracked
- `com.worklensai.website` is a registered native messaging host name (must not be renamed)
- The extension has been published as "OmniSight Website Tracker"
- Firefox extension ID `website-tracker@worklens.ai` is immutable once published

---

## 9. Security Analysis

### 9.1 Would Removing the Mandatory Extension ID Create a Security Vulnerability?

**NO — if done correctly.** The security model already handles optional extension support:

1. **Native messaging origin validation** — Chrome/Edge enforce `allowed_origins` in the native host manifest; without a valid extension ID, the browser **refuses** the connection. This is enforced by the browser, not by the agent.

2. **Bridge authentication** — The website bridge uses a random 32-byte token written to `website-bridge.json` with OS-user ACL. Wrong token → connection closed.

3. **Loopback-only binding** — The bridge listens only on `127.0.0.1`, so remote connections are impossible.

4. **Fail-closed design** — Missing/invalid extension ID → native host won't register → no browser connection → no data collected.

### 9.2 Specific Security Considerations

| Threat | Mitigation | Status |
|---|---|---|
| Unauthorized browser connections | Native messaging origin validation (browser-enforced) | ✅ Safe |
| Spoofed browser clients | 32-byte random token + loopback-only | ✅ Safe |
| Native Messaging abuse | Extension ID required in manifest; browser validates | ✅ Safe |
| Localhost bridge abuse | Token auth + loopback-only binding | ✅ Safe |
| Origin validation | Chrome/Edge enforce `allowed_origins` | ✅ Safe |
| Authentication bypass | Bridge token validated before any data accepted | ✅ Safe |
| Token leakage | Token in `website-bridge.json` with 0600 perms (P3-8 finding, defense-in-depth only) | ⚠ Low risk |
| Renderer privilege escalation | N/A — bridge is server-side TCP | ✅ Not applicable |

### 9.3 Recommendation

Removing the **mandatory** Extension ID requirement does NOT create a security vulnerability. The correct architecture:

- When extension feature is **disabled** (`BROWSER_EXTENSION_ENABLED=false`): no Extension ID needed, no native host registered
- When extension feature is **enabled**: Extension ID becomes mandatory, native host is registered, origin validation enforced

---

## 10. Exact Reason Extension ID Is Currently Required

The Extension ID is mandatory because:

1. **`install-native-host.mjs` in the desktop agent** generates the native host manifest with real extension IDs replacing the `__CHROME_EXTENSION_ID__` / `__EDGE_EXTENSION_ID__` placeholders
2. **The build pipeline** (`build-prod.mjs`) includes the native host registration as part of the installer
3. **The native messaging protocol** requires exact extension IDs in `allowed_origins` for Chrome/Edge security
4. **The `WEBSITE-100-16` test** enforces that the manifest key-derived ID must match the installed host manifest

The core issue is that the build pipeline treats browser extension support as **always-on**, rather than **feature-gated**.

---

## 11. Is It Actually Necessary?

**NO.** The Extension ID is NOT necessary for the current OmniSight Agent to build and operate.

Evidence:
- The Agent's primary website data source (`BrowserActivityMonitor`) works **without** any browser involvement
- The `website_native_tracking` setting defaults to **false** — the extension path is explicitly opt-in
- All core Agent features (auth, heartbeat, screenshots, keyboard, location, webcam, USB, policy) work without the extension
- The extension is documented as "best-effort" and "partial"
- The current product requirement explicitly states the extension is NOT part of the current release

---

## 12. Recommended Architecture

### Option C: Feature-Gated Extension Support

```
BROWSER_EXTENSION_ENABLED=false   (default)
```

**When `false` (default):**
- No Extension ID required
- No Native Messaging host registered
- No native host manifest generated during build
- `website-bridge` not started (or starts but accepts no connections)
- `BrowserActivityMonitor` provides best-effort website tracking
- Agent builds and operates normally
- All core features functional

**When `true`:**
- Extension ID becomes mandatory at build time
- Native Messaging host is registered
- `website-bridge` accepts connections from the native host
- Extension events feed into `WebsiteCollector`
- Higher-accuracy website tracking (exact active-tab domain detection)
- Origin validation enforced

### Implementation Notes

1. **Server-side**: `website_native_tracking` already serves this purpose (org-scoped, default false). The agent config route already sends `websiteNativeTracking` to the agent.

2. **Agent-side**: The `BrowserActivityMonitor` already provides the extension-free path. The `WebsiteCollector` already handles both sources (extension events + monitor events).

3. **Build-side**: The `install-native-host.mjs` should check a build-time flag before requiring the Extension ID. If `BROWSER_EXTENSION_ENABLED=false`, skip native host registration.

4. **Security**: When disabled, no native host is registered, so no browser connection is possible. When enabled, the existing security model (origin validation, token auth, loopback-only) is sufficient.

---

## 13. Production Impact

### If Extension ID Requirement Is Made Optional

| Impact Area | Effect |
|---|---|
| Agent build | **POSITIVE** — builds succeed without Extension ID |
| Agent startup | **NONE** — no behavioral change |
| Core features | **NONE** — all collectors work as before |
| Website tracking | **POSITIVE** — `BrowserActivityMonitor` provides domain data without extension |
| Browser extension users | **NONE** — extension still works when enabled |
| Security posture | **NO CHANGE** — security model is feature-gated, not ID-gated |
| Admin Panel | **NONE** — `website_native_tracking` toggle already exists |

### If Extension ID Remains Mandatory

| Impact Area | Effect |
|---|---|
| Agent build | **NEGATIVE** — cannot build without Extension ID |
| Product delivery | **NEGATIVE** — extension is NOT part of current release |
| Developer experience | **NEGATIVE** — developers must provide unused credentials |
| Feature completeness | **NEGATIVE** — blocks agent deployment for organizations not using extension |

---

## 14. Risk Assessment

### Risk of Making Extension ID Optional

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Extension stops working when enabled | LOW | HIGH | `BROWSER_EXTENSION_ENABLED=true` path unchanged |
| Native host registration skipped accidentally | LOW | MEDIUM | Build flag defaults to false; explicit opt-in |
| Security regression | LOW | HIGH | Browser-enforced origin validation independent of agent |
| Agent cannot track websites at all | LOW | MEDIUM | `BrowserActivityMonitor` provides fallback |

### Risk of Keeping Extension ID Mandatory

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Agent cannot build without Extension ID | HIGH | HIGH | This is the current problem |
| Blocks product delivery | HIGH | HIGH | Extension not in current release scope |
| Developer frustration | HIGH | MEDIUM | Developers must obtain unused credentials |
| Confusion about feature requirements | MEDIUM | MEDIUM | Documentation already says extension is optional |

---

## 15. Final Recommendation

### Verdict: OPTION C

> **Browser Extension functionality is incomplete/optional and the Extension ID should NOT be mandatory for the current release.**

### Rationale

1. **Product requirement verified**: The current OmniSight release explicitly does NOT include the browser extension as a required component.

2. **Code evidence**: The `BrowserActivityMonitor` provides website domain tracking without any browser involvement. The extension is documented as "best-effort" and "partial."

3. **Build impact**: The mandatory Extension ID blocks agent builds for organizations that don't use the extension feature.

4. **Security**: The existing security model (browser-enforced origin validation, token auth, loopback-only) works correctly when the feature is disabled.

5. **No regression**: Making the Extension ID optional does not change behavior for users who enable the feature — it only removes the requirement for users who don't.

### Action Items (Implementation, Not Done in This Audit)

1. **Desktop Agent (`omnisight-agent`)**: Add a `BROWSER_EXTENSION_ENABLED` build-time flag (default false). When false, `install-native-host.mjs` skips native host registration and does not require Extension ID.

2. **Agent Runtime**: When `BROWSER_EXTENSION_ENABLED=false`, the website bridge does not start. `BrowserActivityMonitor` continues to provide best-effort domain tracking.

3. **Server**: No changes needed — `website_native_tracking` already serves as the runtime toggle (org-scoped, default false).

4. **Build Pipeline**: `build-prod.mjs` should conditionally include/exclude the native host based on the flag.

5. **Documentation**: Update `DESKTOP-AGENT.md` and `INSTALLATION.md` to reflect that the extension is optional and the Extension ID is only required when `BROWSER_EXTENSION_ENABLED=true`.

---

*Report generated: 2026-08-27*
*Mode: READ-ONLY AUDIT — no files modified*
*Audited: omnisight-web (admin panel + server), browser-extension/, referenced desktop-agent components*
