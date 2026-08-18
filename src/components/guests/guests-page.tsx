'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { QuickStats, type QuickStat } from '@/components/ui/quick-stats';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { PaginationControls } from '@/components/ui/pagination-controls';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Monitor,
  CheckCircle2,
  XCircle,
  Clock,
  PowerOff,
  PauseCircle,
  PlayCircle,
  UserPlus,
  Search,
  Laptop,
  ArrowRightLeft,
  ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';

// ─── Types (mirror the API response shapes) ────────────────────────────────

interface ClaimDevice {
  id: string;
  name: string;
  hostname: string;
  operatingSystem: string | null;
  osVersion: string | null;
  agentVersion: string | null;
  status: string;
  lastHeartbeat: string | null;
  registeredAt: string;
}

interface PendingClaim {
  id: string;
  deviceId: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  device: ClaimDevice;
  employee: { id: string; employeeId: string; firstName: string; lastName: string; email: string } | null;
}

interface GuestRow {
  id: string;
  deviceId: string;
  employeeId: string;
  status: string;
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  suspendedAt: string | null;
  suspendedBy: string | null;
  createdAt: string;
  updatedAt: string;
  device: {
    id: string;
    name: string;
    hostname: string;
    operatingSystem: string | null;
    agentVersion: string | null;
    ipAddress: string | null;
    status: string;
    lastHeartbeat: string | null;
    registeredAt: string;
  };
  employee: {
    id: string;
    employeeId: string;
    firstName: string;
    lastName: string;
    email: string;
    status: string;
    type: string;
  } | null;
}

const PAGE_SIZE = 20;

