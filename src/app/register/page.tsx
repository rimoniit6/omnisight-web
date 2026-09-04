'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/lib/store';
import { PublicHeader } from '@/components/layout/PublicHeader';
import { PublicFooter } from '@/components/layout/PublicFooter';
import { LoginPage } from '@/components/auth/login-page';
import { Button } from '@/components/ui/button';

export default function RegisterRoute() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hydrated = useAuthStore((s) => s._hydrated);

  useEffect(() => {
    if (hydrated && isAuthenticated) {
      router.replace('/');
    }
  }, [hydrated, isAuthenticated, router]);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <PublicHeader />
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-bold tracking-tight">
              Start your free trial
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              OmniSight accounts are provisioned by your organization&apos;s
              administrator. Sign in with your work credentials below to get
              started.
            </p>
          </div>
          <LoginPage />
          <div className="mt-4 text-center">
            <Button variant="link" asChild>
              <Link href="/login">Already a member? Log in</Link>
            </Button>
          </div>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
