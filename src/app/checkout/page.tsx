'use client';

import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { ArrowLeft, CreditCard, Loader2, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// ─── V1 Purchase Request flow (public) ─────────────────────────────────────
// Repurposed /checkout: Plan → Deployment Mode → Monthly/Yearly →
// (Managed) Device Quantity → server-calculated price → Submit Purchase
// Request. NO login required. The displayed price is a PREVIEW from
// /api/pricing/preview (same server resolver as everything else); the
// authoritative snapshot is recalculated server-side on submission — a
// manipulated client price can never become a commercial record.

interface Plan {
  id: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number | null;
  currency: string;
  maxDevices: number;
  features: string[];
  isSelfHosted: boolean;
}

interface Breakdown {
  basePrice: number;
  deviceCharge: number;
  discountAmount: number;
  finalPrice: number;
  currency: string;
  offerName: string | null;
  unlimitedDevices: boolean;
  includedDevices: number | null;
  additionalDevicePrice: number | null;
  pricingSource: string;
}

type Mode = 'MANAGED' | 'CUSTOMER_DB';
type Period = 'MONTHLY' | 'YEARLY';

function PurchaseRequestInner() {
  const searchParams = useSearchParams();
  const planIdParam = searchParams.get('planId') ?? '';

  const [planId, setPlanId] = useState(planIdParam);
  const [mode, setMode] = useState<Mode>('MANAGED');
  const [period, setPeriod] = useState<Period>('MONTHLY');
  const [deviceQuantity, setDeviceQuantity] = useState('25');
  const [companyName, setCompanyName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<{ requestNumber: string; finalPrice: number; currency: string } | null>(null);

  const { data, isLoading } = useQuery<{ plans: Plan[] }>({
    queryKey: ['plans'],
    queryFn: async () => {
      const res = await fetch('/api/plans');
      if (!res.ok) throw new Error('Failed to fetch plans');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  // Only V1 customer-facing plans (self-hosted legacy plans are never shown).
  const plans = (data?.plans ?? []).filter((p) => !p.isSelfHosted);
  const plan = plans.find((p) => p.id === planId);

  // Preselect the first plan when the URL param is absent/unknown.
  useEffect(() => {
    if (!plan && plans.length > 0) setPlanId(plans[0].id);
  }, [plan, plans]);

  const previewQ = useQuery<{ breakdown: Breakdown }>({
    queryKey: ['purchase-preview', planId, mode, period, mode === 'MANAGED' ? deviceQuantity : 'x'],
    enabled: Boolean(plan),
    queryFn: async () => {
      const res = await fetch('/api/pricing/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId,
          deploymentMode: mode,
          billingPeriod: period,
          deviceQuantity: mode === 'MANAGED' ? Math.max(1, Math.floor(Number(deviceQuantity) || 1)) : undefined,
        }),
      });
      if (!res.ok) throw new Error('preview');
      return res.json();
    },
  });

  const breakdown = previewQ.data?.breakdown;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!plan) return;
    if (mode === 'MANAGED' && (!Number(deviceQuantity) || Number(deviceQuantity) < 1)) {
      toast.error('Enter a device quantity of 1 or more for Managed deployments');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/purchase-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName,
          contactName,
          contactEmail,
          contactPhone: contactPhone || undefined,
          notes: notes || undefined,
          planId,
          deploymentMode: mode,
          billingPeriod: period,
          deviceQuantity: mode === 'MANAGED' ? Math.max(1, Math.floor(Number(deviceQuantity) || 1)) : undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to submit purchase request');
        return;
      }
      setSubmitted({ requestNumber: json.requestNumber, finalPrice: json.price.final, currency: json.price.currency });
      toast.success(`Purchase request ${json.requestNumber} submitted`);
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-muted/30 grid place-items-center px-4">
        <Card className="max-w-lg w-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-primary" />
              Purchase request submitted
            </CardTitle>
            <CardDescription>
              Your request <strong>{submitted.requestNumber}</strong> has been received. The OmniSight team will
              contact you to arrange payment — your subscription is activated once payment is verified.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Final price (server-calculated)</span>
              <span className="font-semibold">{submitted.currency} {submitted.finalPrice.toLocaleString()}</span>
            </div>
            <p className="text-muted-foreground">
              Keep your request number for reference. No payment is collected on this page.
            </p>
          </CardContent>
          <CardFooter>
            <Button asChild className="w-full">
              <Link href="/">Back to home</Link>
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b bg-background sticky top-0 z-10">
        <div className="mx-auto max-w-3xl px-4 h-16 flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/pricing">
              <ArrowLeft className="w-4 h-4 mr-1" /> Plans
            </Link>
          </Button>
          <span className="font-semibold">Purchase Request</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-bold mb-1">Request your subscription</h1>
        <p className="text-sm text-muted-foreground mb-6">
          No account needed — configure your plan and the OmniSight team handles provisioning after payment verification.
        </p>

        {isLoading ? (
          <Skeleton className="h-96 w-full rounded-xl" />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Plan */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <CreditCard className="w-5 h-5 text-primary" />
                  1. Plan
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-3">
                {plans.map((p) => (
                  <label
                    key={p.id}
                    className={`cursor-pointer rounded-xl border p-4 transition-colors ${
                      planId === p.id ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:bg-muted/40'
                    }`}
                  >
                    <input type="radio" name="plan" className="sr-only" checked={planId === p.id} onChange={() => setPlanId(p.id)} />
                    <p className="font-semibold">{p.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{p.description}</p>
                  </label>
                ))}
              </CardContent>
            </Card>

            {/* Deployment mode */}
            <Card>
              <CardHeader>
                <CardTitle>2. Deployment Mode</CardTitle>
                <CardDescription>OmniSight Managed hosts everything; Customer Database keeps your data in your database.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3 sm:grid-cols-2">
                <label className={`cursor-pointer rounded-xl border p-4 transition-colors ${mode === 'MANAGED' ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:bg-muted/40'}`}>
                  <input type="radio" name="mode" className="sr-only" checked={mode === 'MANAGED'} onChange={() => setMode('MANAGED')} />
                  <p className="font-semibold">OmniSight Managed</p>
                  <p className="mt-1 text-xs text-muted-foreground">Fully managed — priced by period + device quantity.</p>
                </label>
                <label className={`cursor-pointer rounded-xl border p-4 transition-colors ${mode === 'CUSTOMER_DB' ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'hover:bg-muted/40'}`}>
                  <input type="radio" name="mode" className="sr-only" checked={mode === 'CUSTOMER_DB'} onChange={() => setMode('CUSTOMER_DB')} />
                  <p className="font-semibold">Customer Database</p>
                  <p className="mt-1 text-xs text-muted-foreground">Your primary database — unlimited devices, priced by period only.</p>
                </label>
              </CardContent>
            </Card>

            {/* Period + devices */}
            <Card>
              <CardHeader>
                <CardTitle>3. Billing Period{mode === 'MANAGED' ? ' & Devices' : ''}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Tabs value={period} onValueChange={(v) => setPeriod(v as Period)}>
                  <TabsList>
                    <TabsTrigger value="MONTHLY">Monthly</TabsTrigger>
                    <TabsTrigger value="YEARLY">Yearly</TabsTrigger>
                  </TabsList>
                </Tabs>
                {mode === 'MANAGED' ? (
                  <div className="space-y-2 max-w-xs">
                    <Label htmlFor="devices">Device quantity</Label>
                    <Input
                      id="devices"
                      type="number"
                      min={1}
                      step={1}
                      value={deviceQuantity}
                      onChange={(e) => setDeviceQuantity(e.target.value)}
                    />
                    {breakdown && (
                      <p className="text-xs text-muted-foreground">
                        {breakdown.includedDevices} devices included · +{breakdown.currency} {breakdown.additionalDevicePrice} per additional device
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
                    Customer Database deployments include <strong>unlimited devices</strong> — device count never affects the price.
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Price summary */}
            <Card>
              <CardHeader>
                <CardTitle>4. Price</CardTitle>
                <CardDescription>Calculated by the OmniSight pricing engine — final confirmation happens server-side.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {previewQ.isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : breakdown ? (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Base ({period === 'YEARLY' ? 'yearly' : 'monthly'})</span>
                      <span>{breakdown.currency} {breakdown.basePrice.toLocaleString()}</span>
                    </div>
                    {breakdown.deviceCharge > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Additional devices</span>
                        <span>{breakdown.currency} {breakdown.deviceCharge.toLocaleString()}</span>
                      </div>
                    )}
                    {breakdown.discountAmount > 0 && (
                      <div className="flex justify-between text-emerald-600">
                        <span>Offer{breakdown.offerName ? `: ${breakdown.offerName}` : ''}</span>
                        <span>−{breakdown.currency} {breakdown.discountAmount.toLocaleString()}</span>
                      </div>
                    )}
                    <div className="border-t pt-2 flex justify-between font-semibold">
                      <span>Total</span>
                      <span>{breakdown.currency} {breakdown.finalPrice.toLocaleString()}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {breakdown.unlimitedDevices ? 'Unlimited devices included.' : `${breakdown.includedDevices} devices included in base price.`}
                    </p>
                  </>
                ) : (
                  <p className="text-muted-foreground">Select a plan to see the price.</p>
                )}
              </CardContent>
            </Card>

            {/* Contact info */}
            <Card>
              <CardHeader>
                <CardTitle>5. Contact Information</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Company name *</Label>
                  <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} required minLength={2} maxLength={200} placeholder="Acme Inc." />
                </div>
                <div className="space-y-2">
                  <Label>Contact name *</Label>
                  <Input value={contactName} onChange={(e) => setContactName(e.target.value)} required maxLength={200} placeholder="Jane Doe" />
                </div>
                <div className="space-y-2">
                  <Label>Email *</Label>
                  <Input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} required maxLength={320} placeholder="admin@company.com" />
                </div>
                <div className="space-y-2">
                  <Label>Phone (optional)</Label>
                  <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} maxLength={40} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Notes (optional)</Label>
                  <textarea
                    rows={2}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    maxLength={2000}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
                    placeholder="Anything the team should know"
                  />
                </div>
              </CardContent>
            </Card>

            <Button type="submit" className="w-full" disabled={submitting || !plan}>
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting…
                </>
              ) : (
                'Submit Purchase Request'
              )}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Submitting a request does not charge anything. Flow: Review → Manual payment → Activation by OmniSight.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense>
      <PurchaseRequestInner />
    </Suspense>
  );
}