const statusConfig: Record<string, { label: string; color: string; bg: string }> = {
  ACTIVE: { label: 'Active', color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20' },
  SUSPENDED: { label: 'Suspended', color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20' },
  REJECTED: { label: 'Rejected', color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20' },
  REVOKED: { label: 'Revoked', color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-900/20' },
};

function fmt(ts: string | null | undefined): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function GuestStatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? { label: status, color: 'text-muted-foreground', bg: 'bg-muted' };
  return (
    <Badge variant="outline" className={`${cfg.color} ${cfg.bg} border-transparent`}>{cfg.label}</Badge>
  );
}

export function GuestsPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('pending');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // ── Pending queue (pending zero-touch claims = pending guest enrollments) ──
  const pendingQuery = useQuery({
    queryKey: ['device-claims', 'pending', 'guest-page', page],
    queryFn: async () => {
      const params = new URLSearchParams({ status: 'pending', page: String(page), pageSize: String(PAGE_SIZE) });
      if (search) params.set('q', search);
      const res = await fetch(`/api/device-claims?${params}`);
      if (!res.ok) throw new Error('Failed to load pending guests');
      return res.json();
    },
  });

  // ── Guest rows (ACTIVE / SUSPENDED / REJECTED / REVOKED) ─────────────────
  const statusForTab = tab === 'active' ? 'ACTIVE' : tab === 'suspended' ? 'SUSPENDED' : null;
  const rejectedTab = tab === 'rejected-revoked';

  const guestsQuery = useQuery({
    queryKey: ['guests', statusForTab ?? (rejectedTab ? 'REJECTED,REVOKED' : ''), page, search],
    queryFn: async () => {
      if (tab === 'pending') return null;
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (statusForTab) params.set('status', statusForTab);
      if (search) params.set('q', search);
      const res = await fetch(`/api/guests?${params}`);
      if (!res.ok) throw new Error('Failed to load guests');
      const json = await res.json();
      // Rejected/Revoked tab merges both statuses client-side (bounded page).
      if (rejectedTab) {
        const rejected = json.data.filter((g: GuestRow) => g.status === 'REJECTED');
        const revoked = json.data.filter((g: GuestRow) => g.status === 'REVOKED');
        return { ...json, data: [...rejected, ...revoked] };
      }
      return json;
    },
  });

  // ── Summary stats (org-scoped counts) ─────────────────────────────────────
  const summaryQuery = useQuery({
    queryKey: ['guests', 'summary'],
    queryFn: async () => {
      const [guestsRes, pendingRes] = await Promise.all([
        fetch('/api/guests?summary=true'),
        fetch('/api/device-claims?status=pending&pageSize=1'),
      ]);
      const guests = guestsRes.ok ? await guestsRes.json() : { summary: {} };
      const pending = pendingRes.ok ? await pendingRes.json() : { total: 0 };
      return {
        summary: guests.summary ?? {},
        pendingCount: pending.total ?? 0,
      };
    },
  });

  const summary = summaryQuery.data?.summary ?? {};
  const pendingCount = summaryQuery.data?.pendingCount ?? 0;
  const activeCount = summary.ACTIVE ?? 0;
  const suspendedCount = summary.SUSPENDED ?? 0;
  const closedCount = (summary.REJECTED ?? 0) + (summary.REVOKED ?? 0);

  const stats: QuickStat[] = [
    { label: 'Pending Guests', value: pendingCount, icon: Clock, color: 'bg-amber-500' },
    { label: 'Active', value: activeCount, icon: CheckCircle2, color: 'bg-emerald-500' },
    { label: 'Suspended', value: suspendedCount, icon: PauseCircle, color: 'bg-amber-500' },
    { label: 'Rejected / Revoked', value: closedCount, icon: XCircle, color: 'bg-gray-500' },
  ];

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['guests'] });
    queryClient.invalidateQueries({ queryKey: ['device-claims'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  // ── Actions ───────────────────────────────────────────────────────────────

  const approveAsGuest = async (claimId: string, hostname: string) => {
    try {
      const res = await fetch(`/api/device-claims/${claimId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'guest' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to approve guest');
      toast.success(`"${hostname}" approved as a guest`);
      invalidateAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to approve guest');
    }
  };

  const rejectClaim = async (claimId: string, hostname: string) => {
    try {
      const res = await fetch(`/api/device-claims/${claimId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Guest request rejected by administrator' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to reject');
      toast.success(`"${hostname}" rejected`);
      invalidateAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reject');
    }
  };

  const [revokeTarget, setRevokeTarget] = useState<GuestRow | null>(null);

  const guestAction = async (id: string, action: 'suspend' | 'reactivate', hostname: string) => {
    try {
      const res = await fetch(`/api/guests/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Failed to ${action}`);
      toast.success(`${hostname} ${action === 'suspend' ? 'suspended' : 'reactivated'}`);
      invalidateAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to ${action}`);
    }
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setRevokeTarget(null);
    try {
      const res = await fetch(`/api/guests/${target.id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to revoke');
      toast.success(`${target.device.name || target.device.hostname} revoked — device and tokens disabled`);
      invalidateAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to revoke');
    }
  };

  // Convert dialog state
  const [convertTarget, setConvertTarget] = useState<GuestRow | null>(null);
  const [convertForm, setConvertForm] = useState({ firstName: '', lastName: '', email: '', employeeId: '' });
  const [converting, setConverting] = useState(false);

  const openConvert = (g: GuestRow) => {
    setConvertTarget(g);
    setConvertForm({
      firstName: g.employee?.firstName === 'Guest' ? '' : (g.employee?.firstName ?? ''),
      lastName: g.employee?.lastName === g.device.hostname ? '' : (g.employee?.lastName ?? ''),
      email: g.employee?.email && !g.employee.email.endsWith('@guests.invalid') ? g.employee.email : '',
      employeeId: g.employee?.employeeId?.startsWith('GUEST-') ? '' : (g.employee?.employeeId ?? ''),
    });
  };

  const submitConvert = async () => {
    if (!convertTarget) return;
    if (!convertForm.firstName.trim() || !convertForm.lastName.trim() || !convertForm.email.trim()) {
      toast.error('First name, last name and email are required');
      return;
    }
    setConverting(true);
    try {
      const res = await fetch(`/api/guests/${convertTarget.id}/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: convertForm.firstName.trim(),
          lastName: convertForm.lastName.trim(),
          email: convertForm.email.trim(),
          employeeId: convertForm.employeeId.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to convert guest');
      toast.success('Guest converted to employee — telemetry history preserved');
      setConvertTarget(null);
      invalidateAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to convert guest');
    } finally {
      setConverting(false);
    }
  };

  const data = tab === 'pending' ? (pendingQuery.data?.data ?? []) : (guestsQuery.data?.data ?? []);
  const total = tab === 'pending' ? (pendingQuery.data?.total ?? 0) : (guestsQuery.data?.total ?? 0);
  const totalPages = tab === 'pending' ? (pendingQuery.data?.totalPages ?? 1) : (guestsQuery.data?.totalPages ?? 1);

  const renderDevice = (device: GuestRow['device'] | ClaimDevice) => (
    <div className="flex items-center gap-3 min-w-0">
      <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
        <Laptop className="w-4 h-4 text-primary" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{device.name || device.hostname}</p>
        <p className="text-xs text-muted-foreground font-mono truncate">ID: {device.id.slice(0, 16)}…</p>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-primary" /> Guests
          </h1>
          <p className="text-sm text-muted-foreground">
            Zero-touch enrollments approved without employee credentials. Approval auto-grants standard monitoring consent (activity + application tracking) bound to the org's published policies; sensitive capture types (screenshots, keystrokes, location, etc.) require a separate grant.
          </p>
        </div>
      </div>

      <QuickStats stats={stats} />

      <Tabs value={tab} onValueChange={(v) => { setTab(v); setPage(1); }}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="pending" className="gap-1.5">
              <Clock className="w-3.5 h-3.5" /> Pending
              {pendingCount > 0 && <Badge className="bg-amber-500 text-white">{pendingCount}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="active" className="gap-1.5"><CheckCircle2 className="w-3.5 h-3.5" /> Active</TabsTrigger>
            <TabsTrigger value="suspended" className="gap-1.5"><PauseCircle className="w-3.5 h-3.5" /> Suspended</TabsTrigger>
            <TabsTrigger value="rejected-revoked" className="gap-1.5"><XCircle className="w-3.5 h-3.5" /> Rejected / Revoked</TabsTrigger>
          </TabsList>
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search device or ID…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-8 h-9 text-sm"
            />
          </div>
        </div>

        <TabsContent value="pending" className="mt-4 space-y-4">
          <Card className="falcon-card p-0">
            <CardContent className="p-0">
              {(pendingQuery.isLoading) ? (
                <div className="p-8 text-center text-sm text-muted-foreground">Loading pending registrations…</div>
              ) : data.length === 0 ? (
                <EmptyState
                  icon={Monitor}
                  title="No pending guest enrollments"
                  description="Devices that start the OmniSight Agent with zero-touch enrollment appear here for approval."
                />
              ) : (
                <div className="divide-y divide-border">
                  {(data as PendingClaim[]).map((claim) => (
                    <div key={claim.id} className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                      <div className="min-w-0">
                        {renderDevice(claim.device)}
                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                          <span>{claim.device.operatingSystem ?? 'Unknown OS'}</span>
                          {claim.device.agentVersion && <span>Agent v{claim.device.agentVersion}</span>}
                          <span>First seen {fmt(claim.device.registeredAt)}</span>
                          {claim.expiresAt && <span className="text-amber-600 dark:text-amber-400">Claim expires {fmt(claim.expiresAt)}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button size="sm" onClick={() => approveAsGuest(claim.id, claim.device.name || claim.device.hostname)}>
                          <ShieldCheck className="w-3.5 h-3.5" /> Approve as Guest
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => rejectClaim(claim.id, claim.device.name || claim.device.hostname)}>
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <PaginationControls currentPage={page} totalPages={totalPages} totalItems={total} onPageChange={setPage} pageSize={PAGE_SIZE} />
        </TabsContent>

        <TabsContent value="active" className="mt-4 space-y-4">
          <Card className="falcon-card p-0">
            <CardContent className="p-0">
              {guestsQuery.isLoading ? (
                <div className="p-8 text-center text-sm text-muted-foreground">Loading guests…</div>
              ) : data.length === 0 ? (
                <EmptyState icon={UserPlus} title="No active guests" description="Approved guests appear here." />
              ) : (
                <div className="divide-y divide-border">
                  {(data as GuestRow[]).map((g) => (
                    <div key={g.id} className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                      <div className="min-w-0">
                        {renderDevice(g.device)}
                        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                          <GuestStatusBadge status={g.status} />
                          <span>ID: <span className="font-mono">{g.employee?.employeeId ?? '—'}</span></span>
                          <span>Approved {fmt(g.approvedAt)}</span>
                          <span>Last seen {fmt(g.device.lastHeartbeat)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button size="sm" variant="outline" onClick={() => openConvert(g)}>
                          <ArrowRightLeft className="w-3.5 h-3.5" /> Convert to Employee
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => guestAction(g.id, 'suspend', g.device.name || g.device.hostname)}>
                          <PauseCircle className="w-3.5 h-3.5" /> Suspend
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => setRevokeTarget(g)}>
                          <PowerOff className="w-3.5 h-3.5" /> Revoke
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <PaginationControls currentPage={page} totalPages={totalPages} totalItems={total} onPageChange={setPage} pageSize={PAGE_SIZE} />
        </TabsContent>

        <TabsContent value="suspended" className="mt-4 space-y-4">
          <Card className="falcon-card p-0">
            <CardContent className="p-0">
              {guestsQuery.isLoading ? (
                <div className="p-8 text-center text-sm text-muted-foreground">Loading guests…</div>
              ) : data.length === 0 ? (
                <EmptyState icon={PauseCircle} title="No suspended guests" description="Suspended guests appear here and can be reactivated." />
              ) : (
                <div className="divide-y divide-border">
                  {(data as GuestRow[]).map((g) => (
                    <div key={g.id} className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                      <div className="min-w-0">
                        {renderDevice(g.device)}
                        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                          <GuestStatusBadge status={g.status} />
                          <span>Suspended {fmt(g.suspendedAt)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button size="sm" onClick={() => guestAction(g.id, 'reactivate', g.device.name || g.device.hostname)}>
                          <PlayCircle className="w-3.5 h-3.5" /> Reactivate
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => setRevokeTarget(g)}>
                          <PowerOff className="w-3.5 h-3.5" /> Revoke
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <PaginationControls currentPage={page} totalPages={totalPages} totalItems={total} onPageChange={setPage} pageSize={PAGE_SIZE} />
        </TabsContent>

        <TabsContent value="rejected-revoked" className="mt-4 space-y-4">
          <Card className="falcon-card p-0">
            <CardContent className="p-0">
              {guestsQuery.isLoading ? (
                <div className="p-8 text-center text-sm text-muted-foreground">Loading guests…</div>
              ) : data.length === 0 ? (
                <EmptyState icon={XCircle} title="No rejected or revoked guests" description="Closed guest enrollments appear here (read-only)." />
              ) : (
                <div className="divide-y divide-border">
                  {(data as GuestRow[]).map((g) => (
                    <div key={g.id} className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                      <div className="min-w-0">
                        {renderDevice(g.device)}
                        <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                          <GuestStatusBadge status={g.status} />
                          {g.status === 'REVOKED' && <span>Revoked {fmt(g.revokedAt)}</span>}
                          {g.status === 'REJECTED' && <span>Rejected {fmt(g.rejectedAt)}</span>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          <PaginationControls currentPage={page} totalPages={totalPages} totalItems={total} onPageChange={setPage} pageSize={PAGE_SIZE} />
        </TabsContent>
      </Tabs>

      {/* Convert dialog */}
      <Dialog open={convertTarget !== null} onOpenChange={(open) => { if (!open) setConvertTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convert Guest to Employee</DialogTitle>
            <DialogDescription>
              The guest's device, telemetry history and employee record are preserved. The guest record is removed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-medium">First Name *</Label>
              <Input value={convertForm.firstName} onChange={(e) => setConvertForm((f) => ({ ...f, firstName: e.target.value }))} />
            </div>
            <div>
              <Label className="text-xs font-medium">Last Name *</Label>
              <Input value={convertForm.lastName} onChange={(e) => setConvertForm((f) => ({ ...f, lastName: e.target.value }))} />
            </div>
            <div>
              <Label className="text-xs font-medium">Email *</Label>
              <Input type="email" value={convertForm.email} onChange={(e) => setConvertForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div>
              <Label className="text-xs font-medium">Employee ID (optional)</Label>
              <Input value={convertForm.employeeId} onChange={(e) => setConvertForm((f) => ({ ...f, employeeId: e.target.value }))} placeholder="Leave empty to keep the synthesized ID" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertTarget(null)}>Cancel</Button>
            <Button onClick={submitConvert} disabled={converting}>
              {converting ? 'Converting…' : 'Convert to Employee'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm revoke */}
      <AlertDialog open={revokeTarget !== null} onOpenChange={(open) => { if (!open) setRevokeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke guest access?</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget ? `This disables ${revokeTarget.device.name || revokeTarget.device.hostname} and invalidates its tokens immediately. This action cannot be undone.` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRevoke}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
