// OmniSight — Deterministic policy resolver.
//
// Resolves an application identity against an organization's app policies.
// Pure and deterministic — no DB, no randomness — so it is independently
// testable and can run identically server-side and agent-side.
//
// PRECEDENCE (documented product contract, org-wide scope):
//   1. Explicit blacklist match  → BLOCK  (explicit deny wins)
//   2. Explicit whitelist match  → ALLOW
//   3. No matching policy        → none (default behavior)
//
// Identity strength ordering when multiple blacklist entries match: the
// strongest identity (hash > path > publisher+name > executable name) decides
// the single matched policy so the resolution is deterministic.

import {
  type PolicyAction,
  type AppListType,
} from './constants';
import {
  executableMatchKey,
  normalizeProcessPath,
  normalizePublisher,
  normalizeSha256,
} from './normalize';

/** The policy fields the resolver consumes (subset of AppListEntry). */
export interface ResolvablePolicy {
  id: string;
  listType: AppListType;
  appName: string;
  executableName: string | null;
  /** Normalized process path — compare with normalizeProcessPath(). */
  path?: string | null;
  publisher?: string | null;
  /** Lowercase hex SHA-256, or a value that isSha256() accepts. */
  sha256?: string | null;
  isActive?: boolean;
}

export interface ResolveInput {
  /** e.g. "chrome.exe" (may include a path — normalized to basename). */
  executableName?: string | null;
  /** Full process path when the agent can resolve it. */
  processPath?: string | null;
  publisher?: string | null;
  /** Lowercase hex SHA-256 when the agent can compute it. */
  sha256?: string | null;
}

export interface Resolution {
  action: PolicyAction;
  matchedPolicyId?: string;
  reason?: string;
}

interface Candidate {
  policy: ResolvablePolicy;
  strength: number; // higher = stronger identity match
}

function scorePolicy(policy: ResolvablePolicy, input: ResolveInput): number | null {
  // Strongest identity first: sha256 > exact process path > publisher+name >
  // executable name. A policy with no usable identity can never match.
  if (input.sha256 && policy.sha256 && normalizeSha256(policy.sha256) === normalizeSha256(input.sha256)) {
    return 4;
  }
  if (input.processPath && policy.path) {
    const policyPath = normalizeProcessPath(policy.path);
    if (policyPath && policyPath === normalizeProcessPath(input.processPath)) {
      return 3;
    }
  }
  if (input.publisher && policy.publisher && policy.executableName) {
    if (
      normalizePublisher(policy.publisher) === normalizePublisher(input.publisher) &&
      executableMatchKey(policy.executableName) === executableMatchKey(input.executableName) &&
      executableMatchKey(input.executableName) !== ''
    ) {
      return 2;
    }
  }
  if (policy.executableName && input.executableName) {
    const key = executableMatchKey(policy.executableName);
    if (key && key === executableMatchKey(input.executableName)) {
      return 1;
    }
  }
  return null;
}

/**
 * Resolve an application against the org's active policies.
 *
 * `policies` must already be filtered to active entries (the resolver also
 * defensively ignores `isActive === false` so callers can pass raw rows).
 *
 * Determinism: when several blacklist (or whitelist) entries match, the
 * strongest-identity entry wins; ties break on lexicographic id so the same
 * input always yields the same output.
 */
export function resolveApplicationPolicy(
  input: ResolveInput,
  policies: readonly ResolvablePolicy[]
): Resolution {
  const blacklistCandidates: Candidate[] = [];
  const whitelistCandidates: Candidate[] = [];

  for (const p of policies) {
    if (p.isActive === false) continue;
    const strength = scorePolicy(p, input);
    if (strength === null) continue;
    (p.listType === 'blacklist' ? blacklistCandidates : whitelistCandidates).push({
      policy: p,
      strength,
    });
  }

  const pick = (cands: Candidate[]): Candidate | null => {
    if (cands.length === 0) return null;
    cands.sort((a, b) =>
      b.strength - a.strength || (a.policy.id < b.policy.id ? -1 : a.policy.id > b.policy.id ? 1 : 0)
    );
    return cands[0];
  };

  // 1. Explicit deny wins over everything.
  const black = pick(blacklistCandidates);
  if (black) {
    return {
      action: 'block',
      matchedPolicyId: black.policy.id,
      reason: `Matched blacklist policy "${black.policy.appName}"`,
    };
  }

  // 2. Explicit allow.
  const white = pick(whitelistCandidates);
  if (white) {
    return {
      action: 'allow',
      matchedPolicyId: white.policy.id,
      reason: `Matched whitelist policy "${white.policy.appName}"`,
    };
  }

  // 3. Default.
  return { action: 'none' };
}
