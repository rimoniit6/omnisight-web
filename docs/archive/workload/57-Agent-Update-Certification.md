# Agent Update Certification

Date: 2026-08-10 · Phase G

## Verdict

| Item | Status |
|---|---|
| v1.0.0 build artifact (baseline) | ✅ PASS — `WorkLensAI Agent Setup 1.0.0.exe` (SHA-256 `957ede07…`) |
| v1.1.0 build artifact produced | ✅ PASS — `WorkLensAI Agent Setup 1.1.0.exe` (SHA-256 `d57575c4…`) |
| Identity preservation config | ✅ PASS — `deleteAppDataOnUninstall: false`; identity/credentials stored in `%APPDATA%\worklensai-agent\state` |
| No duplicate-device design | ✅ PASS — stable `device-identity.json` + `agentKey` unique + idempotent discover |
| Update feed safety (HTTPS-gated, no silent unsigned updates) | ✅ PASS — `UpdateService` no-op without `WL_UPDATE_URL`; `autoDownload=false` |
| **Live v1.0.0 → v1.1.0 in-place upgrade executed** | 🔒 **NOT VERIFIED — requires a Windows machine (B-02/B-07)** |
| Rollback test | 🔒 **NOT VERIFIED** |

---

## 1. Artifacts

| Version | Installer | SHA-256 | Size |
|---|---|---|---|
| 1.0.0 | `out/WorkLensAI Agent Setup 1.0.0.exe` | `957ede0781b2cc6d5e57a428c083b3b68471c67312f47ec5b53fc3ea3461b878` | 82,102,076 |
| 1.1.0 | `out/WorkLensAI Agent Setup 1.1.0.exe` | `d57575c4de6cc42b6a2df6b977893c981c72dde8d5b5cc9232fe2501334341f2` | 82,102,182 |

Both built from the same source with the version bumped in `desktop-agent/package.json` — proving
the release pipeline can produce sequential versions. (`electron-builder.yml` `deleteAppDataOnUninstall: false` verified inside the packaged ASAR.)

## 2. Identity/credential preservation design (verified in packaged ASAR)

- **Device identity:** `device-identity.json` in `%APPDATA%\worklensai-agent\state` — stable machine key reused across restarts/upgrades. `Device.agentKey @unique` server-side + idempotent `discover` (existing device reused, never duplicated).
- **Secure credentials:** token/claim/password stored encrypted via Electron `safeStorage` (DPAPI) in the same userData dir — preserved across upgrades because the installer does **not** delete app data.
- **Server-side state:** device assignment/consent live in the DB keyed by `agentKey`/device — unaffected by client reinstall.
- **No duplicate:** single-instance lock + idempotent discover + `@@unique` on claim.deviceId.

## 3. Update mechanism

- `UpdateService` (`desktop-agent/src/services/update-service.ts`): only active when `WL_UPDATE_URL` (HTTPS) is configured; `autoDownload=false`/`autoInstallOnAppQuit=false` → **no silent unsigned updates** (documented release blocker if auto-update is required).
- Upgrade path today: NSIS installer installs over the existing install; identity/credentials survive by design.

## 4. Live upgrade checklist (to run on a Windows test machine)

1. Install v1.0.0, enroll a device (or discover + admin approve)
2. Note `agentKey` (DB) + device id
3. Install v1.1.0 over the existing install
4. Verify: install succeeds; old process terminates; new process starts
5. Verify device identity preserved (same agentKey, no new Device row, no new claim)
6. Verify employee/department/projects assignment still server-derived and correct
7. Verify consent state intact; collectors obey it
8. Verify secure-store credentials intact (auto-reauth without prompt)
9. Verify heartbeat/config/consent sync resume automatically
10. Optionally verify rollback by installing v1.0.0 again (same preservation rules)

## 5. Conclusion

The **update pipeline is ready** (sequential artifacts build cleanly; identity preservation is
config-guaranteed and statically verified). The **live upgrade execution** is P2 blocker B-07
and remains NOT VERIFIED pending a Windows machine.
