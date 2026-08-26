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
export async function GET() {
  return NextResponse.json({
    product: 'omnisight',
    service: 'omnisight-web',
    version: process.env.npm_package_version || '0.0.0',
    agentProtocol: 1,
  });
}