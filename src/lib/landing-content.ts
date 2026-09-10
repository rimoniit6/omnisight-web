/**
 * Landing page content document — Super Admin-managed copy overrides.
 *
 * The public landing page ships with built-in default copy (kept in the
 * section components). The stored document only contains overrides: when a
 * field is absent the section renders its default. This keeps a saved "reset"
 * trivial (store {}), avoids version skew, and keeps the public page fully
 * functional with zero database rows.
 *
 * Shape is a flat set of string fields grouped by landing section. Shared by:
 *   - the API route (validation / persistence)
 *   - the Control Center editor (src/components/super-admin/sa-landing-page.tsx)
 *   - the public landing sections (read overrides via useLandingContent)
 */

export interface LandingBlockFields {
  eyebrow?: string;
  title?: string;
  subtitle?: string;
}

export interface LandingContentDoc {
  hero?: {
    eyebrow?: string;
    /** One entry per displayed line. */
    title?: string[];
    subtitle?: string;
    primaryCta?: string;
    secondaryCta?: string;
  };
  overview?: LandingBlockFields;
  live?: LandingBlockFields;
  features?: LandingBlockFields;
  screenshot?: LandingBlockFields;
  ai?: LandingBlockFields;
  architecture?: LandingBlockFields;
  security?: LandingBlockFields;
  deployment?: LandingBlockFields;
  pricing?: LandingBlockFields;
  final?: {
    eyebrow?: string;
    title?: string;
    subtitle?: string;
    primaryCta?: string;
    secondaryCta?: string;
  };
  footer?: {
    tagline?: string;
    copyright?: string;
  };
}

/** Sections rendered through the shared SectionHeading (title/subtitle/eyebrow). */
export const LANDING_BLOCK_SECTIONS = [
  'overview',
  'live',
  'features',
  'screenshot',
  'ai',
  'architecture',
  'security',
  'deployment',
  'pricing',
] as const;

export type LandingBlockKey = (typeof LANDING_BLOCK_SECTIONS)[number];

/** Top-level keys accepted in the document. */
export const LANDING_TOP_KEYS = [
  'hero',
  ...LANDING_BLOCK_SECTIONS,
  'final',
  'footer',
] as const;

// ─── Validation (server + editor share it) ─────────────────────────────────
const LIMITS = {
  short: 120, // CTA labels, eyebrows
  line: 240, // hero lines / footer tagline / copyright
  long: 600, // titles / subtitles
  lines: 6,
  total: 60_000, // serialized document cap
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cleanStr(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Sanitize + normalize an untrusted document into a valid LandingContentDoc.
 * Unknown keys / non-string values are dropped; lengths are capped.
 */
export function sanitizeLandingDoc(input: unknown): { ok: true; value: LandingContentDoc } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (!isPlainObject(input)) return { ok: false, error: 'Content must be a JSON object' };

  const out: LandingContentDoc = {};
  for (const key of LANDING_TOP_KEYS) {
    const raw = input[key];
    if (raw === undefined || raw === null) continue;
    if (!isPlainObject(raw)) return { ok: false, error: `Section "${key}" must be an object` };

    if (key === 'hero' || key === 'final') {
      const block: Record<string, unknown> = {};
      const eyebrow = cleanStr(raw.eyebrow, LIMITS.short);
      const subtitle = cleanStr(raw.subtitle, LIMITS.long);
      const primaryCta = cleanStr(raw.primaryCta, LIMITS.short);
      const secondaryCta = cleanStr(raw.secondaryCta, LIMITS.short);
      if (key === 'hero') {
        // Hero heading is a line array (one entry per displayed line). Accept a
        // string too (newline-separated) for convenience.
        const rawTitle = raw.title;
        let titleArr: string[] | undefined;
        if (typeof rawTitle === 'string') {
          titleArr = rawTitle.split('\n').map((l) => l.trim()).filter(Boolean);
        } else if (Array.isArray(rawTitle)) {
          titleArr = rawTitle.map((l) => (typeof l === 'string' ? l.trim() : '')).filter(Boolean);
        }
        if (titleArr && titleArr.length > 0) {
          block.title = titleArr.slice(0, LIMITS.lines).map((l) => (l.length > LIMITS.line ? l.slice(0, LIMITS.line) : l));
        }
      } else {
        const title = cleanStr(raw.title, LIMITS.long);
        if (title) block.title = title;
      }
      if (eyebrow) block.eyebrow = eyebrow;
      if (subtitle) block.subtitle = subtitle;
      if (primaryCta) block.primaryCta = primaryCta;
      if (secondaryCta) block.secondaryCta = secondaryCta;
      if (Object.keys(block).length > 0) {
        if (key === 'hero') out.hero = block as LandingContentDoc['hero'];
        else out.final = block as LandingContentDoc['final'];
      }
      continue;
    }

    if (key === 'footer') {
      const block: Record<string, unknown> = {};
      const tagline = cleanStr(raw.tagline, LIMITS.line);
      const copyright = cleanStr(raw.copyright, LIMITS.line);
      if (tagline) block.tagline = tagline;
      if (copyright) block.copyright = copyright;
      if (Object.keys(block).length > 0) out.footer = block as LandingContentDoc['footer'];
      continue;
    }

    // Standard section blocks (overview/live/features/.../pricing)
    const block: Record<string, unknown> = {};
    const eyebrow = cleanStr(raw.eyebrow, LIMITS.short);
    const title = cleanStr(raw.title, LIMITS.long);
    const subtitle = cleanStr(raw.subtitle, LIMITS.long);
    if (eyebrow) block.eyebrow = eyebrow;
    if (title) block.title = title;
    if (subtitle) block.subtitle = subtitle;
    if (Object.keys(block).length > 0) out[key as LandingBlockKey] = block as LandingBlockFields;
  }

  const json = JSON.stringify(out);
  if (json.length > LIMITS.total) {
    return { ok: false, error: `Content exceeds the ${LIMITS.total}-character limit` };
  }
  return { ok: true, value: out };
}

export function emptyLandingDoc(): LandingContentDoc {
  return {};
}

/** Serialized size guard used by the editor UI. */
export const LANDING_TOTAL_LIMIT = LIMITS.total;

/** Field labels used by the editor form. */
export const LANDING_FIELD_LABELS: Record<string, string> = {
  eyebrow: 'Eyebrow',
  title: 'Title',
  subtitle: 'Subtitle / description',
  primaryCta: 'Primary button',
  secondaryCta: 'Secondary button',
  tagline: 'Tagline',
  copyright: 'Copyright',
};
