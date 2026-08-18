// OmniSight — canonical brand constants (single source of truth for the admin app).
// The product was previously branded as WorkLensAI; technical identifiers from
// that era (cookie names, storage keys, process names) are intentionally
// preserved for backward compatibility — see REBRAND-AUDIT.md.

export const BRAND = {
  /** Current product name. */
  name: 'OmniSight',
  /** Legacy product name (historical/migration reference only). */
  previousName: 'WorkLensAI',
  /** Product tagline. */
  tagline: 'REMOTE INSIGHTS',
  /** Desktop agent product identity. */
  agentName: 'OmniSight Agent',
  /** SEO/metadata description (semantics preserved from the pre-rebrand copy). */
  description: 'Monitor, analyze, and optimize your workforce productivity with AI-driven insights.',
} as const;

export type Brand = typeof BRAND;