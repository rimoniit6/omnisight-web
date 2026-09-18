// Mock for `server-only` package in test environments
// In Next.js Server Components, `server-only` throws if imported in Client Components.
// In test runners (tsx, Node.js test), there's no Next.js runtime, so we provide a no-op mock.

module.exports = {};
export default {};