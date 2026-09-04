'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import { PublicHeader } from '@/components/layout/PublicHeader';
import { PublicFooter } from '@/components/layout/PublicFooter';
import { LoginPage } from '@/components/auth/login-page';

export default function LoginRoute() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hydrated = useAuthStore((s) => s._hydrated);

  // The standalone LoginPage calls store.login() on success; once the session
  // is set, send the user into the application (root shows the dashboard).
  useEffect(() => {
    if (hydrated && isAuthenticated) {
      router.replace('/');
    }
  }, [hydrated, isAuthenticated, router]);

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <PublicHeader />
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <LoginPage />
      </main>
      <PublicFooter />
    </div>
  );
}
