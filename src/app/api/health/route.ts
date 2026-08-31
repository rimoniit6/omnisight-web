import { NextResponse } from 'next/server';
import { log, requestContext } from '@/lib/logger';
import { resolveStorageDriver } from '@/lib/storage';

// GET /api/health
// Public health check. Returns lightweight server availability info.
// Does NOT expose database credentials, env vars, or internal secrets.
export async function GET() {
  // Check storage driver health without exposing credentials.
  let storageStatus: 'ok' | 'misconfigured' = 'ok';
  try {
    resolveStorageDriver();
  } catch {
    storageStatus = 'misconfigured';
  }

  return NextResponse.json({
    status: storageStatus === 'ok' ? 'ok' : 'degraded',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    // Only the Next.js version is exposed — nothing sensitive.
    version: process.env.npm_package_version || '0.0.0',
    storage: storageStatus,
  });
}