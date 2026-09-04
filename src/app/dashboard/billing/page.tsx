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
} from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCurrentUser } from '@/hooks/use-current-user';

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

  const sub = subQuery.data;
  const plan = sub?.subscription?.plan ?? null;
  const invoices = invQuery.data?.invoices ?? [];

  const isOnTrial = !!sub?.isOnTrial;
  const subscriptionStatus = sub?.subscription?.status ?? null;
  const needsSubscription = !subscriptionStatus && subQuery.isSuccess;

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
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xl font-semibold">{plan.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {plan.currency} {plan.priceMonthly}/mo
                      {plan.priceYearly != null ? ` · ${plan.currency} ${plan.priceYearly}/yr` : ''}
                    </p>
                  </div>
                  {subscriptionStatus && (
                    <Badge className={statusBadge(subscriptionStatus)}>{subscriptionStatus}</Badge>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                  <div className="rounded-lg bg-muted/40 p-4">
                    <div className="flex items-center gap-1 text-muted-foreground mb-1">
                      <Monitor className="w-4 h-4" /> Devices
                    </div>
                    <p className="font-semibold">
                      {sub?.activeDeviceCount ?? 0} / {plan.maxDevices <= 0 ? '∞' : plan.maxDevices}
                    </p>
                  </div>
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
                      <CreditCard className="w-4 h-4" /> Status
                    </div>
                    <p className="font-semibold capitalize">
                      {subscriptionStatus?.toLowerCase() ?? 'None'}
                    </p>
                  </div>
                </div>

                {sub?.subscription?.endDate && (
                  <p className="text-xs text-muted-foreground">
                    Renews / ends: {new Date(sub.subscription.endDate).toLocaleDateString()}
                  </p>
                )}
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
