'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { KeyRound, Plus, ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCurrentUser } from '@/hooks/use-current-user';

interface LicenseRow {
  id: string;
  key: string;
  validFrom: string;
  validUntil: string;
  isActive: boolean;
  isRevoked: boolean;
  revokedAt: string | null;
  revokedReason: string | null;
  lastVerifiedAt: string | null;
  verificationCount: number;
  createdAt: string;
  organization: { id: string; name: string } | null;
  plan: { id: string; name: string } | null;
}

interface OrgOption {
  id: string;
  name: string;
}

interface PlanOption {
  id: string;
  name: string;
  isSelfHosted: boolean;
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function AdminLicensesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useCurrentUser();

  const [open, setOpen] = useState(false);
  const [orgId, setOrgId] = useState('');
  const [planId, setPlanId] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [generating, setGenerating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  const isSuperAdmin = user?.role === 'super_admin';

  const licensesQuery = useQuery<{ data: { licenses: LicenseRow[]; total: number } }>({
    queryKey: ['admin-licenses'],
    queryFn: async () => {
      const res = await fetch('/api/admin/licenses', { credentials: 'same-origin' });
      if (res.status === 403) throw new Error('super_admin');
      if (!res.ok) throw new Error('Failed to load licenses');
      return res.json();
    },
    enabled: !!user && isSuperAdmin,
    staleTime: 30 * 1000,
  });

  const orgsQuery = useQuery<{ data: { id: string; name: string }[] }>({
    queryKey: ['admin-license-orgs'],
    queryFn: async () => {
      const res = await fetch('/api/super-admin/organizations?pageSize=200', { credentials: 'same-origin' });
      const json = await res.json();
      return json as { data: OrgOption[] };
    },
    enabled: !!user && isSuperAdmin && open,
  });

  const plansQuery = useQuery<{ plans: PlanOption[] }>({
    queryKey: ['admin-license-plans'],
    queryFn: async () => {
      const res = await fetch('/api/plans', { credentials: 'same-origin' });
      return res.json();
    },
    enabled: !!user && isSuperAdmin && open,
  });

  async function handleGenerate() {
    setErrorMsg(null);
    if (!orgId || !planId) {
      setErrorMsg('Select an organization and a plan.');
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch('/api/admin/licenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ organizationId: orgId, planId, validUntil: validUntil || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'Failed to generate license');
      setOpen(false);
      setOrgId('');
      setPlanId('');
      setValidUntil('');
      queryClient.invalidateQueries({ queryKey: ['admin-licenses'] });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to generate license');
    } finally {
      setGenerating(false);
    }
  }

  async function handleRevoke(license: LicenseRow) {
    const reason = window.prompt(`Revoke license for "${license.organization?.name ?? 'unknown'}"?\nOptional reason:`);
    if (reason === null) return; // cancelled
    setRevokingId(license.id);
    try {
      const res = await fetch(`/api/admin/licenses/${license.id}/revoke`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ reason: reason || undefined }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || 'Failed to revoke license');
      }
      queryClient.invalidateQueries({ queryKey: ['admin-licenses'] });
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to revoke license');
    } finally {
      setRevokingId(null);
    }
  }

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
          <p className="text-muted-foreground mb-4">License key management requires a super admin account.</p>
          <Button onClick={() => router.push('/')}>Back to app</Button>
        </div>
      </div>
    );
  }

  const error = licensesQuery.error as Error | null;
  const licenses = licensesQuery.data?.data.licenses ?? [];
  const selfHostedPlans = (plansQuery.data?.plans ?? []).filter((p) => p.isSelfHosted);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-10 bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <KeyRound className="w-5 h-5 text-primary" />
            License Keys
          </div>
          <div className="flex items-center gap-2">
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="w-4 h-4 mr-1" /> Generate key
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Generate license key</DialogTitle>
                  <DialogDescription>
                    Create a new self-hosted license for an organization. Keys use the format
                    OMNISIGHT-XXXX-XXXX-XXXX and are valid for one year (adjustable).
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <div className="space-y-1.5">
                    <Label>Organization</Label>
                    <Select value={orgId} onValueChange={setOrgId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select organization" />
                      </SelectTrigger>
                      <SelectContent>
                        {(orgsQuery.data?.data ?? []).map((o) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Self-hosted plan</Label>
                    <Select value={planId} onValueChange={setPlanId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select plan" />
                      </SelectTrigger>
                      <SelectContent>
                        {selfHostedPlans.length === 0 ? (
                          <SelectItem value="__none" disabled>
                            No self-hosted plans found
                          </SelectItem>
                        ) : (
                          selfHostedPlans.map((p) => (
                            <SelectItem key={p.id} value={p.id}>
                              {p.name}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="validUntil">Valid until (optional)</Label>
                    <Input
                      id="validUntil"
                      type="date"
                      value={validUntil}
                      onChange={(e) => setValidUntil(e.target.value)}
                    />
                  </div>
                  {errorMsg && <p className="text-sm text-rose-600">{errorMsg}</p>}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={handleGenerate} disabled={generating}>
                    {generating ? 'Generating…' : 'Generate'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
            <Button variant="outline" size="sm" onClick={() => router.push('/')}>
              Back to app
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Self-hosted licenses</CardTitle>
            <CardDescription>
              Issue and revoke OMNISIGHT-XXXX-XXXX-XXXX license keys for on-prem deployments.
              Revoked or expired keys cannot validate; the affected instance must obtain a new key.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error?.message === 'super_admin' || licensesQuery.isError ? (
              <p className="text-sm text-rose-600 py-6 text-center">Unable to load licenses.</p>
            ) : licensesQuery.isLoading ? (
              <Skeleton className="h-64 w-full rounded-lg" />
            ) : licenses.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">
                No license keys yet. Generate one to issue a self-hosted deployment.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Key</TableHead>
                      <TableHead>Organization</TableHead>
                      <TableHead>Plan</TableHead>
                      <TableHead>Valid until</TableHead>
                      <TableHead>Last verified</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {licenses.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell className="font-mono text-xs">{l.key}</TableCell>
                        <TableCell className="font-medium">{l.organization?.name ?? '—'}</TableCell>
                        <TableCell>{l.plan?.name ?? '—'}</TableCell>
                        <TableCell className="whitespace-nowrap">{fmt(l.validUntil)}</TableCell>
                        <TableCell className="whitespace-nowrap">{fmt(l.lastVerifiedAt)}</TableCell>
                        <TableCell>
                          {l.isRevoked ? (
                            <Badge className="bg-rose-500/15 text-rose-600">Revoked</Badge>
                          ) : new Date(l.validUntil).getTime() <= Date.now() ? (
                            <Badge className="bg-amber-500/15 text-amber-600">Expired</Badge>
                          ) : (
                            <Badge className="bg-emerald-500/15 text-emerald-600">Active</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {!l.isRevoked && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-rose-600"
                              disabled={revokingId === l.id}
                              onClick={() => handleRevoke(l)}
                            >
                              {revokingId === l.id ? 'Revoking…' : 'Revoke'}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
