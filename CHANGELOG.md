# Changelog

All notable changes to the OmniSight Web Admin Panel are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

---

## [0.2.1] - 2026-09-02

### Added
- Complete documentation system (README, Architecture, API, Security, Testing, Deployment, Troubleshooting, Admin Guide, Agent Integration)
- Real-time live-updates service (Socket.io, Bun runtime)
- Multi-organization support with membership-based RBAC
- Server-authoritative web sessions with revocation
- Organization switching for multi-org users
- Hierarchical branding (platform → organization → defaults)
- SVG logo upload with comprehensive XSS sanitization
- Logo size presets (original, small, medium, large, custom)
- Dual-layer rate limiting (per-email + per-IP+email)
- Placeholder secret detection
- DB-verified roles for privileged operations
- Consent state machine with versioning and audit trail
- App whitelist/blacklist with SHA256/publisher verification
- Policy violation tracking
- USB device monitoring events
- Webcam session management (metadata only)
- Agent command channel (webcam start/stop)
- Break mode management (admin, self-service, agent)
- Audio transcription (Whisper-based microservice)
- Sentiment analysis (employee and project-level)
- AI insights and anomaly detection
- Background job system with lease-based execution
- Project time sync engine (activity → time entries)
- Active tracking project for employees
- Employee self-service portal
- Notification preferences (org-level)
- Health check endpoint
- Audit log export
- CSV/PDF/Excel export
- Comprehensive test suite (100+ test files)

### Changed
- Migrated from SQLite to PostgreSQL (Supabase)
- Migrated from AppUser.organizationId to OrganizationMembership for multi-org
- Enhanced JWT with server-authoritative session validation
- Improved RBAC with 50+ granular permissions
- Enhanced security headers (CSP, HSTS, X-Frame-Options)
- Improved agent authentication with separate token types

### Fixed
- Cross-organization data leakage prevention
- Rate limit bypass via IP rotation
- Consent state machine concurrency issues
- SVG upload XSS vulnerabilities
- Session revocation on password change
- Organization status enforcement for suspended/archived orgs

### Removed
- Seat limit fields (employee capacity is unlimited)
- SQLite database support (PostgreSQL only)
- Legacy stateless JWT tokens (all tokens now have session binding)

---

## [0.2.0] - 2026-08-28

### Added
- Multi-organization architecture
- Organization membership model
- Organization switching
- Platform branding (Super Admin)
- Organization branding overrides
- Device claim approval workflow
- Agent login flow (PATH B)
- Single active device enforcement
- Break mode management
- Consent policy versioning
- App whitelist/blacklist
- Policy violation tracking
- USB monitoring events
- Webcam session management
- Agent command channel
- Background job system
- Project time sync engine
- Sentiment analysis
- AI insights
- Anomaly detection
- Notification preferences
- Health check endpoint

### Changed
- Enhanced RBAC with platform and organization permissions
- Improved rate limiting with PostgreSQL-backed token bucket
- Enhanced security headers

---

## [0.1.0] - 2026-08-18

### Added
- Initial release
- Employee management
- Device management
- Activity monitoring
- Screenshot capture and serving
- Location tracking (native + IP fallback)
- Keyboard telemetry
- Project management
- Time tracking
- Consent management
- Dashboard with KPI cards and charts
- Real-time activity feed
- Report generation (PDF, Excel, CSV)
- Audit logging
- User authentication (JWT)
- Role-based access control
