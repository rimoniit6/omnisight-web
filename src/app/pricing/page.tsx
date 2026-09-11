'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface Plan {
  id: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number | null;
  currency: string;
  maxDevices: number;
  retentionDays: number;
  features: string[];
  isSelfHosted: boolean;
  // V1 additive pricing rows from /api/plans — the SAME PlanPricing source
  // used by the landing PricingSection and the checkout purchase flow.
  pricing?: Array<{
    deploymentMode: 'MANAGED' | 'CUSTOMER_DB';
    billingPeriod: 'MONTHLY' | 'YEARLY';
    basePrice: number;
    currency: string;
    includedDevices: number | null;
    additionalDevicePrice: number | null;
    unlimitedDevices: boolean;
  }>;
}

const FEATURE_LABELS: Record<string, string> = {
  screenshots: 'Screenshot monitoring',
  ai_insights: 'AI Insights',
  usb_monitoring: 'USB device monitoring',
  webcam: 'Webcam capture',
  audio: 'Audio transcription',
  realtime: 'Real-time activity',
  unlimited_retention: 'Unlimited retention',
};

function featureLabel(f: string): string {
  return FEATURE_LABELS[f] ?? f.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function PricingPage() {
  const router = useRouter();
  const [period, setPeriod] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');

  const { data, isLoading } = useQuery<{ plans: Plan[] }>({
    queryKey: ['plans'],
    queryFn: async () => {
      const res = await fetch('/api/plans');
      if (!res.ok) throw new Error('Failed to fetch plans');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const plans = data?.plans ?? [];
  const paid = plans.filter((p) => !p.isSelfHosted);

  const goToPlan = (plan: Plan) => {
    const isFree = plan.priceMonthly === 0 && !plan.isSelfHosted;
    // B-1 fix: paid plans enter the V1 public Purchase Request flow — the
    // same destination as the landing pricing section's CTA. Free keeps the
    // self-serve trial path into the app.
    if (isFree) {
      router.push('/login');
    } else {
      router.push(`/checkout?planId=${plan.id}`);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Simple top bar */}
      <header className="border-b bg-background/95 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-4 h-16 flex items-center justify-between">
          <Link href="/" className="font-semibold text-lg tracking-tight">
            <Sparkles className="w-5 h-5 inline mr-2 text-primary" />
            OmniSight
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/login" className="text-sm text-muted-foreground hover:text-foreground">
              Sign in
            </Link>
            <Button variant="outline" size="sm" asChild>
              <Link href="/dashboard/billing">My Billing</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-14">
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold tracking-tight">Simple, transparent pricing</h1>
          <p className="mt-3 text-muted-foreground max-w-xl mx-auto">
            Choose a plan that fits your team. All plans include core monitoring.
            Pick an annual plan and save.
          </p>

          <div className="mt-6 flex justify-center">
            <Tabs value={period} onValueChange={(v) => setPeriod(v as 'MONTHLY' | 'YEARLY')}>
              <TabsList>
                <TabsTrigger value="MONTHLY">Monthly</TabsTrigger>
                <TabsTrigger value="YEARLY">Yearly</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {isLoading ? (
          <div className="grid md:grid-cols-3 gap-6">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-80 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid md:grid-cols-3 gap-6">
            {paid.map((plan) => {
              // B-1 fix: display prices come from the V1 PlanPricing rows
              // (same source as landing + checkout). Legacy plan columns are
              // only a last-resort fallback when Super Admin has not configured
              // V1 pricing for the plan — identical to the landing
              // PricingSection behavior, so the two pages can never diverge
              // once pricing is configured.
              const managed = plan.pricing?.find((r) => r.deploymentMode === 'MANAGED' && r.billingPeriod === period);
              const customerDb = plan.pricing?.find((r) => r.deploymentMode === 'CUSTOMER_DB' && r.billingPeriod === period);
              const price = managed?.basePrice ?? customerDb?.basePrice ?? (period === 'YEARLY' && plan.priceYearly != null ? plan.priceYearly : plan.priceMonthly);
              const currency = managed?.currency ?? customerDb?.currency ?? plan.currency;
              const recommended = plan.name.toLowerCase().includes('business') || plan.name.toLowerCase().includes('pro');
              return (
                <Card key={plan.id} className={recommended ? 'border-primary shadow-lg' : ''}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-lg">{plan.name}</CardTitle>
                      {recommended && (
                        <Badge className="bg-primary text-primary-foreground">Popular</Badge>
                      )}
                    </div>
                    <CardDescription>{plan.description}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="mb-4">
                      <span className="text-3xl font-bold">
                        {currency} {price.toLocaleString()}
                      </span>
                      <span className="text-muted-foreground text-sm">
                        {period === 'YEARLY' ? '/ year' : '/ month'}
                      </span>
                    </div>
                    <ul className="space-y-2 text-sm">
                      <li className="flex items-center gap-2">
                        <Check className="w-4 h-4 text-primary" />
                        {managed
                          ? managed.includedDevices != null
                            ? `${managed.includedDevices} devices included${managed.additionalDevicePrice ? ` · +${currency} ${managed.additionalDevicePrice}/additional device` : ''}`
                            : 'Unlimited devices'
                          : customerDb
                            ? 'Unlimited devices'
                            : `${plan.maxDevices <= 0 ? 'Unlimited' : plan.maxDevices} devices`}
                      </li>
                      <li className="flex items-center gap-2">
                        <Check className="w-4 h-4 text-primary" />
                        {plan.retentionDays <= 0 ? 'Unlimited' : `${plan.retentionDays}-day`} retention
                      </li>
                      {customerDb && (
                        <li className="flex items-center gap-2">
                          <Check className="w-4 h-4 text-primary" />
                          Customer Database: {customerDb.currency} {customerDb.basePrice.toLocaleString()}/{period === 'YEARLY' ? 'yr' : 'mo'} · unlimited devices
                        </li>
                      )}
                      {plan.features.map((f) => (
                        <li key={f} className="flex items-center gap-2">
                          <Check className="w-4 h-4 text-primary" />
                          {featureLabel(f)}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                  <CardFooter>
                    <Button className="w-full" onClick={() => goToPlan(plan)}>
                      {plan.priceMonthly === 0 && !plan.isSelfHosted ? 'Start Free Trial' : 'Request Pricing'}
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
