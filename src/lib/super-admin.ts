// OmniSight — Production Super Admin Bootstrap
//
// The ONLY initial account bootstrap in the system. The Super Admin identity
// is created exclusively from the SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD
// environment variables:
//
//   First bootstrap  -> creates the Super Admin (bcrypt-hashed password)
//   Later restarts   -> finds the existing account and leaves it UNCHANGED
//                       (the password is NEVER overwritten automatically)
//
// Guarantees:
//   - Throws when the env variables are missing, malformed, or weak
//   - Creates NO demo users, NO demo organization, NO demo employees
//   - Creates NO consent records (approval != consent is untouched here)
//   - Never exposes the password in any return value or log
//
// This module is imported by `scripts/bootstrap-super-admin.ts` (the CLI that
// production deployments run) and by the regression test suite.

import { db } from '@/lib/db';
import { hashPassword } from '@/lib/auth';

/**
 * The two environment keys the bootstrap reads. Using a Record type keeps
 * this compatible with process.env while remaining injectable for tests.
 */
export type SuperAdminEnv = Record<string, string | undefined> & {
  SUPER_ADMIN_EMAIL?: string;
  SUPER_ADMIN_PASSWORD?: string;
  SUPER_ADMIN_NAME?: string;
};

export interface BootstrapResult {
  email: string;
  /** true when this run created the account (first bootstrap). */
  created: boolean;
  /** true when the account already existed and was left untouched. */
  alreadyExisted: boolean;
  user: {
    id: string;
    email: string;
    role: string;
    isActive: boolean;
    organizationId: string | null;
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate the environment-driven Super Admin credentials.
 * Throws a descriptive Error for each failure class so production startup
 * (or the bootstrap command) fails clearly instead of silently degrading.
 */
export function validateSuperAdminEnv(env: SuperAdminEnv = process.env): { email: string; password: string } {
  const email = (env.SUPER_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = env.SUPER_ADMIN_PASSWORD ?? '';

  if (!email || !password) {
    throw new Error('SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set in the environment');
  }
  if (!EMAIL_RE.test(email)) {
    throw new Error(`SUPER_ADMIN_EMAIL is not a valid email address: ${email}`);
  }
  if (password.length < 12) {
    throw new Error('SUPER_ADMIN_PASSWORD must be at least 12 characters');
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
    throw new Error('SUPER_ADMIN_PASSWORD must contain uppercase, lowercase and at least one digit');
  }
  return { email, password };
}

/**
 * Idempotent bootstrap. Creates the Super Admin if it does not exist; if an
 * account with the configured email already exists it is left completely
 * untouched (password, role, active state — nothing is overwritten).
 * A deliberate password rotation must be an explicit, separate operation.
 */
export async function bootstrapSuperAdmin(env: SuperAdminEnv = process.env): Promise<BootstrapResult> {
  const { email } = validateSuperAdminEnv(env);

  // Case-insensitive lookup (AppUser.email is unique, but the configured
  // email may differ in case from what was stored on first bootstrap).
  const existing = await db.appUser.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
  });
  if (existing) {
    return {
      email: existing.email,
      created: false,
      alreadyExisted: true,
      user: {
        id: existing.id,
        email: existing.email,
        role: existing.role,
        isActive: existing.isActive,
        organizationId: existing.organizationId,
      },
    };
  }

  const { password } = validateSuperAdminEnv(env);
  const hashed = await hashPassword(password);
  const name = (env.SUPER_ADMIN_NAME ?? '').trim() || 'Super Admin';
  const user = await db.appUser.create({
    data: {
      email,
      name,
      password: hashed,
      role: 'super_admin',
      isActive: true,
      avatar: null,
      organizationId: null, // org-less global super admin — org is created later by the admin
    },
  });

  return {
    email: user.email,
    created: true,
    alreadyExisted: false,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      organizationId: user.organizationId,
    },
  };
}
