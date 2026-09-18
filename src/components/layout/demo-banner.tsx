'use client';

// OmniSight — Demo context banner (Phase 13).
//
// Non-intrusive one-line indicator shown inside the app shell when the
// hydrated session is bound to the demo organization (`isDemo` comes
// exclusively from the server via /api/auth/me → auth store — never from
// client input). Makes clear that all data is simulated: employees are
// fictional, screenshots are synthetic, no real monitoring occurs.
//
// Includes an explicit "Exit demo" action that hits the existing logout
// flow (revoke session + clear cookie), returning the visitor to the
// public landing page.

import { FlaskConical, X, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/lib/store';
import { useState } from 'react';

export function DemoBanner() {
  const isDemo = useAuthStore((s) => s.isDemo);
  const logout = useAuthStore((s) => s.logout);
  const [dismissed, setDismissed] = useState(false);

  if (!isDemo || dismissed) return null;

  const exitDemo = () => {
    // Fire-and-forget revoke; the store clears immediately so the AuthGuard
    // unmounts the app shell and shows the public landing page.
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    logout();
  };

  return (
    <div
      role='status'
      aria-label='Demo mode'
      className='flex items-center justify-center gap-2 border-b border-amber-400/20 bg-amber-400/10 px-4 py-1.5 text-xs text-amber-200'
    >
      <FlaskConical className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
      <span className='truncate'>
        <span className='font-semibold tracking-wide'>DEMO MODE</span>
        <span className='mx-1.5 hidden sm:inline text-amber-200/40'>·</span>
        <span className='hidden sm:inline'>
          You&apos;re exploring a simulated environment — employees are fictional, screenshots are
          synthetic, no real monitoring is occurring.
        </span>
        <span className='sm:hidden'>Simulated environment.</span>
      </span>
      <a
        href='/#demo'
        className='ml-2 hidden shrink-0 items-center gap-1 underline decoration-amber-300/40 underline-offset-2 hover:decoration-amber-200 md:inline-flex'
        onClick={() => setDismissed(true)}
      >
        <ExternalLink className='h-3 w-3' aria-hidden='true' />
        About
      </a>
      <Button
        variant='ghost'
        size='sm'
        className='h-6 shrink-0 px-2 text-xs text-amber-200 hover:bg-amber-400/15 hover:text-amber-100'
        onClick={exitDemo}
      >
        Exit demo
      </Button>
      <button
        type='button'
        aria-label='Dismiss demo banner'
        className='ml-1 shrink-0 rounded p-0.5 text-amber-200/60 hover:bg-amber-400/15 hover:text-amber-200'
        onClick={() => setDismissed(true)}
      >
        <X className='h-3.5 w-3.5' aria-hidden='true' />
      </button>
    </div>
  );
}
