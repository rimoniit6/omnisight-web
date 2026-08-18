import { NextResponse } from 'next/server';

// GET /api/health
// Public health check. Returns lightweight server availability info.
// Does NOT expose database credentials, env vars, or internal secrets.
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    // Only the Next.js version is exposed — nothing sensitive.
    version: process.env.npm_package_version || '0.0.0',
  });
}