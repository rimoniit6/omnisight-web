# OMNISIGHT — BROWSER EXTENSION CURRENT-RELEASE AUDIT

**Date:** 2026-08-27
**Status:** ✅ COMPLETE — All acceptance criteria met

---

## 1. Objective

Make the Chrome/Edge Browser Extension a non-user-facing, non-required feature for the current OmniSight production release. The extension implementation is preserved for future use but not exposed or required in the current release.

---

## 2. Repositories Audited

| Repository | Path | Status |
|---|---|---|
| Desktop Agent | `E:\Live project\omnisight\omnisight-agent` | Modified |
| Admin Panel | `E:\Live project\omnisight\omnisight-web` | Modified |

---

## 3. Files Changed

### Desktop Agent (`omnisight-agent`)

| File | Change |
|---|---|
| `builder/ui/index.html` | Removed Browser Extension toggle, Extension ID input, and related JavaScript from user-facing UI |
| `scripts/build-prod.mjs` | `BROWSER_EXTENSION_ENABLED` defaults to `false`; conditionally skips native host build |
| `scripts/electron-builder-before-pack.mjs` | Extension ID validation conditional on `BROWSER_EXTENSION_ENABLED` |
| `scripts/electron-builder-after-pack.mjs` | Native host verification conditional on `BROWSER_EXTENSION_ENABLED` |
| `installer/nsis-hooks.nsh` | Registry registration conditional on extension ID being present |
| `builder/lib/pipeline.mjs` | `build-native-host` stage conditional on `browserExtensionEnabled` |
| `builder/lib/config.mjs` | Passes `BROWSER_EXTENSION_ENABLED` through build env |
| `builder/server.mjs` | Handles `browserExtensionEnabled` from build request |
| `tests/builder-config.test.ts` | Updated for new env key + conditional behavior |
| `tests/builder-pipeline.test.ts` | Updated + added `BP-8b` test for skipped stage |

### Admin Panel (`omnisight-web`)

| File | Change |
|---|---|
| `src/components/settings/settings-page.tsx` | Updated website tracking helper text to remove browser extension reference |

---

## 4. UI Removed/Hidden

### Builder UI (Agent Builder)

**Removed from current release:**
- ❌ Browser Extension Integration toggle (Disabled/Enabled selector)
- ❌ Chrome/Edge Extension ID input field
- ❌ Extension-related validation messages
- ❌ Extension ID required-field error messages

**Current Builder UX:**
1. Enter Agent Server URL
2. Select Build Type (Development/Production)
3. Validate Server
4. Enter optional Version and Enrollment Code
5. Click Build
6. No Extension ID question — build succeeds

### Admin Panel

**Removed from current release:**
- ❌ Browser extension reference in website tracking helper text
- ❌ "Chrome/Edge browser extension" mention in settings UI

**Preserved (internal, not user-facing):**
- ✅ `website_native_tracking` setting (org-scoped, default false)
- ✅ `websiteNativeTracking` in agent config response
- ✅ All internal documentation referencing the extension

---

## 5. Build Requirement Removed

| Requirement | Before | After |
|---|---|---|
| `OMNISIGHT_EXTENSION_ID` | **Required** — build failed without it | **Optional** — only required when `BROWSER_EXTENSION_ENABLED=true` |
| `BROWSER_EXTENSION_ENABLED` | N/A (did not exist) | Defaults to `false` — no extension ID required |
| Native host build | Always ran | Skipped when `BROWSER_EXTENSION_ENABLED=false` |
| Native host registration | Always performed | Skipped when extension is disabled |

---

## 6. Runtime Behavior

When `BROWSER_EXTENSION_ENABLED=false` (current default):

| Component | Status |
|---|---|
| Agent startup | ✅ Works normally |
| Authentication | ✅ Works normally |
| BrowserActivityMonitor | ✅ Active — extension-free website tracking |
| WebsiteCollector | ✅ Active — receives events from BrowserActivityMonitor |
| All other collectors | ✅ Active — no change |
| Website bridge | ✅ Starts but accepts no connections (idle) |
| Native messaging host | ❌ Not built/registered |
| Extension ID | ❌ Not required |
| Chrome/Edge | ❌ Not required |

---

## 7. BrowserActivityMonitor Verification

The `BrowserActivityMonitor` continues to provide extension-free website tracking:

```
BrowserActivityMonitor (agent-native)
  → reads foreground window title
  → extracts bare domain (BEST_EFFORT)
  → feeds events to WebsiteCollector
  → WebsiteCollector aggregates visits
  → uploads to server as type='website'
```

**No change** to the existing website tracking pipeline.

---

## 8. Native Host Behavior

| Mode | Native Host | Registration | Manifest |
|---|---|---|---|
| `BROWSER_EXTENSION_ENABLED=false` (default) | Stub file (not real launcher) | Not registered | Not generated |
| `BROWSER_EXTENSION_ENABLED=true` | Real compiled launcher | Registered in Chrome/Edge/Firefox | Generated with real extension ID |

---

## 9. Extension Code Preserved

The following code is preserved intact for future use:

