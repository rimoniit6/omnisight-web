'use client';

import { useEffect } from 'react';

/**
 * Root error boundary — catches failures in the root layout itself
 * (something src/app/error.tsx cannot). Must render <html>/<body> because
 * the root layout has already failed. Uses only inline styles so it renders
 * even when the global stylesheet failed to load with the layout. Never
 * exposes stack traces or environment details to the user.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Observability only — the digest correlates with server logs.
    console.error('[app:global-error]', error);
  }, [error]);

  const styles: Record<string, React.CSSProperties> = {
    body: {
      margin: 0,
      fontFamily:
        'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      color: '#18181b',
      background: '#fafafa',
    },
    center: {
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1rem',
      boxSizing: 'border-box',
    },
    card: { maxWidth: '26rem', width: '100%', textAlign: 'center' },
    icon: {
      width: '3.5rem',
      height: '3.5rem',
      margin: '0 auto 1.25rem',
      borderRadius: '9999px',
      background: '#fef2f2',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '2rem',
      lineHeight: 1,
    },
    title: { fontSize: '1.25rem', fontWeight: 600, margin: '0 0 0.5rem' },
    message: {
      fontSize: '0.875rem',
      color: '#52525b',
      margin: '0 0 1.5rem',
    },
    digest: {
      display: 'block',
      marginTop: '0.5rem',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '0.75rem',
      color: '#71717a',
    },
    button: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '0.5rem',
      borderRadius: '0.5rem',
      padding: '0.5rem 1rem',
      fontSize: '0.875rem',
      fontWeight: 500,
      color: '#ffffff',
      background: '#10b981',
      border: 'none',
      cursor: 'pointer',
    },
  };

  return (
    <html lang="en" suppressHydrationWarning>
      <body style={styles.body}>
        <div style={styles.center}>
          <div style={styles.card}>
            <div style={styles.icon}>⚠</div>
            <h1 style={styles.title}>The application could not load</h1>
            <p style={styles.message}>
              A critical error prevented the interface from starting. Reload
              the page to try again.
              {error.digest && (
                <span style={styles.digest}>Error ID: {error.digest}</span>
              )}
            </p>
            <button
              onClick={() => reset()}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = '#059669')
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = '#10b981')
              }
              style={styles.button}
            >
              ↻ Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
