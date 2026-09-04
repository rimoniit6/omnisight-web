import type { LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';

export interface FeatureItem {
  icon: LucideIcon;
  title: string;
  description: string;
}

interface FeatureCardProps {
  feature: FeatureItem;
}

export function FeatureCard({ feature }: FeatureCardProps) {
  const Icon = feature.icon;
  return (
    <Card className="h-full border-border/60 transition-colors hover:border-primary/50">
      <CardContent className="flex h-full flex-col gap-4 p-6">
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h3 className="text-base font-semibold text-foreground">{feature.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {feature.description}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
