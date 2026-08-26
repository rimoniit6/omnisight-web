import { NextResponse } from 'next/server';
import { NOTIFICATION_TYPE_REGISTRY } from '@/lib/notifications/constants';
import { log, requestContext } from '@/lib/logger';

export async function GET() {
  // Honest registry (N-6): `active: true` means a REAL producer exists in the
  // repository today; `active: false` types are planned, not currently
  // produced. The UI must not claim unsupported automatic detection.
  return NextResponse.json({ types: NOTIFICATION_TYPE_REGISTRY });
}
