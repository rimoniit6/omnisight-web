import Image from 'next/image';
import { Loader2 } from 'lucide-react';

export default function RootLoading() {
  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Image
          src="/logos/omnisight.svg"
          alt="OmniSight"
          width={96}
          height={96}
          className="object-contain"
          unoptimized
        />
        <p className="text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading OmniSight…
        </p>
      </div>
    </div>
  );
}
