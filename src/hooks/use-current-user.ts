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

// Shared hook — all components use this to get the logged-in user & org data
export function useCurrentUser() {
  const token = useAuthStore((s) => s.token);

  const { data, isLoading, error } = useQuery<AuthMeResponse>({
    queryKey: ['auth-me'],
    queryFn: async () => {
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      const res = await fetch('/api/auth/me', { headers });
      if (!res.ok) throw new Error('Failed to fetch user');
      return res.json();
    },
    staleTime: 5 * 60 * 1000, // 5 min
    retry: 1,
    enabled: !!token,
  });

  return {
    user: data?.user ?? null,
    org: data?.organization ?? null,
    isLoading,
    error,
  };
}
