'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Database, HardDrive, CheckCircle2, XCircle, Clock, AlertTriangle, Eye } from 'lucide-react';
import { toast } from 'sonner';
import { useCurrentUser } from '@/hooks/use-current-user';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { useAppStore } from '@/lib/store';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface InfraRequest {
  id: string;
  organizationId: string;
  kind: string;
  requestNo: number;
  status: string;
  config: Record<string, unknown>;
  hasSecret: boolean;
  secretLast4: string | null;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  lastTestedAt: string | null;
  requestedByEmail: string;
  requestedAt: string;
  approvedByEmail: string | null;
  approvedAt: string | null;
  approvalNote: string | null;
  rejectedByEmail: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  cancelledByEmail: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  errorMessage: string | null;
  activatedAt: string | null;
  organization?: { name: string; slug: string };
  migration?: MigrationView | null;
}

interface MigrationView {
  id: string;
  kind: string;
  status: string;
  recordsDone: number;
  recordsTotal: number;
  objectsDone: number;
  objectsTotal: number;
  bytesDone: string;
  bytesTotal: string;
  currentTable: string | null;
  errorStage: string | null;
  errorMessage: string | null;
  verifiedAt: string | null;
  activatedAt: string | null;
}

function MigrationProgressInline({ migration }: { migration: MigrationView }) {
  const meta: Record<string, { label: string; className: string }> = {
    queued: { label: 'Migration queued', className: 'bg-blue-500/15 text-blue-600' },
    migrating: { label: 'Migrating', className: 'bg-violet-500/15 text-violet-600' },
    reconciling: { label: 'Synchronizing', className: 'bg-violet-500/15 text-violet-600' },
    verifying: { label: 'Verifying', className: 'bg-amber-500/15 text-amber-600' },
    ready_to_activate: { label: 'Ready to activate', className: 'bg-emerald-500/15 text-emerald-600' },
    activated: { label: 'Activated', className: 'bg-emerald-500/15 text-emerald-600' },
    failed: { label: 'Migration failed', className: 'bg-rose-500/15 text-rose-600' },
    cancelled: { label: 'Cancelled', className: 'bg-slate-500/15 text-slate-600' },
  };
  const info = meta[migration.status] ?? { label: migration.status, className: '' };
  const pct =
    migration.recordsTotal > 0
      ? Math.min(100, Math.round((migration.recordsDone / migration.recordsTotal) * 100))
      : migration.objectsTotal > 0
        ? Math.min(100, Math.round((migration.objectsDone / migration.objectsTotal) * 100))
        : null;
  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-muted/30 p-2.5">
      <div className="flex items-center justify-between">
        <Badge className={info.className}>{info.label}</Badge>
        {pct !== null && <span className="text-xs text-muted-foreground">{pct}%</span>}
      </div>
      {pct !== null && (
        <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="mt-1.5 text-xs text-muted-foreground">
        {migration.kind === 'DATABASE'
          ? `${migration.recordsDone.toLocaleString()} / ${migration.recordsTotal.toLocaleString()} records${migration.currentTable ? ` · copying ${migration.currentTable}` : ''}`
          : `${migration.objectsDone.toLocaleString()} / ${migration.objectsTotal.toLocaleString()} objects`}
      </div>
      {migration.status === 'failed' && migration.errorMessage && (
        <div className="mt-1 text-xs text-rose-600">Reason: {migration.errorMessage}</div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    submitted: { label: 'Pending Review', className: 'bg-amber-500/15 text-amber-600' },
    approved: { label: 'Approved', className: 'bg-blue-500/15 text-blue-600' },
    applied: { label: 'Migrating', className: 'bg-violet-500/15 text-violet-600' },
    active: { label: 'Active', className: 'bg-emerald-500/15 text-emerald-600' },
    rejected: { label: 'Rejected', className: 'bg-rose-500/15 text-rose-600' },
    cancelled: { label: 'Cancelled', className: 'bg-slate-500/15 text-slate-600' },
    superseded: { label: 'Superseded', className: 'bg-slate-500/15 text-slate-600' },
  };
  const info = map[status] ?? { label: status, className: '' };
  return <Badge className={info.className}>{info.label}</Badge>;
}

function KindIcon({ kind }: { kind: string }) {
  return kind === 'DATABASE' ? (
    <Database className="h-4 w-4 text-blue-500" />
  ) : (
    <HardDrive className="h-4 w-4 text-violet-500" />
  );
}

export function SaInfraRequestsPage() {
  const { user, isLoading: authLoading } = useCurrentUser();
  const setCurrentPage = useAppStore((s) => s.setCurrentPage);
  const queryClient = useQueryClient();

  const [detailId, setDetailId] = useState<string | null>(null);
  const [approveNote, setApproveNote] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [actionMode, setActionMode] = useState<'approve' | 'reject' | null>(null);

  useEffect(() => {
    if (!authLoading && user && user.role !== 'super_admin') {
      setCurrentPage('dashboard');
    }
  }, [authLoading, user, setCurrentPage]);

  const requestsQuery = useQuery<{ data: { pending: InfraRequest[]; pendingCount: number; recent: InfraRequest[] } }>({
    queryKey: ['sa-infra-requests'],
    queryFn: async () => {
      const res = await fetch('/api/admin/infrastructure-requests?limit=50', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load requests');
      return res.json();
    },
    enabled: !!user && user.role === 'super_admin',
    staleTime: 15_000,
  });

  const detailQuery = useQuery<{ data: { request: InfraRequest; organization: { id: string; name: string; slug: string } } }>({
    queryKey: ['sa-infra-request-detail', detailId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/infrastructure-requests/${detailId}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load request detail');
      return res.json();
    },
    enabled: !!detailId,
  });

  const approveMutation = useMutation({
    mutationFn: async ({ id, note }: { id: string; note?: string }) => {
      const res = await fetch(`/api/admin/infrastructure-requests/${id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ note }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Approval failed');
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Change request approved — organization data migration queued');
      queryClient.invalidateQueries({ queryKey: ['sa-infra-requests'] });
      setDetailId(null);
      setActionMode(null);
      setApproveNote('');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const res = await fetch(`/api/admin/infrastructure-requests/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Rejection failed');
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Change request rejected');
      queryClient.invalidateQueries({ queryKey: ['sa-infra-requests'] });
      setDetailId(null);
      setActionMode(null);
      setRejectReason('');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const activateMutation = useMutation({
    mutationFn: async (migrationId: string) => {
      const res = await fetch(`/api/admin/infrastructure-migrations/${migrationId}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Activation failed');
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Infrastructure activated — the organization is now using the new configuration.');
      queryClient.invalidateQueries({ queryKey: ['sa-infra-requests'] });
      queryClient.invalidateQueries({ queryKey: ['sa-infra-request-detail'] });
      setDetailId(null);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const retryMigrationMutation = useMutation({
    mutationFn: async (migrationId: string) => {
      const res = await fetch(`/api/admin/infrastructure-migrations/${migrationId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Retry failed');
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Migration re-queued — already-copied data is reused.');
      queryClient.invalidateQueries({ queryKey: ['sa-infra-requests'] });
      queryClient.invalidateQueries({ queryKey: ['sa-infra-request-detail'] });
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background p-8">
        <Skeleton className="h-10 w-72 mb-6" />
        <Skeleton className="h-56 w-full mb-6 rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!user || user.role !== 'super_admin') return null;

  const pending = requestsQuery.data?.data?.pending ?? [];
  const recent = requestsQuery.data?.data?.recent ?? [];
  const detail = detailQuery.data?.data;

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Infrastructure Change Requests</h1>
        <p className="mt-1.5 text-muted-foreground">
          Review and approve organization database and storage change requests.
        </p>
      </div>

      {/* Pending Queue */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-amber-500" />
            Pending Review
            {pending.length > 0 && (
              <Badge className="bg-amber-500/15 text-amber-600 ml-2">{pending.length}</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Change requests awaiting your approval. Approving triggers connection verification and the org-scoped switch.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No pending requests</p>
          ) : (
            <div className="space-y-3">
              {pending.map((req) => (
                <RequestRow
                  key={req.id}
                  request={req}
                  onDetail={() => setDetailId(req.id)}
                  onApprove={() => { setDetailId(req.id); setActionMode('approve'); }}
                  onReject={() => { setDetailId(req.id); setActionMode('reject'); }}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent / History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
            Recent Activity
          </CardTitle>
          <CardDescription>Previously processed requests</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No recent activity</p>
          ) : (
            <div className="space-y-2">
              {recent.map((req) => (
                <RequestRow
                  key={req.id}
                  request={req}
                  onDetail={() => setDetailId(req.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail Dialog */}
      <Dialog open={!!detailId} onOpenChange={(open) => { if (!open) { setDetailId(null); setActionMode(null); } }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          {detailQuery.isLoading ? (
            <div className="py-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></div>
          ) : detail ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <KindIcon kind={detail.request.kind} />
                  Change Request #{detail.request.requestNo}
                </DialogTitle>
                <DialogDescription>
                  {detail.organization.name} ({detail.organization.slug}) — {detail.request.kind}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <StatusBadge status={detail.request.status} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Requested by</span>
                  <span>{detail.request.requestedByEmail}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Requested at</span>
                  <span>{new Date(detail.request.requestedAt).toLocaleString()}</span>
                </div>

                {detail.request.lastTestStatus && (
                  <div className="rounded-lg border p-3">
                    <div className="font-medium mb-1">Last Connection Test</div>
                    <div className="flex items-center gap-2">
                      {detail.request.lastTestStatus === 'success' ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      ) : detail.request.lastTestStatus === 'failed' ? (
                        <XCircle className="h-4 w-4 text-rose-500" />
                      ) : (
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      )}
                      <span>{detail.request.lastTestMessage || 'No message'}</span>
                    </div>
                    {detail.request.lastTestedAt && (
                      <div className="text-xs text-muted-foreground mt-1">
                        Tested {new Date(detail.request.lastTestedAt).toLocaleString()}
                      </div>
                    )}
                  </div>
                )}

                {detail.request.errorMessage && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-700">
                    <div className="font-medium mb-1">Error</div>
                    <div>{detail.request.errorMessage}</div>
                  </div>
                )}

                {detail.request.approvedByEmail && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Approved by</span>
                    <span>{detail.request.approvedByEmail}</span>
                  </div>
                )}

                {detail.request.rejectionReason && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-rose-700">
                    <div className="font-medium mb-1">Rejection Reason</div>
                    <div>{detail.request.rejectionReason}</div>
                  </div>
                )}

                {detail.request.cancellationReason && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-slate-700">
                    <div className="font-medium mb-1">Cancellation Reason</div>
                    <div>{detail.request.cancellationReason}</div>
                  </div>
                )}

                {/* Config Summary */}
                <div className="rounded-lg border p-3">
                  <div className="font-medium mb-2">Requested Configuration</div>
                  <div className="space-y-1 text-xs font-mono">
                    {detail.request.kind === 'DATABASE' ? (
                      <>
                        <div>Host: {String(detail.request.config.host ?? 'N/A')}</div>
                        <div>Port: {String(detail.request.config.port ?? '5432')}</div>
                        <div>Database: {String(detail.request.config.name ?? 'N/A')}</div>
                        <div>User: {String(detail.request.config.user ?? 'N/A')}</div>
                        <div>SSL: {detail.request.config.ssl ? 'Yes' : 'No'}</div>
                        <div>Password: {detail.request.hasSecret ? `••••${detail.request.secretLast4 ?? ''}` : 'Not set'}</div>
                      </>
                    ) : (
                      <>
                        <div>Driver: {String(detail.request.config.driver ?? 'N/A')}</div>
                        <div>URL: {String(detail.request.config.url ?? 'N/A')}</div>
                        <div>Key: {detail.request.hasSecret ? `••••${detail.request.secretLast4 ?? ''}` : 'Not set'}</div>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Data Migration progress + Activate / Retry (real progress only) */}
              {detail.request.migration && (
                <div>
                  <div className="font-medium mb-1.5">Data Migration</div>
                  <MigrationProgressInline migration={detail.request.migration} />
                  <div className="mt-2 flex gap-2">
                    {detail.request.migration.status === 'ready_to_activate' && (
                      <Button
                        size="sm"
                        onClick={() => activateMutation.mutate(detail.request.migration!.id)}
                        disabled={activateMutation.isPending}
                      >
                        {activateMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                        Activate
                      </Button>
                    )}
                    {detail.request.migration.status === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => retryMigrationMutation.mutate(detail.request.migration!.id)}
                        disabled={retryMigrationMutation.isPending}
                      >
                        {retryMigrationMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Retry Migration
                      </Button>
                    )}
                  </div>
                </div>
              )}

              {/* Approve / Reject Actions */}
              {(detail.request.status === 'submitted' || (detail.request.status === 'approved' && detail.request.errorMessage)) && (
                <DialogFooter className="flex-col sm:flex-row gap-3 pt-4 border-t">
                  {actionMode === 'approve' ? (
                    <div className="w-full space-y-3">
                      <Label htmlFor="approve-note">Approval Note (optional)</Label>
                      <Textarea
                        id="approve-note"
                        value={approveNote}
                        onChange={(e) => setApproveNote(e.target.value)}
                        placeholder="Optional note for the approval..."
                        rows={2}
                      />
                      <div className="flex gap-3 justify-end">
                        <Button variant="outline" onClick={() => setActionMode(null)}>Cancel</Button>
                        <Button
                          onClick={() => approveMutation.mutate({ id: detail.request.id, note: approveNote || undefined })}
                          disabled={approveMutation.isPending}
                        >
                          {approveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                          Confirm Approval
                        </Button>
                      </div>
                    </div>
                  ) : actionMode === 'reject' ? (
                    <div className="w-full space-y-3">
                      <Label htmlFor="reject-reason">Rejection Reason (required)</Label>
                      <Textarea
                        id="reject-reason"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Explain why this request is being rejected..."
                        rows={2}
                      />
                      <div className="flex gap-3 justify-end">
                        <Button variant="outline" onClick={() => setActionMode(null)}>Cancel</Button>
                        <Button
                          variant="destructive"
                          onClick={() => rejectMutation.mutate({ id: detail.request.id, reason: rejectReason })}
                          disabled={rejectMutation.isPending || !rejectReason.trim()}
                        >
                          {rejectMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
                          Confirm Rejection
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex gap-3 justify-end w-full">
                      <Button
                        variant="destructive"
                        onClick={() => setActionMode('reject')}
                      >
                        <XCircle className="mr-2 h-4 w-4" /> Reject
                      </Button>
                      <Button
                        onClick={() => setActionMode('approve')}
                      >
                        <CheckCircle2 className="mr-2 h-4 w-4" /> Approve
                      </Button>
                    </div>
                  )}
                </DialogFooter>
              )}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RequestRow({
  request,
  onDetail,
  onApprove,
  onReject,
}: {
  request: InfraRequest;
  onDetail: () => void;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border/60 p-3 hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <KindIcon kind={request.kind} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">
              {request.organization?.name ?? request.organizationId}
            </span>
            <span className="text-xs text-muted-foreground">#{request.requestNo}</span>
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {request.kind} · by {request.requestedByEmail} · {new Date(request.requestedAt).toLocaleDateString()}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {request.migration && (request.migration.status === 'migrating' || request.migration.status === 'reconciling' || request.migration.status === 'verifying') && (
          <span className="flex items-center gap-1 text-xs text-violet-600">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> {request.migration.status === 'reconciling' ? 'synchronizing' : 'migrating'}
          </span>
        )}
        <StatusBadge status={request.status} />
        <Button variant="ghost" size="sm" onClick={onDetail} className="h-8 px-2">
          <Eye className="h-4 w-4" />
        </Button>
        {onApprove && (request.status === 'submitted' || (request.status === 'approved' && request.errorMessage)) && (
          <Button variant="ghost" size="sm" onClick={onApprove} className="h-8 px-2 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50">
            <CheckCircle2 className="h-4 w-4" />
          </Button>
        )}
        {onReject && request.status === 'submitted' && (
          <Button variant="ghost" size="sm" onClick={onReject} className="h-8 px-2 text-rose-600 hover:text-rose-700 hover:bg-rose-50">
            <XCircle className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
