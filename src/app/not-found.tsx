import Link from 'next/link';
import { Compass } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-4">
      <div className="max-w-md w-full text-center">
        <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mx-auto mb-5">
          <Compass className="h-7 w-7 text-muted-foreground" />
        </div>
        <p className="text-5xl font-bold text-muted-foreground/30 mb-2">404</p>
        <h1 className="text-xl font-semibold mb-2">Page not found</h1>
        <p className="text-sm text-muted-foreground mb-6">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
