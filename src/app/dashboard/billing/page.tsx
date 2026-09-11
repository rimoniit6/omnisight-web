'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import Link from 'next/link';
import {
  CreditCard,
  CalendarClock,
  Monitor,
  ShieldAlert,
  Loader2,
  ArrowRight,
  AlertTriangle,
  CheckCircle,
  XCircle,
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCurrentUser } from '@/hooks/use-current-user';
import { SuspensionScreen } from '@/components/suspension-screen';

interface PlanInfo {
  id: string;
  name: string;
  currency: string;
  priceMonthly: number;
  priceYearly: number | null;
  maxDevices: number;
  retentionDays: number;
  features: string[];
}

interface SubscriptionInfo {
  id: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  trialEndDate: string | null;
  trialEndsAt: string | null;
  billingPeriod: string | null;
  deviceQuantity: number | null;
  plan: PlanInfo;
}

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
  status: string;
  dueDate: string | null;
  paidAt: string | null;
  paymentMethod: string | null;
  transactionId: string | null;
}

interface LatestInvoice {
  id: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
  status: string;
  paidAt: string | null;
  paymentMethod: string | null;
  dueDate: string | null;
}

interface PlanPricing {
  includedDevices: number;
  additionalDevicePrice: number;
  basePrice: number;
  currency: string;
}

interface DeviceEntitlement {
  includedDevices: number;
  activeDeviceCount: number;
  extraDevices: number;
  extraDevicePrice: number;
  overageAmount: number;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    ACTIVE: 'bg-emerald-500/15 text-emerald-600',
    PENDING: 'bg-amber-500/15 text-amber-600',
    PAID: 'bg-emerald-500/15 text-emerald-600',
    OVERDUE: 'bg-rose-500/15 text-rose-600',
    CANCELLED: 'bg-muted text-muted-foreground',
    EXPIRED: 'bg-muted text-muted-foreground',
  };
  return map[status] ?? 'bg-muted text-muted-foreground';
}

