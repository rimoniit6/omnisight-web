'use client';

import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/store';

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: string;
  roleLabel: string;
  initials: string;
  avatar: string | null;
  lastLogin: string | null;
}

export interface CurrentOrg {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  logo: string | null;
  status: string;
  timezone: string;
  currency: string;
}

interface AuthMeResponse {
  user: CurrentUser;
  organization: CurrentOrg | null;
}

// Shared hook — all components use this to get the logged-in user & org data.
// Uses cookie-based auth (credentials: 'same-origin') instead of the in-memory
// JWT token. The httpOnly session cookie is the durable credential — the
// in-memory token can become stale after an organization switch (the server
// rotates the cookie but the client token is not updated until hydrate runs).
export function useCurrentUser() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const { data, isLoading, error } = useQuery<AuthMeResponse>({
    queryKey: ['auth-me'],
    queryFn: async () => {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to fetch user');
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // 5 min
    retry: 1,
    enabled: isAuthenticated,
  });

  return {
    user: data?.user ?? null,
    org: data?.organization ?? null,
    isLoading,
    error,
  };
}
