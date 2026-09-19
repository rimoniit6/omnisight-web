// OmniSight — shared NON-SECRET demo fixtures for the verify/docs toolchain.
//
// Used by the demo agent-join verification scripts (verify-e*.mjs,
// verify-m009-*.mjs, verify-ocr.mjs). These values are deliberately NOT
// secrets:
//   • DEMO_JOIN_KEY is the demo install join key backfilled during demo setup
//     (M003). Production organizations join with their own per-org join key.
//   • Production application code (src/) never references this module — it is
//     consumed only by offline scripts that exercise the demo workflow.
//
// If a literal ever looks like a real credential, it does not belong here.

export const DEMO_JOIN_KEY = 'WL-DEMO-JOINKEY-2026';