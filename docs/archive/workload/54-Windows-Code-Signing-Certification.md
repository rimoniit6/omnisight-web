# Windows Code Signing Certification

Date: 2026-08-10 · Phase G

## Verdict

| Item | Status |
|---|---|
| Signing scaffold in build config (env-driven) | ✅ PASS — `desktop-agent/electron-builder.yml` now has a `win.sign` + CSC env block |
| Real production certificate provisioned | ❌ **NO** |
| Signed installer produced | ❌ **NO** |
| `signtool verify` executed | ❌ **NO** (no signtool in this environment) |
| Windows file properties → Digital Signatures | ❌ **NO** |

**Status: 🔒 BLOCKED — CERTIFICATE PROVISIONING REQUIRED**

---

## 1. Current state

Every build logs: `no signing info identified, signing is skipped`. The latest installer
(`out/WorkLensAI Agent Setup 1.0.0.exe`, SHA-256 `957ede07…`) is **unsigned**.

## 2. What was prepared

`desktop-agent/electron-builder.yml` `win:` section now documents and activates signing when
the standard electron-builder environment variables are present at build time:

```
CSC_LINK / CSC_KEY_PASSWORD
WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD   (Windows-specific alternative)
```

No certificate is committed to the repository; signing is a build-environment concern.

## 3. Required provisioning steps (documented, not executed)

1. Purchase an **OV or EV Authenticode code-signing certificate** (EV recommended for
   SmartScreen reputation) from a commercial CA (DigiCert, Sectigo, GlobalSign, etc.).
2. Export the certificate + private key as a `.pfx` (or use an HSM/CI signing service —
   Azure Trusted Signing, SignPath, etc.).
3. Configure the signing env vars in the release pipeline (never in the repo).
4. Rebuild: `npm run build && npx electron-builder --win nsis`.
5. Verify:
   - `signtool verify /pa "out/WorkLensAI Agent Setup <version>.exe"`
   - `signtool verify /pa "out/win-unpacked/WorkLensAIAgent.exe"`
   - Windows Explorer → Properties → Digital Signatures (valid chain, timestamp).
6. Add a timestamp server (`/tr http://timestamp.digicert.com /td sha256`) for long-term validity.

## 4. Production impact

An unsigned monitoring agent will trigger SmartScreen "Unknown publisher" on employee
machines and may be blocked by enterprise execution policies. This is a **P1 production
blocker** until a real certificate is provisioned. A self-signed/fake certificate is
explicitly NOT acceptable as the production solution.
