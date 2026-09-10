'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import { LoginPage } from '@/components/auth/login-page';

export default function LoginRoute() {
  const router = useRouter();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hydrated = useAuthStore((s) => s._hydrated);

  // The standalone LoginPage calls store.login() on success; once the session
  // is set, send the user into the application (root shows the dashboard).
  // The backend remains the source of truth for authentication, RBAC routing,
  // first-login password change and organization selection — unchanged.
  useEffect(() => {
    if (hydrated && isAuthenticated) {
      router.replace('/');
    }
  }, [hydrated, isAuthenticated, router]);

  return <LoginPage />;
}