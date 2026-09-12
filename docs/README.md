# OmniSight Web Documentation

Current operational and technical documentation for the OmniSight Web Admin Panel.

## Guides

| Document | Description |
|----------|-------------|
| [Architecture](ARCHITECTURE.md) | System architecture, component diagram, data flow |
| [API Reference](API.md) | REST API documentation for web and agent endpoints |
| [Security](SECURITY.md) | Authentication, authorization, encryption, security headers |
| [Testing](TESTING.md) | Unit tests, integration tests, E2E tests, test commands |
| [Deployment](DEPLOYMENT.md) | Production deployment guide, environment setup, Docker |
| [Troubleshooting](TROUBLESHOOTING.md) | Common issues, causes, and solutions |
| [Admin Guide](ADMIN_GUIDE.md) | Step-by-step guide for organization administrators |
| [Super Admin Guide](SUPER-ADMIN-OPERATOR-GUIDE.md) | Control-plane operations for platform administrators |
| [Agent Integration](AGENT_INTEGRATION.md) | How the Admin Panel communicates with the Desktop Agent |

## Quick Links

- **Getting Started**: See the [README](../README.md) Quick Start section
- **Environment Variables**: See `.env.example` for all configuration options
- **Database Schema**: See `prisma/schema.prisma` for all models
- **RBAC Permissions**: See `src/lib/permissions.ts` for role-permission mappings
- **Product Requirements**: See [master.PRD](../master.PRD) for the authoritative product definition
