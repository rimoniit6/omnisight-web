// OmniSight — Default classification heuristics (server mirror, Phase 3).
//
// These two functions are the SERVER-side mirror of the Desktop Agent's local
// collection-time heuristics:
//   - omnisight-agent/src/collectors/activity-collector.ts  → categorize()
//   - omnisight-agent/src/collectors/website-collector.ts   → categorizeDomain()
//
// They are the DEFAULT fallback when an org has `server_classification`
// enabled but no CategoryRule matches a row — reproducing EXACTLY the
// category the agent would have assigned, so enabling rules never changes
// behavior for unmatched rows (no sudden dashboard changes).
//
// KEEP IN SYNC with the agent collectors. The tests in
// tests/category-classification.test.ts lock the shared samples so drift is
// caught. Match targets match the engine's fields:
//   - application rows classify on `applicationName` (the process/exe name)
//   - website rows classify on `url` (the normalized bare domain)

/** Default category for an application row, from its executable name. */
export function defaultApplicationCategory(appName: string | null | undefined): string {
  const name = (appName ?? '').toLowerCase();
  if (/(code|visual studio|intellij|sublime|notepad|terminal|cmd|powershell|vim|jetbrains)/.test(name)) {
    return 'productive';
  }
  if (/(chrome|firefox|edge|slack|teams|outlook|zoom|excel|word|powerpoint|notion|figma|jira|github)/.test(name)) {
    return 'neutral';
  }
  if (/(youtube|netflix|steam|game|spotify|twitch|facebook|instagram|tiktok|reddit)/.test(name)) {
    return 'unproductive';
  }
  return 'neutral';
}

/** Default category for a website row, from its normalized bare domain. */
export function defaultDomainCategory(domain: string | null | undefined): string {
  const d = (domain ?? '').toLowerCase();
  if (/(youtube|netflix|twitch|hulu|spotify|steam|epicgames|facebook|instagram|tiktok|reddit|twitter|\bx\.com|discord|9gag|imgur|pinterest|snapchat|whatsapp)/.test(d)) {
    return 'unproductive';
  }
  if (/(github|gitlab|stackoverflow|stackexchange|bitbucket|jira|notion|confluence|linear\.app|figma|asana|trello|slack|docs\.google|lucidchart|code\.visualstudio|w3schools|geeksforgeeks|coursera|udemy|pluralsight|learn\.)/.test(d)) {
    return 'productive';
  }
  return 'neutral';
}
