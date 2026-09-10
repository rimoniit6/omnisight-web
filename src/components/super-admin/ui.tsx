'use client';

import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// Shared building blocks for the Super Admin Control Center. Dense and
// operational — no decorative marketing effects. All data comes from APIs.
// Theme-aware (light + dark) to match the rest of the application shell.

export function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return (
    <div className="mb-6">
      <p className="tech-font text-[10px] font-bold uppercase tracking-[0.26em] text-cyan-600 dark:text-cyan-300/80">{eyebrow}</p>
      <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      {description && <p className="mt-1.5 max-w-2xl text-[13px] text-muted-foreground">{description}</p>}
    </div>
  );
}

export function Panel({ title, children, className, right }: { title?: string; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={cn('rounded-2xl border border-border bg-card p-5', className)}>
      {title && (
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="tech-font text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{title}</h2>
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function KpiCard({ label, value, sub, tone = 'default' }: { label: string; value: ReactNode; sub?: string; tone?: 'default' | 'warn' | 'ok' | 'danger' }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="tech-font text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-2 text-3xl font-semibold tracking-tight',
          tone === 'warn' && 'text-amber-600 dark:text-amber-300',
          tone === 'ok' && 'text-emerald-600 dark:text-emerald-300',
          tone === 'danger' && 'text-red-600 dark:text-red-300',
          tone === 'default' && 'text-foreground'
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-1 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function StatusPill({ label, tone }: { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }) {
  const tones: Record<string, string> = {
    ok: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-300',
    warn: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300',
    danger: 'border-red-300 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-300',
    info: 'border-cyan-300 bg-cyan-50 text-cyan-700 dark:border-cyan-400/30 dark:bg-cyan-400/10 dark:text-cyan-300',
    neutral: 'border-border bg-muted/50 text-muted-foreground dark:border-white/15 dark:bg-white/5 dark:text-white/60',
  };
  return (
    <span className={cn('tech-font inline-block rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em]', tones[tone])}>
      {label}
    </span>
  );
}

export function ModePill({ mode }: { mode: string | null }) {
  if (mode === 'MANAGED') return <StatusPill label="MANAGED" tone="ok" />;
  if (mode === 'CUSTOMER_DB') return <StatusPill label="CUSTOMER_DB" tone="info" />;
  if (mode === 'PRIVATE') return <StatusPill label="PRIVATE" tone="warn" />;
  return <StatusPill label="UNRESOLVED" tone="danger" />;
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <p className="text-[14px] font-medium text-foreground/80">{title}</p>
      {body && <p className="mt-1.5 max-w-sm text-[12px] text-muted-foreground">{body}</p>}
    </div>
  );
}

export function ErrorState({ title = 'Unable to load data', onRetry }: { title?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-red-300 bg-red-50/60 px-6 py-10 text-center dark:border-red-400/20 dark:bg-red-500/5">
      <AlertTriangle size={18} className="text-red-600 dark:text-red-300" aria-hidden />
      <p className="mt-2 text-[13px] text-foreground/80">{title}</p>
      <p className="mt-1 text-[11.5px] text-muted-foreground">Check your connection and try again.</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="tech-font mt-4 rounded-full border border-border px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-foreground/80 transition-colors hover:bg-muted"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function SkeletonRows({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-2" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="h-9 flex-1 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-[12px] text-muted-foreground">
      <Loader2 size={14} className="animate-spin" aria-hidden />
      {label}
    </div>
  );
}

/** Simple table shell with sticky header styling; scrolls horizontally on small screens. */
export function DataTable({ headers, children, empty, loading }: { headers: string[]; children: ReactNode; empty?: ReactNode; loading?: boolean }) {
  if (loading) return <SkeletonRows rows={5} cols={headers.length} />;
  if (!children || (Array.isArray(children) && children.length === 0)) {
    return <>{empty ?? <EmptyState title="Nothing to show yet." />}</>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[640px] border-collapse text-left text-[12.5px]">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            {headers.map((h) => (
              <th key={h} className="tech-font px-3.5 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">{children}</tbody>
      </table>
    </div>
  );
}

export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
    >
      {children}
    </motion.div>
  );
}

export function Pagination({ page, pages, total, onPage, pageSize = 25 }: { page: number; pages: number; total: number; onPage: (p: number) => void; pageSize?: number }) {
  if (total === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-[12px] text-muted-foreground">
      <span>
        Showing {total === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="tech-font rounded-full border border-border px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-foreground/70 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Prev
        </button>
        <span className="tech-font">
          {page} / {Math.max(1, pages)}
        </span>
        <button
          onClick={() => onPage(Math.min(pages, page + 1))}
          disabled={page >= pages}
          className="tech-font rounded-full border border-border px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-foreground/70 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
