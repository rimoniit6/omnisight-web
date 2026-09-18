// Test-only mock for `server-only` package
// In non-Next.js contexts (test runners), `server-only` throws an error.
// This mock provides a no-op implementation that allows tests to import
// server-only modules without failing.

const originalResolve = module.exports?.resolve || Module._resolveFilename;

Module._resolveFilename = function(request, parent, isMain, options) {
  if (request === 'server-only') {
    // Return a mock module path that does nothing
    return require.resolve('./mocks/server-only.mock.js');
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

// Also handle ESM imports
const originalImport = globalThis.importModule;
if (originalImport) {
  globalThis.importModule = async function(specifier, context, defaultResolve) {
    if (specifier === 'server-only') {
      return { default: {} };
    }
    return defaultResolve(specifier, context, defaultResolve);
  };
}