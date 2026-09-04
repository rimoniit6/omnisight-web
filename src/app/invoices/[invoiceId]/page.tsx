'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, ReceiptText, CheckCircle2, Landmark } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
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

const PAYMENT_METHODS = [
  { value: 'Bank_Transfer', label: 'Bank Transfer' },
  { value: 'bKash', label: 'bKash' },
  { value: 'Nagad', label: 'Nagad' },
  { value: 'Rocket', label: 'Rocket' },
];

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

  const { user, org, isLoading: authLoading } = useCurrentUser();
  const [method, setMethod] = useState('Bank_Transfer');
  const [txnId, setTxnId] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

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

  const handleSubmit = async () => {
    if (!txnId.trim()) {
      toast.error('Please enter your transaction / payment reference');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/invoices/${invoiceId}/submit-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          paymentMethod: method,
          transactionId: txnId.trim(),
          notes: note.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to submit payment');
        return;
      }
      toast.success('Payment details submitted. An admin will verify your payment.');
      query.refetch();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const ownOrg = org?.id === invoice.organization.id;

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

        {/* Payment section */}
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
                <Landmark className="w-5 h-5 text-primary" /> Submit manual payment
              </CardTitle>
              <CardDescription>
                Choose how you paid and enter the transaction reference. We&apos;ll verify it manually.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <RadioGroup value={method} onValueChange={setMethod} className="space-y-2">
                {PAYMENT_METHODS.map((m) => (
                  <div key={m.value} className="flex items-center gap-3 rounded-lg border p-3">
                    <RadioGroupItem value={m.value} id={m.value} />
                    <Label htmlFor={m.value} className="font-medium">
                      {m.label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>

              <div className="space-y-1.5">
                <Label htmlFor="txn">Transaction / Payment reference</Label>
                <Input
                  id="txn"
                  placeholder="e.g. bkash trx 9XK3T2U8, or bank ref"
                  value={txnId}
                  onChange={(e) => setTxnId(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="note">Note (optional)</Label>
                <Textarea
                  id="note"
                  placeholder="Anything we should know about your payment"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                />
              </div>
            </CardContent>
            <CardFooter>
              <Button
                className="w-full"
                onClick={handleSubmit}
                disabled={submitting || !ownOrg}
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting...
                  </>
                ) : ownOrg ? (
                  'Submit payment details'
                ) : (
                  'You cannot pay this invoice'
                )}
              </Button>
            </CardFooter>
          </Card>
        )}
      </main>
    </div>
  );
}
