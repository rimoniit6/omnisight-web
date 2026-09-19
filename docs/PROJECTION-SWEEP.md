# Projection Sweep — full-row `findMany` hardening

**Status:** in progress (baseline reduced 43 → 19 warnings)

## Why

Prisma `.findMany()` without `select`/`include` loads **every column** of every
matched row, JSON/blob columns included. Across high-volume or payload-heavy
models this is avoidable I/O and memory. The custom lint rule
`omnisight/prisma-select` (`eslint-rules/prisma-select.mjs`) flags every such
call in `src/**`. At the sweep start the whole repo had **43** flagged sites.

## Strategy

- **Narrowed (real optimization):** the handler reads a strict subset of the
  row's columns → add an explicit `select` with exactly those fields.
- **Tracked debt:** the endpoint serializes the whole row (feed/list contract,
  object spread, or a serializer that needs most scalars), or the query is a
  full-row replication copy → no `select` today. These are documented below,
  bounded already by `pagination`/`take`, and will be addressed only when a
  consumer contract shrinks.

The narrowed set is CI-guarded by `scripts/lint-projections.mjs`
(`npm run lint:projections`), which re-runs eslint with
`omnisight/prisma-select: error` over the curated file list — a net-new
full-row `findMany` in a narrowed file fails CI. The remaining warnings stay
at WARN until each debt site is drained (then it is added to the gate list).

## Before / after example — `src/lib/pricing.ts`

Before (full-row read of every active offer):

```ts
const candidates = await db.offer.findMany({
  where: { isActive: true },
});
```

After (only the columns the pricing resolver actually consumes — the `OfferRow`
interface fields):

```ts
const candidates = await db.offer.findMany({
  where: { isActive: true },
  select: {
    id: true,
    name: true,
    discountType: true,
    discountValue: true,
    isFree: true,
    startsAt: true,
    endsAt: true,
    planId: true,
    deploymentMode: true,
    billingPeriod: true,
    pricingId: true,
    createdAt: true,
  },
});
```

## Narrowed (CI-gated)

| File | Model(s) narrowed |
| --- | --- |
| `src/lib/pricing.ts:218` | `Offer` |
| `src/lib/migration/runner.ts:434` | `InfrastructureMigration` (stranded-cutover resume) |
| `src/lib/jobs/settings.ts:289` | `OrganizationSetting` (key/value only) |
| `src/app/api/admin/infrastructure-requests/route.ts:51` | `InfrastructureMigration` (queue progress view) |
| `src/app/api/category-rules/dry-run/route.ts:88` | `CategoryRule` (classification-match fields only) |
| `src/app/api/device-claims/[id]/approve/route.ts:107` | `Project` (id/name/status) |
| `src/app/api/employees/[id]/keyboard/route.ts:98` | `KeyboardActivity` |
| `src/app/api/employees/[id]/location/route.ts:91` | `LocationEvent` |
| `src/app/api/employees/[id]/performance/route.ts:32,162` | `Activity`, `Device` |
| `src/app/api/employees/[id]/webcam/route.ts:51` | `WebcamSession` (recent) |
| `src/app/api/organization/ai-settings/route.ts:54` | `OrganizationSetting` (key/value only) |
| `src/app/api/plans/route.ts:21,28,29` | `Plan`, `PlanPricing`, `Offer` |
| `src/app/api/reports/daily/ai-summary/route.ts:147` | `Activity` (duration/type/category) |
| `src/app/api/reports/generate/route.ts:320` | `Activity` (duration/category/app/url) |
| `src/app/api/reports/pdf/audit/route.ts:60` | `AuditLog` (PDF table columns) |
| `src/app/api/reports/pdf/dashboard/route.ts:222` | `Alert` (PDF table columns) |
| `src/app/api/sentiment/analyze/route.ts:440` | `Employee` (id/firstName/lastName) |
| `src/app/api/settings/monitoring/route.ts:66` | `OrganizationSetting` (key/value only) |
| `src/app/api/settings/retention/route.ts:37` | `OrganizationSetting` (key/value only) |

## Tracked debt (warn, not yet gated)

| Site | Model | Why it stays full-row |
| --- | --- | --- |
| `src/app/api/alerts/route.ts:52` | `Alert` | feed — returns `data: alerts` raw |
| `src/app/api/notifications/route.ts:60` | `Notification` | feed — paginated list, raw rows |
| `src/app/api/audit-logs/route.ts:50` | `AuditLog` | feed — raw rows |
| `src/app/api/super-admin/organizations/[orgId]/audit-logs/route.ts:43` | `AuditLog` | SA feed — raw rows |
| `src/app/api/insights/route.ts:14` | `AiInsight` | feed — raw rows |
| `src/app/api/app-list/route.ts:52` | `AppListEntry` | feed — raw rows |
| `src/app/api/consent/logs/route.ts:52` | `ConsentLog` | feed — raw rows |
| `src/app/api/consent/policies/route.ts:33` | `ConsentPolicy` | response embeds whole policy objects (published + versions) |
| `src/app/api/policy-violations/route.ts:41` | `PolicyViolation` | feed — raw rows |
| `src/app/api/organization/route.ts:34` | `AuditLog` | org overview — raw `recentAuditLogs` (take 10) |
| `src/app/api/employees/[id]/detail/route.ts:282` | `Alert` | detail feed — raw rows (take 20) |
| `src/app/api/alert-rules/route.ts:20` | `AlertRule` | response object-spreads the row (`...rule`) |
| `src/app/api/settings/route.ts:40` | `SystemSetting` | response object-spreads + groups; also redacts secrets before emitting |
| `src/app/api/usb-events/route.ts:64` | `UsbEvent` | response object-spreads (`...e`) then enriches |
| `src/app/api/super-admin/notifications/route.ts:99` | `Notification` | cross-DB merge; dedupe + bounded cap (`MERGE_SCAN_CAP`) |
| `src/lib/infrastructure.ts:406` | `InfrastructureChangeRequest` | `serializeChangeRequest` consumes ~all scalars (secret envelopes included) |
| `src/lib/migration/db-migrate.ts:1223,1456` | org tables (dynamic delegate) | row **copy** to destination DB — full fidelity required; dynamic delegate cannot project |

## Adding a file to the gate

1. Add the `select` (or `include`) to the query so the warning disappears.
2. Append the repository-relative path to `FILES` in
   `scripts/lint-projections.mjs` (alphabetical).
3. Move the row from **Tracked debt** to **Narrowed** in this doc.
4. Run `npm run typecheck`, `npm run lint`, `npm run lint:projections`.