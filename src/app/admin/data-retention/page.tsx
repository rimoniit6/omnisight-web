'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useCurrentUser } from '@/hooks/use-current-user';

interface DataRetentionRow {
  id: string;
  name: string;
  planName: string;
  retentionDays: number;
  earliestDataAt: string | null;
  expiryAt: string | null;
  daysLeft: number | null;
  status: 'ACTIVE' | 'EXPIRING_SOON' | 'EXPIRED' | 'NO_DATA';
}

const STATUS_META: Record<DataRetentionRow['status'], { label: string; className: string }> = {
  ACTIVE: { label: 'Active', className: 'bg-emerald-500/15 text-emerald-600' },
  EXPIRING_SOON: { label: 'Expiring soon', className: 'bg-amber-500/15 text-amber-600' },
  EXPIRED: { label: 'Expired', className: 'bg-rose-500/15 text-rose-600' },
  NO_DATA: { label: 'No data', className: 'bg-muted text-muted-foreground' },
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function AdminDataRetentionPage() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useCurrentUser();

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  const query = useQuery<{ data: DataRetentionRow[] }>({
    queryKey: ['admin-data-retention'],
    queryFn: async () => {
      const res = await fetch('/api/admin/data-retention', { credentials: 'same-origin' });
      if (res.status === 403) throw new Error('super_admin');
      if (!res.ok) throw new Error('Failed to load data-retention report');
      return res.json();
    },
    enabled: !!user,
    staleTime: 30 * 1000,
  });

  const isSuperAdmin = user?.role === 'super_admin';

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
          <p className="text-muted-foreground mb-4">The data-retention report requires a super admin account.</p>
          <Button onClick={() => router.push('/')}>Back to app</Button>
        </div>
      </div>
    );
  }

  const error = query.error as Error | null;
  if (error?.message === 'super_admin') {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <div className="text-center max-w-sm">
          <ShieldAlert className="w-10 h-10 mx-auto text-rose-500 mb-3" />
          <p className="text-2xl font-semibold mb-2">Super admin only</p>
          <p className="text-muted-foreground mb-4">You are not authorized to view data retention.</p>
          <Button onClick={() => router.push('/')}>Back to app</Button>
        </div>
      </div>
    );
  }

  const rows = query.data?.data ?? [];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-10 bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="w-5 h-5 text-primary" />
            Data Retention
          </div>
          <Button variant="outline" size="sm" onClick={() => router.push('/')}>
            Back to app
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Retention windows</CardTitle>
            <CardDescription>
              Organizations with an active subscription and a defined retention window. Expiry is
              computed from the earliest stored data plus the plan retention days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <Skeleton className="h-64 w-full rounded-lg" />
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No subscribed organizations with a retention window.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organization</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Retention</TableHead>
                    <TableHead>Earliest data</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const meta = STATUS_META[row.status];
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.name}</TableCell>
                        <TableCell>{row.planName}</TableCell>
                        <TableCell>{row.retentionDays} days</TableCell>
                        <TableCell className="whitespace-nowrap">{formatDate(row.earliestDataAt)}</TableCell>
                        <TableCell className="whitespace-nowrap">{formatDate(row.expiryAt)}</TableCell>
                        <TableCell>
                          <Badge className={meta.className}>
                            {meta.label}
                            {row.daysLeft !== null && row.daysLeft >= 0 && row.status !== 'ACTIVE'
                              ? ` · ${row.daysLeft}d`
                              : ''}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
