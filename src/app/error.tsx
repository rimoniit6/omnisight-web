'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw, ArrowLeft } from 'lucide-react';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Report the error for observability without leaking details to the UI.
    console.error('[app:error]', error);
  }, [error]);

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <div className="max-w-md w-full text-center">
        <div className="h-14 w-14 rounded-full bg-destructive/10 flex items-center justify-center mx-auto mb-5">
          <AlertTriangle className="h-7 w-7 text-destructive" />
        </div>
        <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
        <p className="text-sm text-muted-foreground mb-6">
          The application hit an unexpected error. You can retry, or reload the page to continue.
          {error.digest && (
            <span className="block mt-2 font-mono text-xs text-muted-foreground/70">Error ID: {error.digest}</span>
          )}
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to home
          </a>
        </div>
      </div>
    </div>
  );
}