export default function BillingPage() {
  const router = useRouter();
  const { user, org, isLoading: authLoading } = useCurrentUser();

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login');
    }
  }, [authLoading, user, router]);

  const orgId = org?.id ?? '';

  const subQuery = useQuery<{
    subscription: SubscriptionInfo | null;
    isOnTrial: boolean;
    trialEndsAt: string | null;
    trialRemainingDays: number;
    activeDeviceCount: number;
    daysRemaining: number | null;
    latestInvoice: LatestInvoice | null;
    outstandingAmount: number;
    outstandingCurrency: string;
    planPricing: PlanPricing | null;
    deviceEntitlement: DeviceEntitlement;
  }>({
    queryKey: ['subscription', orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/subscription`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to fetch subscription');
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 60 * 1000,
  });

  const invQuery = useQuery<{ invoices: InvoiceRow[] }>({
    queryKey: ['invoices', orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/invoices`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to fetch invoices');
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 60 * 1000,
  });

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background p-8">
        <Skeleton className="h-10 w-64 mb-6" />
        <Skeleton className="h-40 w-full mb-6 rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!user) return null;

  // Server-side enforcement blocks suspended orgs at the API level (requireActiveSessionOrg).
  // This client-side check provides the user-facing suspension screen.
  if (org && org.status !== 'active') {
    return <SuspensionScreen />;
  }

  const sub = subQuery.data;
  const plan = sub?.subscription?.plan ?? null;
  const invoices = invQuery.data?.invoices ?? [];

  const isOnTrial = !!sub?.isOnTrial;
  const subscriptionStatus = sub?.subscription?.status ?? null;
  const needsSubscription = !subscriptionStatus && subQuery.isSuccess;

  const daysRemaining = sub?.daysRemaining;
  const isExpiringSoon = daysRemaining !== null && daysRemaining !== undefined && daysRemaining <= 7 && daysRemaining > 0;
  const isExpired = daysRemaining !== null && daysRemaining !== undefined && daysRemaining === 0 && subscriptionStatus === 'EXPIRED';

  const deviceEntitlement = sub?.deviceEntitlement;
  const isOverLimit = (deviceEntitlement?.extraDevices ?? 0) > 0;

  const latestInvoice = sub?.latestInvoice;
  const outstandingAmount = sub?.outstandingAmount ?? 0;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-10 bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-5xl px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <CreditCard className="w-5 h-5 text-primary" />
            Billing &amp; Subscription
          </div>
          <Button variant="outline" size="sm" onClick={() => router.push('/')}>
            Back to app
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 space-y-6">
        {/* Trial banner */}
        {isOnTrial && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-amber-800">
            <CalendarClock className="w-5 h-5 shrink-0" />
            <div className="text-sm">
              <p className="font-semibold">Trial active</p>
              <p>
                {sub?.trialRemainingDays ?? 0} day{sub?.trialRemainingDays === 1 ? '' : 's'} remaining. Choose a plan
                to keep your workspace running.
              </p>
            </div>
            <Button size="sm" className="ml-auto shrink-0" asChild>
              <Link href="/pricing">
                Select a plan <ArrowRight className="w-4 h-4 ml-1" />
              </Link>
            </Button>
          </div>
        )}

        {needsSubscription && !isOnTrial && (
          <div className="flex items-center gap-3 rounded-lg border border-rose-300/60 bg-rose-50 p-4 text-rose-800">
            <ShieldAlert className="w-5 h-5 shrink-0" />
            <div className="text-sm">
              <p className="font-semibold">No active subscription</p>
              <p>Your workspace needs a paid plan to stay active.</p>
            </div>
            <Button size="sm" className="ml-auto shrink-0" variant="destructive" asChild>
              <Link href="/pricing">
                Subscribe now <ArrowRight className="w-4 h-4 ml-1" />
              </Link>
            </Button>
          </div>
        )}

        {/* 7-day expiry warning */}
        {isExpiringSoon && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-amber-800">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <div className="text-sm">
              <p className="font-semibold">Renewal reminder</p>
              <p>
                Your {plan?.name} plan expires in {daysRemaining} day{daysRemaining === 1 ? '' : 's'}.
                Please renew to continue uninterrupted service.
              </p>
            </div>
          </div>
        )}

        {/* Expired subscription warning */}
        {isExpired && (
          <div className="flex items-center gap-3 rounded-lg border border-rose-300/60 bg-rose-50 p-4 text-rose-800">
            <XCircle className="w-5 h-5 shrink-0" />
            <div className="text-sm">
              <p className="font-semibold">Subscription expired</p>
              <p>
                Your {plan?.name} plan has expired. Please renew to regain access to your workspace.
              </p>
            </div>
            <Button size="sm" className="ml-auto shrink-0" variant="destructive" asChild>
              <Link href="/pricing">
                Renew now <ArrowRight className="w-4 h-4 ml-1" />
              </Link>
            </Button>
          </div>
        )}

        {/* Over-limit device warning */}
        {isOverLimit && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-amber-800">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <div className="text-sm">
              <p className="font-semibold">Device limit exceeded</p>
              <p>
                You have {deviceEntitlement?.extraDevices} extra device{deviceEntitlement?.extraDevices === 1 ? '' : 's'}
                {deviceEntitlement?.extraDevicePrice
                  ? ` (estimated additional: ${sub?.outstandingCurrency ?? plan?.currency ?? ''} ${(deviceEntitlement?.overageAmount ?? 0).toLocaleString()})`
                  : ''}.
                Contact your administrator for adjustment.
              </p>
            </div>
          </div>
        )}

        {/* Outstanding dues warning */}
        {outstandingAmount > 0 && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-300/60 bg-amber-50 p-4 text-amber-800">
            <AlertTriangle className="w-5 h-5 shrink-0" />
            <div className="text-sm">
              <p className="font-semibold">Outstanding balance</p>
              <p>
                You have an outstanding amount of {sub?.outstandingCurrency ?? plan?.currency ?? ''}{' '}
                {outstandingAmount.toLocaleString()}. Please settle your dues to avoid service interruption.
              </p>
            </div>
          </div>
        )}

        {/* Current plan card */}
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-lg">Current plan</CardTitle>
              <CardDescription>Your subscription and usage limits</CardDescription>
            </div>
            {subQuery.isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
          </CardHeader>
          <CardContent>
            {!plan ? (
              <p className="text-sm text-muted-foreground">
                No plan selected yet. Choose a plan to get started.
              </p>
            ) : (
              <div className="space-y-4">
                {/* Plan name + status + amount paid */}
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xl font-semibold">{plan.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {sub?.subscription?.billingPeriod === 'YEARLY'
                        ? `${plan.currency} ${(plan.priceYearly ?? plan.priceMonthly * 12).toLocaleString()}/yr`
                        : `${plan.currency} ${plan.priceMonthly.toLocaleString()}/mo`}
                    </p>
                  </div>
                  {subscriptionStatus && (
                    <Badge className={statusBadge(subscriptionStatus)}>{subscriptionStatus}</Badge>
                  )}
                </div>

                {/* Subscription details grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                  <div className="rounded-lg bg-muted/40 p-4">
                    <div className="flex items-center gap-1 text-muted-foreground mb-1">
                      <CheckCircle className="w-4 h-4" /> Paid
                    </div>
                    <p className="font-semibold">
                      {latestInvoice?.paidAt
                        ? `${latestInvoice.currency} ${latestInvoice.amount.toLocaleString()}`
                        : '—'}
                    </p>
                    {latestInvoice?.paidAt && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(latestInvoice.paidAt).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <div className="rounded-lg bg-muted/40 p-4">
                    <div className="flex items-center gap-1 text-muted-foreground mb-1">
                      <CalendarClock className="w-4 h-4" /> Started
                    </div>
                    <p className="font-semibold">
                      {sub?.subscription?.startDate
                        ? new Date(sub.subscription.startDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                        : '—'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-4">
                    <div className="flex items-center gap-1 text-muted-foreground mb-1">
                      <CalendarClock className="w-4 h-4" /> Expires
                    </div>
                    <p className="font-semibold">
                      {sub?.subscription?.endDate
                        ? new Date(sub.subscription.endDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                        : '—'}
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-4">
                    <div className="flex items-center gap-1 text-muted-foreground mb-1">
                      <CalendarClock className="w-4 h-4" /> Days Remaining
                    </div>
                    <p className="font-semibold">
                      {daysRemaining !== null && daysRemaining !== undefined
                        ? `${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`
                        : '—'}
                    </p>
                  </div>
                </div>

                {/* Device usage */}
                <div className="rounded-lg bg-muted/40 p-4">
                  <div className="flex items-center gap-1 text-muted-foreground mb-2">
                    <Monitor className="w-4 h-4" /> Device Usage
                  </div>
                  <div className="flex items-baseline gap-2">
                    <p className="text-xl font-semibold">
                      {deviceEntitlement?.activeDeviceCount ?? 0} / {deviceEntitlement?.includedDevices ?? plan.maxDevices}
                    </p>
                    {isOverLimit && (
                      <Badge className="bg-amber-500/15 text-amber-600">
                        +{deviceEntitlement?.extraDevices} extra
                      </Badge>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-4 text-xs text-muted-foreground">
                    <div>
                      <span className="block text-foreground font-medium">Included</span>
                      {deviceEntitlement?.includedDevices ?? plan.maxDevices} devices
                    </div>
                    <div>
                      <span className="block text-foreground font-medium">Current</span>
                      {deviceEntitlement?.activeDeviceCount ?? 0} devices
                    </div>
                    <div>
                      <span className="block text-foreground font-medium">Remaining</span>
                      {Math.max(0, (deviceEntitlement?.includedDevices ?? plan.maxDevices) - (deviceEntitlement?.activeDeviceCount ?? 0))} devices
                    </div>
                  </div>
                  {isOverLimit && deviceEntitlement?.extraDevicePrice ? (
                    <p className="mt-2 text-xs text-amber-600">
                      Overage: {deviceEntitlement.extraDevices} × {plan.currency} {deviceEntitlement.extraDevicePrice.toLocaleString()} = {plan.currency} {deviceEntitlement.overageAmount.toLocaleString()}
                    </p>
                  ) : null}
                </div>

                {/* Retention + Status row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                  <div className="rounded-lg bg-muted/40 p-4">
                    <div className="flex items-center gap-1 text-muted-foreground mb-1">
                      <CalendarClock className="w-4 h-4" /> Retention
                    </div>
                    <p className="font-semibold">
                      {plan.retentionDays <= 0 ? 'Unlimited' : `${plan.retentionDays} days`}
                    </p>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-4">
                    <div className="flex items-center gap-1 text-muted-foreground mb-1">
                      <CreditCard className="w-4 h-4" /> Billing
                    </div>
                    <p className="font-semibold capitalize">
                      {sub?.subscription?.billingPeriod?.toLowerCase() ?? 'Monthly'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Invoices */}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-lg">Invoices</CardTitle>
              <CardDescription>View and pay your invoices</CardDescription>
            </div>
            <Button size="sm" variant="outline" asChild>
              <Link href="/pricing">Change plan</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {invQuery.isLoading ? (
              <Skeleton className="h-40 w-full rounded-lg" />
            ) : invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">No invoices yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Due date</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium">{inv.invoiceNumber}</TableCell>
                      <TableCell>
                        {inv.currency} {inv.amount}
                      </TableCell>
                      <TableCell>
                        <Badge className={statusBadge(inv.status)}>{inv.status}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="ghost" asChild>
                          <Link href={`/invoices/${inv.id}`}>Details</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
