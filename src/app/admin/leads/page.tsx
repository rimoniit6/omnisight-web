'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Inbox, Loader2, ShieldAlert } from 'lucide-react';
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

const LEAD_STATUSES = ['NEW', 'CONTACTED', 'CONVERTED', 'IGNORED'] as const;
type LeadStatus = (typeof LEAD_STATUSES)[number];

interface LeadRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  planInterest: string;
  message: string | null;
  status: string;
  source: string | null;
  createdAt: string;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    NEW: 'bg-sky-500/15 text-sky-600',
    CONTACTED: 'bg-amber-500/15 text-amber-600',
    CONVERTED: 'bg-emerald-500/15 text-emerald-600',
    IGNORED: 'bg-muted text-muted-foreground',
  };
  return map[status] ?? 'bg-muted text-muted-foreground';
}

function planBadge(plan: string) {
  return plan === 'Enterprise' || plan === 'Business' || plan === 'Self-Hosted'
    ? 'bg-violet-500/15 text-violet-600'
    : 'bg-muted text-muted-foreground';
}

export default function AdminLeadsPage() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useCurrentUser();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [noteTarget, setNoteTarget] = useState<LeadRow | null>(null);
  const [noteText, setNoteText] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  const query = useQuery<{ leads: LeadRow[] }>({
    queryKey: ['admin-leads', statusFilter],
    queryFn: async () => {
      const qs = statusFilter === 'ALL' ? '' : `?status=${encodeURIComponent(statusFilter)}`;
      const res = await fetch(`/api/admin/leads${qs}`, { credentials: 'same-origin' });
      if (res.status === 403) throw new Error('super_admin');
      if (!res.ok) throw new Error('Failed to load leads');
      return res.json();
    },
    enabled: !!user,
    staleTime: 30 * 1000,
  });

  const isSuperAdmin = user?.role === 'super_admin';

  const setStatus = useMutation({
    mutationFn: async ({ leadId, status, notes }: { leadId: string; status: LeadStatus; notes?: string }) => {
      const res = await fetch(`/api/admin/leads/${leadId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ status, notes }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? 'Failed to update lead');
      return json;
    },
    onSuccess: (_data, vars) => {
      toast.success(vars.status === 'CONVERTED' ? 'Marked as converted.' : `Status set to ${vars.status}.`);
      queryClient.invalidateQueries({ queryKey: ['admin-leads'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const runStatus = async (lead: LeadRow, status: LeadStatus) => {
    setActionId(lead.id);
    try {
      await setStatus.mutateAsync({ leadId: lead.id, status });
    } finally {
      setActionId(null);
      setNoteTarget(null);
      setNoteText('');
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
          <p className="text-muted-foreground mb-4">Lead management requires a super admin account.</p>
          <Button onClick={() => router.push('/')}>Back to app</Button>
        </div>
      </div>
    );
  }

  const leads = query.data?.leads ?? [];
  const error = query.error as Error | null;

  if (error?.message === 'super_admin') {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <div className="text-center max-w-sm">
          <ShieldAlert className="w-10 h-10 mx-auto text-rose-500 mb-3" />
          <p className="text-2xl font-semibold mb-2">Super admin only</p>
          <p className="text-muted-foreground mb-4">You are not authorized to manage leads.</p>
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
            <Inbox className="w-5 h-5 text-primary" />
            Sales Leads
          </div>
          <Button variant="outline" size="sm" onClick={() => router.push('/')}>
            Back to app
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <CardTitle className="text-lg">Leads</CardTitle>
                <CardDescription>Contact sales submissions collected from the landing page.</CardDescription>
              </div>
              <div className="flex flex-wrap gap-2">
                {(['ALL', ...LEAD_STATUSES] as const).map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={statusFilter === s ? 'default' : 'outline'}
                    onClick={() => setStatusFilter(s)}
                  >
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <Skeleton className="h-64 w-full rounded-lg" />
            ) : leads.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No leads found.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leads.map((lead) => (
                    <TableRow key={lead.id}>
                      <TableCell className="font-medium whitespace-nowrap">{lead.name}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {lead.email}
                        {lead.message && (
                          <p className="text-xs text-muted-foreground max-w-[200px] truncate">
                            {lead.message}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>{lead.company ?? '—'}</TableCell>
                      <TableCell>
                        <Badge className={planBadge(lead.planInterest)}>{lead.planInterest}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className={statusBadge(lead.status)}>{lead.status}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {new Date(lead.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {lead.status === 'IGNORED' || lead.status === 'CONVERTED' ? (
                          <span className="text-xs text-muted-foreground">Closed</span>
                        ) : (
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-amber-600"
                              disabled={actionId === lead.id}
                              onClick={() => runStatus(lead, 'CONTACTED')}
                            >
                              {actionId === lead.id ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                              Contacted
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-emerald-600"
                              disabled={actionId === lead.id}
                              onClick={() => {
                                setNoteTarget(lead);
                                setNoteText('');
                              }}
                            >
                              Converted
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-muted-foreground"
                              disabled={actionId === lead.id}
                              onClick={() => runStatus(lead, 'IGNORED')}
                            >
                              Ignore
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

      <Dialog open={!!noteTarget} onOpenChange={(o) => !o && setNoteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convert lead</DialogTitle>
            <DialogDescription>
              {noteTarget?.name} · {noteTarget?.email} · {noteTarget?.planInterest}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Optional note (e.g. account created for this lead)."
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={4}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNoteTarget(null)}>
              Cancel
            </Button>
            <Button
              className="text-emerald-700"
              disabled={actionId === noteTarget?.id}
              onClick={() => {
                if (!noteTarget) return;
                runStatus(noteTarget, 'CONVERTED');
              }}
            >
              {actionId === noteTarget?.id ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                'Mark as converted'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
