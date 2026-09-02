# OmniSight Testing

## Overview

OmniSight has 100+ test files covering unit tests, integration tests, API tests, security tests, and E2E tests.

## Test Framework

- **Unit/Integration**: Node.js test runner via `tsx --test`
- **E2E**: Playwright (`@playwright/test`)

## Running Tests

### All Tests

```bash
npm test
```

### Specific Test Suites

```bash
# Consent management
npm run test:consent
npm run test:consent-seed
npm run test:consent-summary

# Location tracking
npm run test:location

# Projects
npm run test:projects
npm run test:project-sentiment

# Super Admin
npm run test:super-admin
npm run test:super-admin-orgs

# Agent
npm run test:agent-account
npm run test:agent-account-admin
npm run test:agent-login

# Health
npm run test:health

# Sentiment
npm run test:sentiment

# Members
npm run test:members-add
```

### E2E Tests

```bash
npx playwright test
```

### Individual Test Files

```bash
tsx --test tests/health.test.ts
tsx --test tests/consent.test.ts
tsx --test tests/location-distance.test.ts
```

## Test Categories

### Security Tests

| File | Description |
|------|-------------|
| `security.test.ts` | General security validation |
| `security-remediation.test.ts` | Security fix verification |
| `rbac-hardening.test.ts` | RBAC enforcement |
| `rbac-forensic-regression.test.ts` | RBAC regression prevention |
| `agent-hardening.test.ts` | Agent security |
| `agent-cross-org-attack.test.ts` | Cross-organization attack prevention |
| `agent-existing-device-security.test.ts` | Device security |
| `agent-token-sweep.test.ts` | Token cleanup |
| `super-admin-hardening.test.ts` | Super Admin security |
| `hardening.test.ts` | General hardening |
| `anomaly-hardening.test.ts` | Anomaly detection security |
| `break-hardening.test.ts` | Break mode security |
| `notification-alerting-hardening.test.ts` | Notification security |
| `presence-hardening.test.ts` | Presence tracking security |
| `policy-management-hardening.test.ts` | Policy enforcement security |
| `daily-summary-hardening.test.ts` | Daily summary security |
| `rate-limit-shared.test.ts` | Rate limiting |
| `svg-validation.test.ts` | SVG upload security |

### Feature Tests

| File | Description |
|------|-------------|
| `consent.test.ts` | Consent state machine |
| `consent-seed.test.ts` | Consent seeding |
| `consent-summary.test.ts` | Consent summary |
| `projects.test.ts` | Project CRUD |
| `projects-tracking.test.ts` | Project time tracking |
| `project-sentiment.test.ts` | Project sentiment |
| `project-time-sync.test.ts` | Activity → project time sync |
| `location-distance.test.ts` | Haversine distance calculation |
| `location-service.test.ts` | Location ingestion service |
| `location-route.test.ts` | Location API endpoint |
| `screenshots.test.ts` | Screenshot upload/serving |
| `audio.test.ts` | Audio transcription |
| `website-tracking.test.ts` | Website tracking |
| `website-100.test.ts` | Website tracking completeness |
| `active-project.test.ts` | Active project tracking |
| `presence.test.ts` | Employee presence |
| `live-updates-cursor.test.ts` | Realtime cursor polling |
| `live-updates-durable-cursor.test.ts` | Durable cursor persistence |
| `ws-invalidation.test.ts` | WebSocket invalidation |

### Agent Tests

| File | Description |
|------|-------------|
| `agent-account.test.ts` | Agent account management |
| `agent-account-admin.test.ts` | Agent account admin operations |
| `agent-auth-login.test.ts` | Agent login endpoint |
| `agent-discover.test.ts` | Agent device discovery |
| `agent-compat.test.ts` | Agent compatibility |
| `agent-process-exclusion.test.ts` | Agent process exclusion |
| `agent-active-device-backend.test.ts` | Active device management |

### Admin Tests

| File | Description |
|------|-------------|
| `admin-prod-sidebar.test.ts` | Admin sidebar navigation |
| `admin-prod-dashboard.test.ts` | Dashboard functionality |
| `admin-prod-monitoring.test.ts` | Monitoring features |
| `admin-prod-settings.test.ts` | Settings management |
| `admin-prod-reports-rbac.test.ts` | Reports RBAC |
| `admin-prod-analytics-fixes.test.ts` | Analytics fixes |
| `admin-section-hardening.test.ts` | Admin section security |
| `admin-telemetry-backend.test.ts` | Telemetry backend |

### Dashboard Tests

| File | Description |
|------|-------------|
| `dashboard-api.test.ts` | Dashboard API |
| `dashboard-productivity.test.ts` | Productivity analytics |

### Multi-Org Tests

| File | Description |
|------|-------------|
| `multi-org.test.ts` | Multi-organization basics |
| `multi-org-ga.test.ts` | Multi-org general availability |
| `multi-org-isolation.test.ts` | Tenant isolation |
| `organization-bootstrap.test.ts` | Organization bootstrap |

### Other Tests

| File | Description |
|------|-------------|
| `branding-regression.test.ts` | Branding regression |
| `health.test.ts` | Health endpoint |
| `devices-pagination.test.ts` | Device pagination |
| `device-status.test.ts` | Device status |
| `device-integrity.test.ts` | Device integrity |
| `notification-alerting-hardening.test.ts` | Notification alerting |
| `export-bounded.test.ts` | Export bounds |
| `client-ip.test.ts` | Client IP resolution |
| `audit-action-normalizer.test.ts` | Audit log normalization |
| `png-dimensions.test.ts` | PNG dimension validation |
| `timezone-boundaries.test.ts` | Timezone handling |
| `create-user-flow-integration.test.ts` | User creation flow |
| `demo-data-integrity.test.ts` | Demo data integrity |
| `react-duplicate-key-regression.test.ts` | React key regression |

## Code Quality

### Type Checking

```bash
npx tsc --noEmit
```

### Linting

```bash
npm run lint
```

### Production Build

```bash
npm run build
```

## Test Architecture

Tests use a shared test database (`PG_TEST_BASE_URL`) and create isolated test data per test case. Tests are designed to be:

1. **Isolated**: Each test creates its own data and cleans up after
2. **Deterministic**: No `Math.random()` in production code paths (verified by tests)
3. **Parallel-safe**: Database-level deduplication and locking prevent race conditions
4. **Realistic**: Tests exercise actual API endpoints, not mocked internals

## Writing Tests

Tests follow this pattern:

```typescript
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';

describe('Feature Name', () => {
  let testOrgId: string;

  before(async () => {
    // Set up test data
  });

  after(async () => {
    // Clean up test data
  });

  test('should do something', async () => {
    // Arrange
    // Act
    // Assert
    assert.equal(result, expected);
  });
});
```
