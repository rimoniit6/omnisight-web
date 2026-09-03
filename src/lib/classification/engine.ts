// OmniSight — Server-authoritative activity classification engine (Phase 3).
//
// Today `Activity.category` is whatever the agent's LOCAL heuristic produced
// (allowlisted server-side). Phase 3 makes the server authoritative WHEN the
// org opts in (`server_classification` monitoring flag):
//
//   1. Org CategoryRules are evaluated in ordered precedence (lower priority
//      number wins first; ties break by createdAt/id). The first rule whose
//      pattern matches the row decides the category.
//   2. Rows that match NO rule fall back to the DEFAULT HEURISTIC — a server
//      mirror of the agent's local categorize()/categorizeDomain() (kept in
//      sync with omnisight-agent/src/collectors/*). Because the fallback
//      reproduces exactly what the agent would have sent, enabling rules
//      never changes behavior for unmatched rows (no sudden dashboard
//      changes), and agents without rules keep today's categories verbatim.
//
// Purely functional: no DB access, no logging. Deterministic for a given row
// + rule set, so ingestion, dry-run evaluation and tests share one code path.
//
// Match semantics (three distinct targets over the stored row fields):
//   - executable: case-insensitive substring of `applicationName` (the
//     process/exe name, e.g. "chrome.exe").
//   - application: case-insensitive substring of `title` (the window title,
//     e.g. "GitHub - Google Chrome") — the friendly application identity.
//   - domain:     case-insensitive substring of `url` (website rows only).
// Patterns are PLAIN substrings — deliberately not regex (predictable,
// ReDoS-safe), matching the documented contract of the CategoryRule model.

import { defaultApplicationCategory, defaultDomainCategory } from './defaults';

export const CATEGORY_RULE_MATCH_TYPES = ['application', 'executable', 'domain'] as const;
export type CategoryRuleMatchType = (typeof CATEGORY_RULE_MATCH_TYPES)[number];

/** Target categories a rule may assign. `idle` is never assignable by rule. */
export const CATEGORY_RULE_TARGETS = ['productive', 'neutral', 'unproductive'] as const;
export type CategoryRuleTarget = (typeof CATEGORY_RULE_TARGETS)[number];

export const MAX_RULE_PATTERN_LENGTH = 128;
export const MAX_RULE_NAME_LENGTH = 64;
export const MIN_RULE_PRIORITY = -1000;
export const MAX_RULE_PRIORITY = 1000;
/** Hard cap on enabled rules considered per request — bounded, documented. */
export const MAX_RULES_PER_ORG = 200;

export interface CategoryRuleLike {
  id?: string;
  // Deliberately `string` (not the narrowed union): rows come from the DB
  // where the column is free text. Unknown/corrupt match types simply never
  // match (fail-safe) instead of throwing at ingestion time.
  matchType: string;
  pattern: string;
  category: string;
  priority: number;
  enabled?: boolean;
  createdAt?: Date | string;
}

/** A row awaiting classification (the fields the engine may match on). */
export interface ClassifiableRow {
  type: string;
  title?: string | null;
  applicationName?: string | null;
  url?: string | null;
}

export interface ClassificationResult {
  /** Decided category. */
  category: string;
  /** True when a CategoryRule matched; false = default heuristic fallback. */
  ruleMatched: boolean;
  /** The rule (or rule id) that matched, when ruleMatched. */
  matchedRuleId?: string;
  matchedPattern?: string;
}

/** Case-insensitive plain-substring containment (never regex). */
function contains(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Deterministic precedence ordering: enabled first, then priority ascending
 * (lower number = higher precedence), then createdAt ascending, then id.
 */
export function orderRules(rules: CategoryRuleLike[]): CategoryRuleLike[] {
  return [...rules]
    .filter((r) => r.enabled !== false)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      const at = a.createdAt instanceof Date ? a.createdAt.getTime() : new Date(String(a.createdAt)).getTime() || 0;
      const bt = b.createdAt instanceof Date ? b.createdAt.getTime() : new Date(String(b.createdAt)).getTime() || 0;
      if (at !== bt) return at - bt;
      return (a.id ?? '').localeCompare(b.id ?? '');
    });
}

/**
 * Evaluate a row against ordered rules; returns the FIRST match or null.
 * Only the rule type applicable to the row is considered:
 *   - application rows: executable (applicationName) + application (title)
 *   - website rows:     domain (url)
 * Other types (idle, screenshot, work_session) are never rule-classified.
 */
export function matchRule(
  row: ClassifiableRow,
  rules: CategoryRuleLike[]
): ClassificationResult | null {
  if (row.type !== 'application' && row.type !== 'website') return null;
  for (const rule of orderRules(rules)) {
    // Only well-formed enabled rules with a known target category match; a
    // corrupt stored row (bad matchType/category) never matches and never
    // throws — classification degrades to the default heuristic.
    if (!CATEGORY_RULE_TARGETS.includes(rule.category as CategoryRuleTarget)) continue;
    let hit = false;
    if (row.type === 'application') {
      if (rule.matchType === 'executable') hit = contains(row.applicationName, rule.pattern);
      else if (rule.matchType === 'application') hit = contains(row.title, rule.pattern);
    } else if (row.type === 'website' && rule.matchType === 'domain') {
      hit = contains(row.url, rule.pattern);
    }
    if (hit) {
      return {
        category: rule.category,
        ruleMatched: true,
        matchedRuleId: rule.id,
        matchedPattern: rule.pattern,
      };
    }
  }
  return null;
}

/**
 * Full server-authoritative classification for an ingested row:
 * rules first (ordered precedence), default heuristic as the no-rule
 * fallback so unmatched rows keep today's agent-equivalent categories.
 *
 * `idle` rows and any row type outside application/website keep their
 * existing category untouched (null → caller keeps the agent value).
 */
export function classifyRow(
  row: ClassifiableRow,
  rules: CategoryRuleLike[]
): ClassificationResult | null {
  if (row.type !== 'application' && row.type !== 'website') return null;
  const matched = matchRule(row, rules);
  if (matched) return matched;
  // Default heuristic fallback — mirrors the agent's local categorizers so
  // behavior for unmatched rows is unchanged (see module comment).
  if (row.type === 'application') {
    return { category: defaultApplicationCategory(row.applicationName), ruleMatched: false };
  }
  return { category: defaultDomainCategory(row.url), ruleMatched: false };
}
