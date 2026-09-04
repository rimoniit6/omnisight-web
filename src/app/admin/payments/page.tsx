'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useCurrentUser } from '@/hooks/use-current-user';

interface AdminInvoice {
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
  planName: string | null;
  organization: { id: string; name: string; email: string | null };
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

export default function AdminPaymentsPage() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useCurrentUser();
  const [rejectTarget, setRejectTarget] = useState<AdminInvoice | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  const query = useQuery<{ invoices: AdminInvoice[] }>({
    queryKey: ['admin-invoices'],
    queryFn: async () => {
      const res = await fetch('/api/admin/invoices', { credentials: 'same-origin' });
      if (res.status === 403) throw new Error('super_admin');
      if (!res.ok) throw new Error('Failed to load invoices');
      return res.json();
    },
    enabled: !!user,
    staleTime: 30 * 1000,
  });

  const isSuperAdmin = user?.role === 'super_admin';

  const runAction = async (invoiceId: string, action: 'verify' | 'reject', reason?: string) => {
    setActionId(invoiceId);
    try {
      const res = await fetch(`/api/admin/invoices/${invoiceId}/${action}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(reason ? { reason } : {}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? `Failed to ${action} invoice`);
        return;
      }
      toast.success(action === 'verify' ? 'Payment verified — subscription activated.' : 'Payment rejected.');
      query.refetch();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setActionId(null);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background p-8">
        <Skeleton className="h-10 w-56 mb-6" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!user) return null;

  if (!isSuperAdmin) {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <div className="text-center max-w-sm">
          <ShieldAlert className="w-10 h-10 mx-auto text-rose-500 mb-3" />
          <p className="text-2xl font-semibold mb-2">Super admin only</p>
          <p className="text-muted-foreground mb-4">
            Payment verification requires a super admin account.
          </p>
          <Button onClick={() => router.push('/')}>Back to app</Button>
        </div>
      </div>
    );
  }

  const invoices = query.data?.invoices ?? [];
  const error = query.error as Error | null;

  if (error?.message === 'super_admin') {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <div className="text-center max-w-sm">
          <ShieldAlert className="w-10 h-10 mx-auto text-rose-500 mb-3" />
          <p className="text-2xl font-semibold mb-2">Super admin only</p>
          <p className="text-muted-foreground mb-4">You are not authorized to manage payments.</p>
          <Button onClick={() => router.push('/')}>Back to app</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-10 bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="w-5 h-5 text-primary" />
            Payment Verification
          </div>
          <Button variant="outline" size="sm" onClick={() => router.push('/')}>
            Back to app
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Invoices</CardTitle>
            <CardDescription>Verify manual payments to activate subscriptions.</CardDescription>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <Skeleton className="h-64 w-full rounded-lg" />
            ) : invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No invoices found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Organization</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Ref</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-medium whitespace-nowrap">{inv.invoiceNumber}</TableCell>
                      <TableCell>
                        {inv.organization.name}
                        {inv.organization.email && (
                          <p className="text-xs text-muted-foreground">{inv.organization.email}</p>
                        )}
                      </TableCell>
                      <TableCell>{inv.planName ?? '—'}</TableCell>
                      <TableCell>
                        {inv.currency} {inv.amount}
                      </TableCell>
                      <TableCell>{inv.paymentMethod ?? '—'}</TableCell>
                      <TableCell className="max-w-[160px] truncate">{inv.transactionId ?? '—'}</TableCell>
                      <TableCell>
                        <Badge className={statusBadge(inv.status)}>{inv.status}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {inv.status === 'PAID' ? (
                          <span className="text-xs text-muted-foreground">Verified</span>
                        ) : (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-emerald-600"
                              disabled={actionId === inv.id}
                              onClick={() => runAction(inv.id, 'verify')}
                            >
                              {actionId === inv.id ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <CheckCircle2 className="w-4 h-4" />
                              )}
                              Verify
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-rose-600"
                              disabled={actionId === inv.id}
                              onClick={() => {
                                setRejectTarget(inv);
                                setRejectReason('');
                              }}
                            >
                              <XCircle className="w-4 h-4" />
                              Reject
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>

      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject payment</DialogTitle>
            <DialogDescription>
              {rejectTarget?.invoiceNumber} · {rejectTarget?.organization.name} · reason shared with the org.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Why is this payment being rejected?"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={4}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={actionId === rejectTarget?.id}
              onClick={() => {
                if (!rejectTarget) return;
                runAction(rejectTarget.id, 'reject', rejectReason.trim() || undefined);
                setRejectTarget(null);
              }}
            >
              {actionId === rejectTarget?.id ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Reject payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
