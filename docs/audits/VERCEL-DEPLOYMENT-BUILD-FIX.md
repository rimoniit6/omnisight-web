# Vercel Deployment Build Fix — Audit Report

**Date:** 2026-08-18  
**Verdict:** DEPLOYMENT_BUILD_FIXED ✅

---

## Root Cause

`tests/website-100.test.ts` line 188 contains a dynamic `import()` from a
sibling repository that does not exist in the Vercel build environment:

```ts
const { deriveExtensionIdFromKey, extensionIdFromManifest } = await import(
  '../omnisight-agent/scripts/install-native-host.mjs'
);
```

The Vercel deployment only clones the `omnisight-web` repository. The sibling
`omnisight-agent` directory does not exist on the Vercel filesystem.

## Exact Failing Import

```
tests/website-100.test.ts(188,5):
error TS2307: Cannot find module '../omnisight-agent/scripts/install-native-host.mjs'
or its corresponding type declarations.
```

The test also reads cross-repo files at runtime (lines 195–201):
```ts
readFileSync(path.join(root, 'omnisight-agent/native-host-manifests', file), 'utf8')
```

## Why It Worked Locally

Locally, both `omnisight-web` and `omnisight-agent` exist as sibling
directories. TypeScript resolves the dynamic import against the local
filesystem, so `tsc --noEmit` and `next build` both succeed.

## Why Vercel Failed

Vercel's build process clones only the `omnisight-web` repository. The
`tsconfig.json` had `"include": ["**/*.ts"]` which pulled all `.ts` files —
including `tests/website-100.test.ts` — into the production TypeScript
compilation. TypeScript attempted to resolve the cross-repo import and failed
because `../omnisight-agent/` does not exist.

## Files Changed

### `tsconfig.json`

Added `"tests"` to the `exclude` array:

```diff
  "exclude": [
    "node_modules",
    // mini-services are independent processes with their own package.json/
    // Prisma schema; they are built and run outside the Next.js toolchain.
    "mini-services",
    // omnisight-agent is an independent Electron/TypeScript project with its
    // own tsconfig, tests, and build; it is never part of the admin build.
-   "omnisight-agent"
+   "omnisight-agent",
+   // Test files are not part of the production build. They are run
+   // independently via `tsx --test` and must not introduce cross-repository
+   // dependencies (e.g. ../omnisight-agent/...) into the Vercel build.
+   "tests"
  ]
```

**One file changed. One line added.**

## Why the Fix Is Architecturally Correct

1. **Test files are not production code.** The `tests/` directory contains
   audit/regression test suites that are run independently via `tsx --test`.
   They are never part of the runtime application.

2. **Follows existing exclusion pattern.** The tsconfig already excludes
   `mini-services` and `omnisight-agent` — both are independent projects with
   their own toolchains. Tests are the same category: code that runs outside
   the Next.js build graph.

3. **No TypeScript weakening.** The `strict`, `noEmit`, and all compiler
   options remain unchanged. Only the compilation scope is narrowed to match
   the actual production code.

4. **Tests still run locally.** `tsx --test` executes test files independently
   of tsconfig's `include`/`exclude`. All test scripts in `package.json`
   (e.g., `test:consent`, `test:sentiment`, etc.) continue to work.

5. **No fragile cross-repo dependency.** The fix does not copy files between
   repos or create symlinks. The boundary between `omnisight-web` and
   `omnisight-agent` is preserved.

## Test Results

| Check | Result |
|-------|--------|
| `npm run build` | ✅ Exit code 0, compiled successfully |
| TypeScript (`tsc --noEmit`) | ✅ No errors |
| Production imports from `../omnisight-agent/` | ✅ Zero (only comments/string literals in `src/`) |
| `.next/types/` cross-repo references | ✅ None |

## Production Build Result

```
✓ Compiled successfully in 25.0s
  Running TypeScript ...
  Finished TypeScript in 33.7s ...
  Generating static pages using 7 workers (119/119) in 658ms
```

All 119 pages + API routes generated successfully. No TypeScript errors.

## `/api/agent/compat` Verification

✅ Route exists in the production build output: `├ ƒ /api/agent/compat`

The endpoint is a static fingerprint — no DB access, no auth, no
cross-repo filesystem dependencies. It returns:
```json
{
  "product": "omnisight",
  "service": "omnisight-web",
  "version": "0.2.1",
  "agentProtocol": 1
}
```

## Vercel-Specific Verification (Simulated)

The build was executed after `rm -rf .next` (clean `.next` directory).
The production build (`next build`) succeeded with zero TypeScript errors.
Since the `tests/` directory is now excluded from tsconfig, the cross-repo
import in `website-100.test.ts` is never resolved during the build.

A clean `omnisight-web`-only checkout (without `omnisight-agent/`) will
succeed because:
- TypeScript compilation excludes `tests/` → no resolution of cross-repo imports
- Runtime code in `src/` references `omnisight-agent` only in comments/strings
- The agent-software build endpoint gracefully handles missing agent directory

## Additional Notes

Other test files also reference `omnisight-agent` paths but only via
`readFileSync` (runtime file reads), not TypeScript `import()` statements.
These are now excluded from the production build graph by the same fix.
If they ever need to run on Vercel CI, they would need both repos checked
out — but that is an integration-test concern, not a production build concern.
