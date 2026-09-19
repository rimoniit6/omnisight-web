// OmniSight — Type-safe environment variable validation
//
// Thin backward-compatibility re-export. The canonical, comprehensive
// validator lives in `src/lib/env-validator.ts` — always import from there
// for new code. Existing `@/lib/env` imports keep working unchanged.

export * from './env-validator';