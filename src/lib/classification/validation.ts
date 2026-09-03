// OmniSight — CategoryRule admin input validation (Phase 3).
// Strict: malformed values are rejected (422 convention), never coerced.
// Rules are org-scoped from the verified session; `organizationId` is never
// accepted from the client. Patterns are plain case-insensitive substrings —
// NOT regex — so there is no ReDoS surface and semantics are predictable.

import {
  CATEGORY_RULE_MATCH_TYPES,
  CATEGORY_RULE_TARGETS,
  MAX_RULE_NAME_LENGTH,
  MAX_RULE_PATTERN_LENGTH,
  MAX_RULE_PRIORITY,
  MIN_RULE_PRIORITY,
  type CategoryRuleMatchType,
  type CategoryRuleTarget,
} from './engine';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export interface CategoryRuleInput {
  name: string;
  matchType: CategoryRuleMatchType;
  pattern: string;
  category: CategoryRuleTarget;
  priority: number;
  enabled?: boolean;
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[]): T | null {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** Validate a full rule payload (create + update share this). */
export function validateCategoryRuleInput(raw: unknown): ValidationResult<CategoryRuleInput> {
  if (typeof raw !== 'object' || raw === null) return fail('Rule payload must be an object');

  const nameRaw = (raw as Record<string, unknown>).name;
  if (typeof nameRaw !== 'string') return fail('name is required and must be a string');
  const name = nameRaw.trim();
  if (name.length === 0) return fail('name is required');
  if (name.length > MAX_RULE_NAME_LENGTH) {
    return fail(`name must be at most ${MAX_RULE_NAME_LENGTH} characters`);
  }

  const matchType = oneOf(
    (raw as Record<string, unknown>).matchType,
    CATEGORY_RULE_MATCH_TYPES
  );
  if (!matchType) {
    return fail(`matchType must be one of: ${CATEGORY_RULE_MATCH_TYPES.join(', ')}`);
  }

  const patternRaw = (raw as Record<string, unknown>).pattern;
  if (typeof patternRaw !== 'string') return fail('pattern is required and must be a string');
  const pattern = patternRaw.trim();
  if (pattern.length === 0) return fail('pattern is required');
  if (pattern.length > MAX_RULE_PATTERN_LENGTH) {
    return fail(`pattern must be at most ${MAX_RULE_PATTERN_LENGTH} characters`);
  }

  const category = oneOf(
    (raw as Record<string, unknown>).category,
    CATEGORY_RULE_TARGETS
  );
  if (!category) {
    return fail(`category must be one of: ${CATEGORY_RULE_TARGETS.join(', ')}`);
  }

  const priorityRaw = (raw as Record<string, unknown>).priority;
  if (priorityRaw === undefined || priorityRaw === null) {
    return fail('priority is required (lower number = higher precedence)');
  }
  const priority =
    typeof priorityRaw === 'number' ? priorityRaw : Number(String(priorityRaw).trim());
  if (!Number.isInteger(priority) || priority < MIN_RULE_PRIORITY || priority > MAX_RULE_PRIORITY) {
    return fail(`priority must be an integer between ${MIN_RULE_PRIORITY} and ${MAX_RULE_PRIORITY}`);
  }

  const enabledRaw = (raw as Record<string, unknown>).enabled;
  if (enabledRaw !== undefined && enabledRaw !== null && typeof enabledRaw !== 'boolean') {
    return fail('enabled must be a boolean when provided');
  }

  return {
    ok: true,
    value: {
      name,
      matchType,
      pattern,
      category,
      priority,
      enabled: enabledRaw === undefined || enabledRaw === null ? true : enabledRaw,
    },
  };
}
