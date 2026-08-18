'use client';

import { usePresence } from '@/components/providers/presence-provider';
import { cn } from '@/lib/utils';

// Live presence indicator for an employee.
//
//   green (pulsing)  — server evidence of a current authenticated agent
//   grey (muted)     — server-confirmed offline (heartbeat stale/absent)
//   faint outline    — unknown (snapshot still loading or failed) — never green
//
// Presence means "the Desktop Agent is currently connected", nothing more —
// never productivity, activity, or break state.

interface PresenceDotProps {
  employeeId: string;
  className?: string;
  /** Override the default tooltip text. */
  title?: string;
}

export function PresenceDot({ employeeId, className, title }: PresenceDotProps) {
  const { online } = usePresence(employeeId);

  const tooltip =
    title ??
    (online === true
      ? 'Online — Desktop Agent connected'
      : online === false
        ? 'Offline — no agent heartbeat'
        : 'Presence unavailable');

  return (
    <span
      className={cn('relative inline-flex h-2 w-2 shrink-0', className)}
      title={tooltip}
      aria-label={tooltip}
      data-presence-online={online === true ? 'true' : online === false ? 'false' : 'unknown'}
    >
      {online === true && (
        <>
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </>
      )}
      {online === false && (
        <span className="relative inline-flex h-2 w-2 rounded-full bg-muted-foreground/40" />
      )}
      {online === null && (
        <span className="relative inline-flex h-2 w-2 rounded-full bg-muted" />
      )}
    </span>
  );
}
