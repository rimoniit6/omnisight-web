import Image from 'next/image';
import { Loader2 } from 'lucide-react';
import { getPlatformBranding } from '@/lib/branding';

export default async function RootLoading() {
  const branding = await getPlatformBranding();
  const logoUrl = branding.logoUrl || '/logos/omnisight.svg';
  const brandName = branding.brandName || 'OmniSight';

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        {branding.logoType === 'svg' && branding.logoSvg ? (
          <div
            style={{ width: 96, height: 96 }}
            dangerouslySetInnerHTML={{ __html: branding.logoSvg }}
            className="flex items-center justify-center"
          />
        ) : (
          <Image
            src={logoUrl}
            alt={brandName}
            width={96}
            height={96}
            className="object-contain"
            unoptimized
          />
        )}
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading {brandName}…
        </p>
      </div>
    </div>
  );
}
