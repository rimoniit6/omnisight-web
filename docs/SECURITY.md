# OmniSight Security

## Overview

OmniSight implements defense-in-depth security across authentication, authorization, data protection, and infrastructure. This document covers the actual security mechanisms implemented in the codebase.

---

## Authentication

### Web Authentication

- **Mechanism**: Custom JWT (HMAC-SHA256) + httpOnly session cookie
- **Password hashing**: bcrypt with 12 rounds (`bcryptjs`)
- **Session storage**: Server-authoritative `UserSession` rows in PostgreSQL
- **Session lifetime**: Configurable via `JWT_EXPIRES_IN` (default: 7 days)
- **Algorithm restriction**: Only HS256 accepted; `alg:none` and algorithm confusion rejected

### Session Revocation

Every authenticated request re-validates the JWT against the `UserSession` table. This enables:

- **Logout**: Revokes the session row immediately
- **Force logout**: Revokes all sessions for a user
- **Account disable**: Sessions revoked at disable time
- **Password change**: All OTHER sessions revoked (current survives)
- **Org switch**: Old tokens with previous org are rejected

### Agent Authentication

Two separate token types prevent privilege escalation:

1. **AgentSession** (login-only): Short-lived, issued by `/api/agent/login`. Only authorizes device discovery. Does NOT grant access to heartbeat/activity/screenshot endpoints.
2. **AgentToken** (device-bound): 24-hour, issued by `/api/agent/authenticate` after admin approval. Authorizes all data submission endpoints.

### Password Security

- bcrypt hashing (12 rounds) for all passwords
- Legacy plaintext passwords are auto-migrated to bcrypt on successful login
- Password change revokes all other sessions
- Minimum length enforcement

---

## Authorization (RBAC)

### Role Hierarchy

| Role | Level | Scope |
|------|-------|-------|
| `super_admin` | 50 | Platform-wide (all organizations) |
| `org_admin` | 35 | Organization-wide |
| `manager` | 20 | Organization (operational) |
| `viewer` | 10 | Organization (read-only) |

### Permission System

50+ granular permissions defined in `src/lib/permissions.ts`:

- **Platform permissions**: `platform.organizations.*`, `platform.settings.*`, `platform.audit.*`, `platform.members.*`
- **Organization permissions**: `organization.*`, `employees.*`, `devices.*`, `projects.*`, `reports.*`, `agents.*`, `consent.*`, `policies.*`, `alerts.*`, `anomalies.*`, `notifications.*`, `dashboard.*`, `analytics.*`, `insights.*`, `sentiment.*`

### DB-Verified Roles

For highly privileged operations (role changes, membership management), the role is verified from the DATABASE, not from the JWT. This closes the window where a revoked role is still accepted because the JWT hasn't expired.

---

## Tenant Isolation

### Organization Scoping

Every data model includes an `organizationId` field. All queries are scoped to the active organization:

1. **JWT claims**: `organizationId` and `activeOrganizationId` are HMAC-signed
2. **Session row**: `UserSession.activeOrganizationId` is server-authoritative
3. **API middleware**: `requireActiveSessionOrg()` validates org status and membership
4. **Membership check**: Active `OrganizationMembership` required for non-super-admins

### Organization Status Enforcement

Suspended/archived organizations are rejected at the API level, even for authenticated sessions. This prevents retained web-admin sessions from keeping access after suspension.

---

## Encryption at Rest

### Secret Encryption

- **Algorithm**: AES-256-GCM (12-byte random IV, 16-byte auth tag)
- **Key derivation**: SHA-256 from `ENCRYPTION_KEY` environment variable
- **Format**: `v1:<iv-base64>:<tag-base64>:<ciphertext-base64>`
- **Usage**: AI provider API keys, sensitive configuration values
- **Independence**: `ENCRYPTION_KEY` is independent from `JWT_SECRET`

### Development Key

In development, if `ENCRYPTION_KEY` is unset, a per-workspace key is generated and persisted at `.worklens/dev.key` (gitignored). This keeps dev workflows friction-free while maintaining key independence.

---

## Placeholder Secret Detection

The system rejects known placeholder/default secret values:

- `replace_with_*`, `change_me`, `your_secret`, `example`, `default`, `password`, `admin`, `test`, `dev`, `placeholder`, `todo`, `fixme`
- Minimum length enforcement (16+ chars for JWT_SECRET and ENCRYPTION_KEY)
- Applied at startup and on every secret use