| Component | Location | Status |
|---|---|---|
| Browser extension source | `browser-extension/` | ✅ Intact |
| Native messaging host | `native-host/`, `native-host-bin/` | ✅ Intact |
| Native host manifests | `browser-extension/native-messaging/` | ✅ Intact |
| Website bridge | `src/services/website-bridge.ts` | ✅ Intact |
| Extension tests | `browser-extension/tests/` | ✅ Intact |
| Extension-related tests | `tests/` | ✅ Intact |
| Feature-gating architecture | `BROWSER_EXTENSION_ENABLED` flag | ✅ Intact |

**Future reactivation path:**
```bash
BROWSER_EXTENSION_ENABLED=true \
OMNISIGHT_EXTENSION_ID=<32-char-id> \
AGENT_SERVER_URL=<url> \
node scripts/build-prod.mjs
```

---

## 10. Tests Executed

```
ℹ tests 624
ℹ pass 624
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 24328.1781
```

**All 624 tests pass.** Key test categories:

| Category | Tests | Status |
|---|---|---|
| Agent orchestrator | 40+ | ✅ All pass |
| Authentication | 30+ | ✅ All pass |
| Collectors (website, screenshot, etc.) | 50+ | ✅ All pass |
| Builder pipeline | 30+ | ✅ All pass |
| Builder config | 20+ | ✅ All pass |
| Website bridge | 5 | ✅ All pass |
| BrowserActivityMonitor | 8 | ✅ All pass |
| Security/RBAC | 60+ | ✅ All pass |
| Multi-org isolation | 10+ | ✅ All pass |

---

## 11. Production Build Result

```
[build-prod] browser extension integration: DISABLED (no extension ID required)
[build-prod]   website tracking will use BrowserActivityMonitor (extension-free)
[pack-gate] browser extension integration: DISABLED — skipping extension ID and native host validation
[pack-gate] native addon OK: worklens_capture.node (238080 bytes, 17/17 exports verified)
[pack-verify] native messaging host present but not required (browser extension disabled)
[pack-verify] native addon packaged (238080B, matches source)
[pack-verify] app.asar arrangement OK (379 entries, native components outside asar)
[build-prod] packaged native addon OK (238080B, matches source).
```

**Build exit code: 0** — Success without Extension ID.

---

## 12. Security Verification

| Aspect | Status |
|---|---|
| Native messaging security | ✅ Not weakened — when disabled, no host is exposed |
| Extension ID validation | ✅ Preserved — when enabled, fail-closed validation enforced |
| Bridge authentication | ✅ Unchanged — 32-byte token + loopback-only |
| Loopback restrictions | ✅ Unchanged — bridge binds to 127.0.0.1 only |
| No wildcard origins | ✅ No `*` or `chrome-extension://*/` introduced |
| Admin Panel settings | ✅ `website_native_tracking` defaults to false |

---

## 13. Regression Verification

| Area | Status |
|---|---|
| RBAC | ✅ No regressions |
| Authentication | ✅ No regressions |
| Multi-org isolation | ✅ No regressions |
| Agent collectors | ✅ No regressions |
| Website tracking | ✅ No regressions |
| Builder functionality | ✅ No regressions |
| Existing extension tests | ✅ All preserved and passing |

---

## 14. Future Reactivation Path

When browser extension support is needed in a future release:

1. **Builder UI:** Re-enable the Browser Extension toggle and Extension ID input in `builder/ui/index.html`
2. **Build command:**
   ```bash
   BROWSER_EXTENSION_ENABLED=true \
   OMNISIGHT_EXTENSION_ID=<32-char-id> \
   AGENT_SERVER_URL=<url> \
   node scripts/build-prod.mjs
   ```
3. **Runtime:** Set `website_native_tracking=true` in Admin Panel → Settings → Monitoring
4. **Installation:** Install the browser extension and native messaging host

The complete extension implementation is preserved and functional — it just needs to be re-exposed in the UI.

---

## Final Status

```
CURRENT RELEASE
================
Browser Extension:    NOT INCLUDED (hidden from UI)
Extension ID:         NOT REQUIRED (build succeeds without it)
Native Messaging:     NOT INCLUDED (not built/registered)
Native Host:          NOT REGISTERED (not in installer)
BrowserActivityMonitor: ENABLED (extension-free website tracking)
Website Tracking:     ENABLED (via BrowserActivityMonitor)
Core Agent:           FULLY FUNCTIONAL

FUTURE RELEASE
================
Browser Extension:    ENABLED (re-expose in Builder UI)
Extension ID:         REQUIRED (build validates it)
Native Messaging:     ENABLED (built and registered)
Native Host:          REGISTERED (in installer + Windows registry)
High-accuracy domain tracking: ENABLED (via extension)
```

---

**Chrome/Edge Browser Extension is NOT required for the current OmniSight production release.**

**Extension ID is NOT required to build or run the current production Agent.**

---

*Generated: 2026-08-27*
*Build verified: `BROWSER_EXTENSION_ENABLED=false` production build (exit 0)*
*Tests verified: 624/624 pass*
