import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    // Supabase production (verified 2026-08-18): runtime traffic goes through
    // the PgBouncer transaction pooler with connection_limit=1. Remote pooler
    // round-trips are ~1–2 s cold, so Prisma's default 5 s interactive
    // transaction timeout is too tight for multi-step transactions (login
    // audit+session, consent transitions, retention purges) and produced real
    // `Transaction already closed` failures. A bounded, generous timeout keeps
    // these reliable without allowing unbounded hangs.
    transactionOptions: { maxWait: 20000, timeout: 30000 },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db