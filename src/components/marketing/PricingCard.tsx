import Link from 'next/link';
import { Check } from 'lucide-react';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface PlanCard {
  name: string;
  price: string;
  period?: string;
  description: string;
  features: string[];
  cta: string;
  href: string;
  highlighted?: boolean;
}

interface PricingCardProps {
  plan: PlanCard;
}

export function PricingCard({ plan }: PricingCardProps) {
  return (
    <Card
      className={cn(
        'relative flex h-full flex-col border-border/60',
        plan.highlighted && 'border-primary shadow-lg'
      )}
    >
      {plan.highlighted && (
        <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground">
          Most Popular
        </Badge>
      )}
      <CardHeader className="pb-4">
        <h3 className="text-lg font-semibold text-foreground">{plan.name}</h3>
        <p className="text-sm text-muted-foreground">{plan.description}</p>
        <div className="mt-4 flex items-baseline gap-1">
          <span className="text-3xl font-bold text-foreground">{plan.price}</span>
          {plan.period && (
            <span className="text-sm text-muted-foreground">{plan.period}</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        <ul className="space-y-2.5 text-sm">
          {plan.features.map((feature) => (
            <li key={feature} className="flex items-start gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="text-muted-foreground">{feature}</span>
            </li>
          ))}
        </ul>
      </CardContent>
      <CardFooter>
        <Button className="w-full" variant={plan.highlighted ? 'default' : 'outline'} asChild>
          <Link href={plan.href}>{plan.cta}</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}
