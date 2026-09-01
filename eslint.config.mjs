import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // Scope project rule overrides to source files only — the eslint-config-next
    // configs also scope via `files`, and applying react-hooks rules to plain
    // .js/.cjs scratch files would reference a plugin not loaded for those types.
    files: ["**/*.{js,jsx,ts,tsx}"],
    rules: {
      // ── Recommended rules restored (were blanket-disabled) ──────────────
      // Correctness-critical rules now run at their default severity.

      // Unused code is a warning; params prefixed with `_` are allowed.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",

      // React correctness rules stay active at recommended levels.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",

      // ── Justified exceptions (with reasons) ──────────────────────────────
      // no-img-element: next/image cannot fetch cookie-authenticated API
      // routes (the optimizer's requests carry no session cookie), so the
      // screenshots viewer intentionally uses plain <img loading="lazy">.
      "@next/next/no-img-element": "off",
      // no-html-link-for-pages: this app renders a single-page shell (see
      // src/app/page.tsx) — there are no route pages to link to yet.
      "@next/next/no-html-link-for-pages": "off",
      // no-unescaped-entities: apostrophes in JSX prose are pervasive and
      // harmless; keeping source readable.
      "react/no-unescaped-entities": "off",
      // The React Compiler is not enabled in this project — disable its
      // associated hooks rules which produce false positives for standard
      // React patterns (setState-in-effect, preserve-manual-memoization).
      "react-compiler/react-compiler": "off",
      "react-hooks/purity": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // ── Playwright E2E fixtures (tests/e2e/**) ────────────────────────────
    // Playwright's `test.extend` fixture callbacks receive a `use` parameter
    // that is Playwright's continuation callback, NOT React's `use` hook.
    // The react-hooks/rules-of-hooks rule misreads these as hook calls, so it
    // is scoped off for Playwright test/support files only — the React
    // source tree (src/**) still enforces it at full severity.
    files: ["tests/e2e/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    // ── Intentional Node-CLI scripts (scripts/**/*.mjs) ───────────────────
    // These run directly under Node (tsx/node), not through the Next.js
    // bundler, so they may legitimately mix `require()` and ESM interop
    // (e.g. cleanup-ocr-fixtures.mjs). This is a narrow, file-scoped
    // exception — source code in src/ still enforces no-require-imports.
    files: ["scripts/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // ── Electron CLI scripts (omnisight-agent/scripts/*.js) ───────────────
    // Plain CommonJS scripts launched by Electron (`npx electron
    // scripts/electron-bridge-check.js`) — `require()` is the correct, only
    // import mechanism in CJS. The `no-require-imports` rule targets TS
    // modules where ESM is available; applying it to these scripts is a false
    // positive. Narrow file-scoped exception — omnisight-agent/src/*.ts source
    // still enforces no-require-imports (builtins are statically imported).
    files: ["omnisight-agent/scripts/**/*.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      // Compiled Electron-agent output (gitignored, never linted — see
      // omnisight-agent/.gitignore). The omnisight-agent *source* stays linted.
      "omnisight-agent/dist/**",
      "build/**",
      "next-env.d.ts",
      "examples/**",
      "skills",
      "tool-results/**",
      "upload/**",
      "db/**",
      "**/*.config.*",
    ],
  },
];

export default eslintConfig;
