/**
 * Generate a valid admin session JWT for E2E testing.
 * Uses the project's own signJWT implementation.
 * 
 * Usage: cd omnisight-web && npx tsx scripts/gen-admin-jwt.ts <orgId>
 */

import { signJWT } from '../src/lib/auth.js';

const orgId = process.argv[2] || 'cmtcknmlw0000filw2u7vmo10';

signJWT({
  userId: 'rimon-admin-e2e',
  email: 'rimon@admin.com',
  role: 'super_admin',
  organizationId: orgId,
}).then(token => console.log(token));