---

## Rate Limiting

### Implementation

PostgreSQL-backed token bucket with atomic UPSERT. Concurrent requests across any number of app instances serialize on the row lock.

### Applied To

| Endpoint | Limit | Window |
|----------|-------|--------|
| Web login (per-email) | 5 attempts | 15 minutes |
| Web login (per-IP+email) | 5 attempts | 15 minutes |
| Agent login (per-IP) | Configurable | Configurable |
| Agent authenticate (per-IP) | Configurable | Configurable |

### Response

Rate-limited requests receive `429 Too Many Requests` with `Retry-After` header.

---

## Security Headers

Applied via Next.js `next.config.ts`:

| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Security-Policy` | Environment-aware | Prevents XSS (dev allows `unsafe-eval` for HMR) |
| `X-Frame-Options` | `DENY` | Clickjacking protection |
| `X-Content-Type-Options` | `nosniff` | MIME sniffing protection |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | HTTPS enforcement |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Referrer leakage prevention |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), notifications=()` | Feature restriction |

---

## File Upload Security

### SVG Validation

Inline SVG logos undergo comprehensive sanitization:

- `<script>` tags removed
- Event handler attributes (`on*`) removed
- Dangerous elements removed: `<foreignObject>`, `<iframe>`, `<embed>`, `<object>`, `<applet>`, `<use>`, `<image>`
- `javascript:` and `vbscript:` URIs removed
- `data:` URIs in href/src removed (except `data:image/*`)
- `<style>` elements removed (CSS injection vector)
- `eval()`, `expression()`, `Function()` patterns removed
- Maximum size: 1MB

### Screenshot Validation

- Image format verification (PNG, JPEG)
- Dimension validation
- File size limits
- Storage driver validation (placeholder URL detection)

---

## CSRF Protection

- Session cookie uses `SameSite=Lax` (allows top-level navigations, blocks cross-site POST)
- `httpOnly` flag prevents JavaScript access to the cookie
- `secure` flag enabled in production (HTTPS only)

---

## Audit Logging

All sensitive operations are logged in the `AuditLog` table:

- Login/logout events
- Employee CRUD operations
- Device management
- Consent changes
- Organization changes
- Report generation
- Configuration changes

Audit records survive organization archival/deletion (FK `SetNull` on org delete).

---

## Agent Security

### Token Security

- Agent tokens are 64-char cryptographically random (using `randomBytes`, never `Math.random`)
- Tokens are bound to a specific device and organization
- Cross-org integrity: token's organization must match employee's organization
- Device status check: inactive/revoked devices immediately invalidate tokens
- Employee status check: inactive employees cannot authenticate
- Organization status check: suspended/archived organizations block agent operations

### Claim Secret Security

- Claim secrets are 32-byte base64url (cryptographically random)
- Only SHA-256 hash stored server-side (never plaintext)
- Constant-time comparison for verification
- One-time use (verified once at authentication)

### Single Active Device Rule

One employee may have many registered devices, but only one device may hold a valid active `AgentToken` at a time. Enforcement uses `Employee FOR UPDATE` row locking to serialize concurrent activations.

---

## Known Security Limitations

1. **No code signing**: The Agent installer is not currently code-signed
2. **No 2FA**: Two-factor authentication is not implemented
3. **No IP allowlisting**: API access is not restricted by IP (rate limiting only)
4. **No request signing**: Agent API requests use Bearer tokens only (no HMAC request signing)
5. **Session cookie lifetime**: Default 7 days; shorter values require configuration

---

## Security Testing

The repository includes security-focused tests:

- `tests/security.test.ts` — General security tests
- `tests/security-remediation.test.ts` — Security fix verification
- `tests/rbac-hardening.test.ts` — RBAC enforcement tests
- `tests/agent-hardening.test.ts` — Agent security tests
- `tests/agent-cross-org-attack.test.ts` — Cross-organization attack prevention
- `tests/agent-existing-device-security.test.ts` — Device security tests
- `tests/rate-limit-shared.test.ts` — Rate limiting tests
- `tests/hardening.test.ts` — General hardening tests
- `tests/super-admin-hardening.test.ts` — Super Admin security tests
