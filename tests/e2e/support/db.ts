/**
 * Raw pg helper for the E2E suite — deliberately avoids importing the app's
 * Prisma client (its module chain uses @/ aliases). Only raw SQL needed by
 * session-lifecycle tests lives here.
 */
import pg from 'pg';

const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL || `${PG_TEST_BASE}/workai_test_e2e?schema=public`;

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows as T[];
  } finally {
    await client.end();
  }
}

/** Expire every active web session row for a user email (session-expiration test). */
export async function expireSessionsFor(email: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE "UserSession" s SET "expiresAt" = now() - interval '1 minute'
     FROM "AppUser" u WHERE s."userId" = u.id AND u.email = $1 AND s."revokedAt" IS NULL
     RETURNING s.id`,
    [email]
  );
  return rows.length;
}

/** Look up an organization id by slug. */
export async function orgIdBySlug(slug: string): Promise<string> {
  const rows = await query<{ id: string }>(`SELECT id FROM "Organization" WHERE slug = $1`, [slug]);
  if (!rows.length) throw new Error(`org ${slug} not found — did you run tests/e2e/seed.ts?`);
  return rows[0].id;
}
