'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ReceiptText, CheckCircle2, Landmark } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/hooks/use-current-user';

interface PlanBrief {
  id: string;
  name: string;
  description: string | null;
}

interface InvoiceDetail {
  id: string;
  invoiceNumber: string;
  amount: number;
  currency: string;
  status: string;
  dueDate: string;
  paidAt: string | null;
  paymentMethod: string | null;
  transactionId: string | null;
  notes: string | null;
  createdAt: string;
  organization: { id: string; name: string };
  subscription: { id: string; status: string; startDate: string; endDate: string | null };
  plan: PlanBrief | null;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    PAID: 'bg-emerald-500/15 text-emerald-600',
    PENDING: 'bg-amber-500/15 text-amber-600',
    OVERDUE: 'bg-rose-500/15 text-rose-600',
    CANCELLED: 'bg-muted text-muted-foreground',
  };
  return map[status] ?? 'bg-muted text-muted-foreground';
}

export default function InvoiceDetailPage() {
  const params = useParams<{ invoiceId: string }>();
  const invoiceId = params.invoiceId;
  const router = useRouter();

  const { user, isLoading: authLoading } = useCurrentUser();
  const [notFound, setNotFound] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  const query = useQuery<{ invoice: InvoiceDetail }>({
    queryKey: ['invoice', invoiceId],
    queryFn: async () => {
      const res = await fetch(`/api/invoices/${invoiceId}`, { credentials: 'same-origin' });
      if (res.status === 404) {
        setNotFound(true);
        throw new Error('Not found');
      }
      if (res.status === 403) {
        setForbidden(true);
        throw new Error('Forbidden');
      }
      if (!res.ok) throw new Error('Failed to load invoice');
      return res.json();
    },
    enabled: !!invoiceId,
    staleTime: 60 * 1000,
  });

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  if (authLoading || query.isLoading) {
    return (
      <div className="min-h-screen bg-background p-8">
        <Skeleton className="h-10 w-48 mb-6" />
        <Skeleton className="h-96 w-full max-w-2xl rounded-xl" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <div className="text-center">
          <p className="text-2xl font-semibold mb-2">Invoice not found</p>
          <p className="text-muted-foreground mb-4">This invoice doesn&apos;t exist or no longer is available.</p>
          <Button asChild>
            <Link href="/dashboard/billing">Back to billing</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <div className="text-center">
          <ReceiptText className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-2xl font-semibold mb-2">Access denied</p>
          <p className="text-muted-foreground mb-4">
            You don&apos;t have permission to view this invoice.
          </p>
          <Button asChild>
            <Link href="/dashboard/billing">Back to billing</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (!user) return null;

  const invoice = query.data?.invoice;

  if (!invoice) {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <p className="text-muted-foreground">Unable to load invoice.</p>
      </div>
    );
  }

  const isPaid = invoice.status === 'PAID';
  const isCancelled = invoice.status === 'CANCELLED';

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-10 bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-3xl px-4 h-16 flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.back()}>
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          <span className="font-semibold flex items-center gap-2">
            <ReceiptText className="w-5 h-5 text-primary" />
            {invoice.invoiceNumber}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8 space-y-6">
        {/* Invoice summary */}
        <Card>
          <CardHeader className="flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="text-xl">{invoice.invoiceNumber}</CardTitle>
              <CardDescription>
                {invoice.organization.name} · {invoice.plan?.name ?? 'Subscription'}
              </CardDescription>
            </div>
            <Badge className={statusBadge(invoice.status)}>{invoice.status}</Badge>
          </CardHeader>
          <CardContent className="grid sm:grid-cols-2 gap-4 text-sm">
            <div className="rounded-lg bg-muted/40 p-4">
              <p className="text-muted-foreground mb-1">Amount due</p>
              <p className="text-2xl font-bold">
                {invoice.currency} {invoice.amount}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Due {new Date(invoice.dueDate).toLocaleDateString()}
              </p>
            </div>
            <div className="rounded-lg bg-muted/40 p-4 space-y-1">
              <p className="text-muted-foreground">Issued</p>
              <p className="font-medium">{new Date(invoice.createdAt).toLocaleDateString()}</p>
              {invoice.paidAt && (
                <>
                  <p className="text-muted-foreground mt-2">Paid</p>
                  <p className="font-medium">{new Date(invoice.paidAt).toLocaleDateString()}</p>
                </>
              )}
              {invoice.paymentMethod && (
                <>
                  <p className="text-muted-foreground mt-2">Payment method</p>
                  <p className="font-medium">{invoice.paymentMethod}</p>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Payment status */}
        {isPaid ? (
          <Card>
            <CardContent className="flex items-center gap-3 py-8">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
              <div>
                <p className="font-semibold text-lg">Payment confirmed</p>
                <p className="text-sm text-muted-foreground">
                  Paid {invoice.currency} {invoice.amount}
                  {invoice.transactionId ? ` · Ref: ${invoice.transactionId}` : ''}.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : isCancelled ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="font-semibold text-lg">Invoice cancelled</p>
              <p className="text-sm text-muted-foreground mt-1">
                This invoice is no longer payable. Please contact support if you believe this is an error.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Landmark className="w-5 h-5 text-primary" /> Payment arranged with OmniSight
              </CardTitle>
              <CardDescription>
                OmniSight subscriptions are billed manually — no online checkout and nothing to submit here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg bg-muted/40 p-4 text-sm text-muted-foreground space-y-2">
                <p>
                  The OmniSight team shares payment instructions separately. This invoice stays{' '}
                  <span className="font-medium text-foreground">PENDING</span> until payment is confirmed, at
                  which point your subscription is activated and the invoice is marked paid.
                </p>
                <p>Questions about this invoice? Contact your OmniSight representative.</p>
              </div>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
