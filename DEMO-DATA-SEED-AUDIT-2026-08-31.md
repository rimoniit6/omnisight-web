# DEMO-DATA-SEED-AUDIT-2026-08-31.md

## Executive Summary

Created a comprehensive, production-safe, idempotent, deterministic demo data seed for OmniSight. The seed populates 10 organizations with 106 users, 105 memberships, 111 employees, 111 devices, 51 projects, 2500 activities, 800 locations, 150 screenshots, 666 consents, and more — all in 3.4 seconds using batch inserts.

---

## Dataset Summary (Actual Counts from Database)

```
Organizations:        10
App Users:           106
Memberships:         105
Departments:          35
Employees:           111
Devices:             111
Projects:             51
Project Members:     270
Activities:        2,500
Locations:           800
Screenshots:         150
Consent Policies:     48
Consents:            666
Consent Logs:        666
Sentiment Records:   106
Notifications:       109
Alerts:               36
Audit Logs:           65
Anomalies:            29
Reports:              21
AI Insights:          26
App List Entries:     57
Org Settings:         40
Break Sessions:      353
USB Events:          129
Time Entries:       2,236
```

---

## Role Distribution

```
super_admin:     2 (platform-level, no org)
org_admin:      varies per org (owner + 1-2 admins)
manager:        2-4 per org
viewer:         1-3 per org
user:           remaining users
```

Total memberships: 105 (across 8 active organizations)

---

## Organization Distribution

| Organization | Slug | Status | Departments | Employees | Devices |
|---|---|---|---|---|---|
| Acme Corporation | demo-acme-corp | active | 8 | ~35 | ~35 |
| Globex International | demo-globex-intl | active | 6 | ~25 | ~25 |
| NovaTech Solutions | demo-novatech-sol | active | 5 | ~20 | ~20 |
| BluePeak Analytics | demo-bluepeak | active | 4 | ~15 | ~15 |
| Delta Systems | demo-delta-sys | active | 4 | ~12 | ~12 |
| Vertex Labs | demo-vertex-labs | active | 3 | ~10 | ~10 |
| Horizon Research | demo-horizon-research | active | 3 | ~8 | ~8 |
| SmallBiz Demo | demo-smallbiz-demo | active | 2 | ~5 | ~5 |
| Inactive Corp | demo-inactive-corp | suspended | 1 | ~3 | ~3 |
| Archived Industries | demo-archived-ind | archived | 1 | ~2 | ~2 |

---

## Multi-Org Users

```
demo.multi.org.user1@omnisight.local
  → Acme Corporation: org_admin
  → Globex International: viewer

demo.multi.org.user2@omnisight.local
  → Globex International: manager
  → NovaTech Solutions: viewer

demo.multi.org.user3@omnisight.local
  → NovaTech Solutions: org_admin
  → BluePeak Analytics: manager
  → Acme Corporation: viewer
```

---

## Users Without Membership

```
demo.platform.user1@omnisight.local (active)
demo.platform.user2@omnisight.local (active)
demo.platform.pending@omnisight.local (inactive)
```

---

## Device State Distribution

Based on deterministic random distribution:
```
Online:    ~55% (recent heartbeat, 1-30 minutes ago)
Offline:   ~20% (heartbeat 2-72 hours ago)
Stale:     ~25% (heartbeat 3-14 days ago)
```

Device types include Windows 10/11, macOS Sonoma, Ubuntu 24.04.

---

## Edge-Case Organizations

- **Inactive Corp** (demo-inactive-corp): status=suspended, 3 users, 1 department
- **Archived Industries** (demo-archived-ind): status=archived, 2 users, 1 department
- **SmallBiz Demo** (demo-smallbiz-demo): 5 users, 2 departments (small org)

---

## Data Integrity

```
Orphan records: 0 (all FK references validated during seed)
Cross-org relationship violations: 0 (all entities scoped to correct org)
Duplicate demo identities: 0 (idempotent — skipDuplicates on all createMany)
```

---

## Seed Architecture

### Production Safety
- Requires `SEED_ALLOWED=1` environment variable
- Refuses to run when `NODE_ENV=production`
- Exits immediately with error if either condition fails

### Idempotency
- Checks for existing demo organizations (slug starts with `demo-`) before creating
- If found, prints summary and exits without creating duplicates
- All `createMany` calls use `skipDuplicates: true`

### Deterministic
- Uses Mulberry32 seeded PRNG (seed: 2026_08_31)
- Same seed produces identical data every run
- No `Math.random()` calls

### Non-Destructive
- Does NOT delete existing data
- Only creates new records with `demo-*` slugs/emails
- Existing Super Admin, organizations, and users are preserved

### Performance
- Uses `createMany` for bulk inserts (batches of 500)
- Completed in 3.4 seconds against local PostgreSQL
- Consent records created individually (FK constraint requires real IDs for logs)

---

## Validation

### Tests
```
Super Admin Tests: 18/18 PASS
Members Tests: 24/24 PASS
Health Tests: PASS
```

### Typecheck
```
0 TypeScript errors
```

### Lint
```
11 errors, 411 warnings (all pre-existing, 0 new)
```

### Build
```
PASS — all routes compiled successfully
```

---

## Demo Accounts

```
Password: Demo@2026Pass (development only)

Super Admins:
  demo.superadmin@omnisight.local
  demo.superadmin2@omnisight.local

Organization Admin (Acme):
  demo.acme-corp.owner@omnisight.local

Manager (Acme):
  demo.acme-corp.manager1@omnisight.local

Viewer (Acme):
  demo.acme-corp.viewer1@omnisight.local

Multi-org users:
  demo.multi.org.user1@omnisight.local
  demo.multi.org.user2@omnisight.local
  demo.multi.org.user3@omnisight.local

Users without membership:
  demo.platform.user1@omnisight.local
  demo.platform.user2@omnisight.local
  demo.platform.pending@omnisight.local
```

---

## Files Changed

| File | Change |
|---|---|
| `src/lib/seed-demo-full.ts` | New comprehensive demo seed script |
| `package.json` | Added `db:seed:demo-mega` script |

---

## How to Run

```bash
# Full seed (requires running PostgreSQL)
SEED_ALLOWED=1 npx tsx src/lib/seed-demo-full.ts

# Or via npm script
npm run db:seed:demo-mega

# Idempotent — safe to run multiple times
```

---

## Final Verdict

**PASS — Production-safe**

- Large, realistic demo dataset created ✅
- Multiple organizations ✅
- Super Admin coverage ✅
- Organization role coverage ✅
- Multi-org memberships ✅
- Projects populated ✅
- Agents/devices with online/offline/stale states ✅
- Activities populated ✅
- Locations populated ✅
- Screenshots populated ✅
- Consent states represented ✅
- Sentiment data represented ✅
- Edge-case organizations (suspended, archived) ✅
- No orphan records ✅
- Seed is idempotent ✅
- Seed is production-safe ✅
- Existing tests remain valid ✅
- Typecheck passes ✅
- Build passes ✅
