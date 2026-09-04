import { NextResponse } from 'next/server';
import { log, requestContext } from '@/lib/logger';

// GET /api/agent/compat
// Public, zero-write fingerprint endpoint used by the Local Agent Builder
// (omnisight-agent) to POSITIVELY identify an OmniSight server before baking
// its URL into a packaged agent. The generic /api/health response
// ({status:'ok'}) is indistinguishable from any web server; this endpoint
// answers "are you an OmniSight server, and which agent protocol do you
// speak?" without exposing any internal state, secrets, or configuration.
// No DB access, no rate limiting, no auth — a static fingerprint.
//
// Phase 3: extended with minAgentVersion (builder/runtime compatibility
// floor), serverVersion (informational), and supportedDeploymentModes (the
// deployment modes this API release can serve). All fields are ADDITIVE —
// older builders checking product/service/agentProtocol keep working.
export async function GET() {
  return NextResponse.json({
    product: 'omnisight',
    service: 'omnisight-web',
    version: process.env.npm_package_version || '0.0.0',
    serverVersion: process.env.npm_package_version || '0.0.0',
    agentProtocol: 1,
    minAgentVersion: '1.1.0',
    supportedDeploymentModes: ['MANAGED', 'CUSTOMER_DB', 'PRIVATE'],
  });
}