/**
 * Test-only shim: neutralize the `server-only` marker package.
 *
 * The real `server-only` package (as installed by `npm ci`/`bun install` in
 * CI) throws on import when loaded outside a React Server Components
 * bundler context. Next.js handles it at build time, but the API-integration
 * tests execute route/job modules directly under `tsx --test`, so the marker
 * must be replaced with a no-op before any application module is imported.
 *
 * Usage: `import '../helpers/mock-server-only.cjs';` as the FIRST import of
 * any test that dynamically imports `src/**` modules inside `before()`.
 *
 * This pre-seeds Node's require cache at the resolved path of
 * `server-only/index.js`, so every subsequent `import 'server-only'` (ESM or
 * CJS interop) receives an empty module without executing the throwing
 * implementation. Next.js builds are unaffected — this file is never
 * imported outside of tests/.
 */
const Module = require('node:module');

const serverOnlyPath = Module.createRequire(__filename).resolve('server-only');

require.cache[serverOnlyPath] = {
  id: serverOnlyPath,
  filename: serverOnlyPath,
  loaded: true,
  exports: {},
};
