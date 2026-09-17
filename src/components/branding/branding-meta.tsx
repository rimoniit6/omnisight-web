'use client';

import { useEffect } from 'react';
import { useEffectiveBranding } from '@/hooks/use-effective-branding';

/**
 * Client-side branding meta updater.
 * Sets document.title and favicon from the effective branding configuration.
 * Runs after the branding hook resolves — safe for both authenticated and
 * unauthenticated surfaces (hook falls back to defaults without auth).
 */
export function BrandingMeta() {
  const branding = useEffectiveBranding();

  useEffect(() => {
    if (branding.browserTitle) {
      document.title = branding.browserTitle;
    }
  }, [branding.browserTitle]);

  useEffect(() => {
    if (!branding.faviconUrl) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) {
      link.href = branding.faviconUrl;
    }
  }, [branding.faviconUrl]);

  return null;
}
