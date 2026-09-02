'use client';

import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/store';

export interface EffectiveBranding {
  brandName: string;
  logoUrl: string;
  faviconUrl: string;
  primaryColor: string;
  browserTitle: string;
  tagline: string;
  isOrganizationOverride: boolean;
  logoType: string | null;
  logoSvg: string | null;
  logoWidth: number | null;
  logoHeight: number | null;
}

const DEFAULT_BRANDING: EffectiveBranding = {
  brandName: 'OmniSight',
  logoUrl: '/logos/omnisight.svg',
  faviconUrl: '/favicon.svg',
  primaryColor: '#059669',
  browserTitle: 'OmniSight - AI-Powered Workforce Intelligence',
  tagline: 'REMOTE INSIGHTS',
  isOrganizationOverride: false,
  logoType: null,
  logoSvg: null,
  logoWidth: null,
  logoHeight: null,
};

/**
 * Hook to fetch and cache effective branding for the current organization.
 *
 * - Fetches from /api/branding (server-resolved hierarchy)
 * - Keyed by organizationId so org switches auto-refetch
 * - Falls back to defaults if fetch fails
 * - Auto-refetches when organization changes (key includes orgId)
 */
export function useEffectiveBranding(): EffectiveBranding {
  const organization = useAuthStore((s) => s.organization);
  const orgId = organization?.id || null;

  const { data } = useQuery<EffectiveBranding>({
    queryKey: ['effective-branding', orgId],
    queryFn: async () => {
      try {
        const res = await fetch('/api/branding', { credentials: 'same-origin' });
        if (!res.ok) return DEFAULT_BRANDING;
        const json = await res.json();
        return json.data || DEFAULT_BRANDING;
      } catch {
        return DEFAULT_BRANDING;
      }
    },
    staleTime: 60_000, // 1 minute
    retry: 1,
  });

  return data || DEFAULT_BRANDING;
}
