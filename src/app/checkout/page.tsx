'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ArrowLeft, CreditCard, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/hooks/use-current-user';

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
}


function CheckoutInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const planId = searchParams.get('planId') ?? '';
  const period = searchParams.get('period') === 'YEARLY' ? 'YEARLY' : 'MONTHLY';

  const { user, org, isLoading: authLoading } = useCurrentUser();
  const [submitting, setSubmitting] = useState(false);

  const { data, isLoading: planLoading } = useQuery<{ plans: Plan[] }>({
    queryKey: ['plans'],
    queryFn: async () => {
      const res = await fetch('/api/plans');
      if (!res.ok) throw new Error('Failed to fetch plans');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const plan = data?.plans.find((p) => p.id === planId);

  const handleSubscribe = async () => {
    if (!org) {
      router.push('/login');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/organizations/${org.id}/subscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ planId, billingPeriod: period }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json.error ?? 'Failed to start subscription';
        toast.error(msg);
        return;
      }
      toast.success(`Invoice ${json.invoiceNumber ?? ''} created — OmniSight will contact you to arrange payment.`);
      router.push(`/invoices/${json.invoiceId}`);
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (authLoading || planLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Skeleton className="h-96 w-full max-w-3xl rounded-xl" />
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <div className="text-center">
          <p className="text-muted-foreground mb-4">Plan not found.</p>
          <Button asChild>
            <Link href="/pricing">Browse plans</Link>
          </Button>
        </div>
      </div>
    );
  }

  const price = period === 'YEARLY' && plan.priceYearly != null ? plan.priceYearly : plan.priceMonthly;
  const orderLabel = `${plan.name} — ${period === 'YEARLY' ? 'Yearly' : 'Monthly'}`;

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-background sticky top-0 z-10">
        <div className="mx-auto max-w-3xl px-4 h-16 flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/pricing">
              <ArrowLeft className="w-4 h-4 mr-1" /> Plans
            </Link>
          </Button>
          <span className="font-semibold">Checkout</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-bold mb-6">Confirm your subscription</h1>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-primary" />
              {orderLabel}
            </CardTitle>
            <CardDescription>
              {plan.description} · {plan.maxDevices <= 0 ? 'Unlimited' : plan.maxDevices} devices
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal ({period === 'YEARLY' ? 'yearly' : 'monthly'})</span>
              <span className="font-semibold">
                {plan.currency} {price}
              </span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Billing period</span>
              <span>{period === 'YEARLY' ? '12 months' : '1 month'}</span>
            </div>
            <div className="border-t pt-3 flex justify-between font-semibold">
              <span>Total</span>
              <span>
                {plan.currency} {price}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Payment — Manual</CardTitle>
            <CardDescription>
              OmniSight subscriptions are billed manually — there is no online checkout and no card is required here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground space-y-2">
              <p>
                After confirming, an invoice is created and the OmniSight team contacts you with payment
                instructions. Your subscription is activated once payment is confirmed.
              </p>
            </div>
          </CardContent>
          <CardFooter>
            <Button className="w-full" onClick={handleSubscribe} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating order...
                </>
              ) : user ? (
                'Confirm & Create Invoice'
              ) : (
                'Sign in to continue'
              )}
            </Button>
          </CardFooter>
        </Card>
      </main>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense>
      <CheckoutInner />
    </Suspense>
  );
}
