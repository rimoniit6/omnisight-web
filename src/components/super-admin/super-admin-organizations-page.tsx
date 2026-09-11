'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppStore, useAuthStore } from '@/lib/store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Building2,
  Search,
  Loader2,
  Archive,
  Pause,
  Play,
  Settings,
  Users,
  Monitor,
  AlertCircle,
  CheckCircle,
  Plus,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ErrorState } from './ui';

interface Organization {
  id: string;
  name: string;
  slug: string;
  status: string;
  deploymentMode: 'MANAGED' | 'CUSTOMER_DB' | 'PRIVATE';
  deploymentModeUnresolved: boolean;
  createdAt: string;
  memberCount: number;
  employeeCount: number;
  deviceCount: number;
  includedDevices: number;
  extraDevices: number;
  outstandingAmount: number;
  outstandingCurrency: string;
  daysRemaining: number | null;
  subscription: {
    id: string;
    status: string;
    endDate: string | null;
    plan: { id: string; name: string; currency: string; maxDevices: number };
    invoices: { id: string; status: string; amount: number; currency: string; paymentMethod: string | null; paidAt: string | null }[];
  } | null;
  licenseKey: { id: string; isActive: boolean; isRevoked: boolean; validUntil: string | null } | null;
}

const STATUS_CONFIG: Record<string, { label: string; className: string; icon: React.ElementType }> = {
  active: {
    label: 'Active',
    className: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400',
    icon: CheckCircle,
  },
  pending: {
    label: 'Pending',
    className: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-400',
    icon: AlertCircle,
  },
  suspended: {
    label: 'Suspended',
    className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400',
    icon: Pause,
  },
  archived: {
    label: 'Archived',
    className: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/30 dark:text-slate-400',
    icon: Archive,
  },
};

// Phase 2 §7: deployment-mode badge config for the control-plane list.
// PRIVATE is deprecated in V1 — kept in the map for backward-compat display
// but should not appear in new V1 workflows.
const MODE_CONFIG: Record<string, { label: string; className: string }> = {
  MANAGED: {
    label: 'Managed',
    className: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400',
  },
  CUSTOMER_DB: {
    label: 'Customer DB',
    className: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400',
  },
  PRIVATE: {
    label: 'Private (Deprecated)',
    className: 'bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-400',
  },
};

export function SuperAdminOrganizationsPage() {
  const [search, setSearch] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [statusDialog, setStatusDialog] = useState<{
    open: boolean;
    orgId: string;
    orgName: string;
    currentStatus: string;
    newStatus: string;
  }>({ open: false, orgId: '', orgName: '', currentStatus: '', newStatus: '' });

  const { setCurrentPage, setPageContext, setPageContextLabel } = useAppStore();
  const token = useAuthStore((s) => s.token);

  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [modeFilter, setModeFilter] = useState('');
  const pageSize = 20;

  const { data: orgsData, isLoading: loading, isError, refetch } = useQuery({
    queryKey: ['super-admin-organizations', search, statusFilter, modeFilter, page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);
      if (modeFilter) params.set('deploymentMode', modeFilter);
      const res = await fetch(`/api/super-admin/organizations?${params}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load');
      return await res.json();
    },
    placeholderData: (prev) => prev,
  });
  const organizations = (orgsData?.data || []) as Organization[];
  const pagination = orgsData?.pagination || { page: 1, pageSize: 20, total: 0, pages: 0 };

  // Control-plane metrics (Phase 2 §27): aggregate metadata only, never
  // cross-customer operational data.
  const { data: metricsData, isError: metricsError, isFetching: metricsFetching, refetch: refetchMetrics } = useQuery({
    queryKey: ['super-admin-metrics'],
    queryFn: async () => {
      const res = await fetch('/api/super-admin/metrics', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load metrics');
      return await res.json();
    },
    placeholderData: (prev) => prev,
  });
  // PRIVATE is deprecated in V1; metrics exclude it from customer-owned count.
  const metrics = metricsData as
    | {
        organizations: { total: number; managed: number; customerDb: number; private: number; unresolvedModes: number; pendingDeployments: number };
        subscriptions: { active: number; expiringSoon: number };
        licenses: { active: number };
        billing: { pendingInvoices: number };
      }
    | undefined;

  const handleStatusChange = async () => {
    if (!statusDialog.orgId || !statusDialog.newStatus) return;
    setActionLoading(statusDialog.orgId);
    try {
      const res = await fetch(`/api/super-admin/organizations/${statusDialog.orgId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        credentials: 'same-origin',
        body: JSON.stringify({ status: statusDialog.newStatus }),
      });
      if (res.ok) {
        toast.success(`Organization ${statusDialog.newStatus === 'active' ? 'reactivated' : statusDialog.newStatus}`);
        queryClient.invalidateQueries({ queryKey: ['super-admin-organizations'] });
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to update status');
      }
    } catch {
      toast.error('Network error');
    } finally {
      setActionLoading(null);
      setStatusDialog({ open: false, orgId: '', orgName: '', currentStatus: '', newStatus: '' });
    }
  };

  // Phase 2 §11: provisioning goes through the full flow (org + package +
  // admin + subscription + temp password) — never a bare name-only org.
  const openProvision = () => {
    setCurrentPage('sa-create-organization');
  };

  const filtered = organizations; // Server-side filtering now handles this

  const openManage = (org: Organization) => {
    // setCurrentPage clears pageContext — set it AFTER to avoid the clear.
    setCurrentPage('super-admin-organization-detail');
    setPageContext(org.id);
    setPageContextLabel(org.name);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Super Admin</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Platform-wide organization management. Manage lifecycle, status, and memberships.
          </p>
        </div>
        <Button onClick={openProvision} className="shrink-0">
          <Plus className="w-4 h-4 mr-2" />
          Provision Organization
        </Button>
      </div>

      {/* Stats — control-plane aggregates from /api/super-admin/metrics */}
      {metricsError && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-2.5">
          <p className="text-xs text-muted-foreground">Control-plane metrics are temporarily unavailable.</p>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => refetchMetrics()} disabled={metricsFetching}>
            {metricsFetching && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            Retry
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <Building2 className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{metrics?.organizations.total ?? '—'}</p>
                <p className="text-xs text-muted-foreground">Total Organizations</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <CheckCircle className="w-5 h-5 text-emerald-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{metrics?.organizations.managed ?? '—'}</p>
                <p className="text-xs text-muted-foreground">Managed</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <Monitor className="w-5 h-5 text-blue-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">
                  {metrics ? metrics.organizations.customerDb + metrics.organizations.private : '—'}
                </p>
                <p className="text-xs text-muted-foreground">Customer-Owned</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
                <AlertCircle className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{metrics?.billing.pendingInvoices ?? '—'}</p>
                <p className="text-xs text-muted-foreground">Pending Invoices</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <CardTitle className="text-base">Organizations</CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  className="pl-9 w-56"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                />
              </div>
              <Select value={statusFilter || 'all'} onValueChange={(v) => { setStatusFilter(v === 'all' ? '' : v); setPage(1); }}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
              <Select value={modeFilter || 'all'} onValueChange={(v) => { setModeFilter(v === 'all' ? '' : v); setPage(1); }}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="All modes" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Modes</SelectItem>
                  <SelectItem value="MANAGED">Managed</SelectItem>
                  <SelectItem value="CUSTOMER_DB">Customer DB</SelectItem>
                  <SelectItem value="PRIVATE">Private</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Loading organizations...</span>
            </div>
          ) : isError ? (
            <ErrorState title="Unable to load organizations" onRetry={() => refetch()} />
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Building2 className="w-12 h-12 text-muted-foreground/40 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">
                {search ? 'No organizations match your search' : 'No organizations yet'}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {search ? 'Try a different search term' : 'Create your first organization to get started'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organization</TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead>Package</TableHead>
                    <TableHead>Devices</TableHead>
                    <TableHead>Subscription</TableHead>
                    <TableHead>Dues</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-center">Users</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((org) => {
                    const statusConfig = STATUS_CONFIG[org.status] || STATUS_CONFIG.active;
                    const StatusIcon = statusConfig.icon;
                    const modeConfig = MODE_CONFIG[org.deploymentMode] || MODE_CONFIG.MANAGED;
                    return (
                      <TableRow key={org.id}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                              <Building2 className="w-4 h-4 text-primary" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-sm truncate">{org.name}</p>
                              <p className="text-xs text-muted-foreground truncate">{org.slug}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1 items-start">
                            <Badge variant="outline" className={cn('text-[10px] h-5 px-1.5 border', modeConfig.className)}>
                              {modeConfig.label}
                            </Badge>
                            {org.deploymentModeUnresolved && (
                              <span className="text-[10px] text-amber-600">needs review</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs font-medium">{org.subscription?.plan.name ?? '—'}</span>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs">
                            <span className={cn('font-medium', org.extraDevices > 0 ? 'text-amber-600' : '')}>
                              {org.deviceCount}
                            </span>
                            <span className="text-muted-foreground"> / {org.includedDevices}</span>
                            {org.extraDevices > 0 && (
                              <span className="ml-1 text-amber-600">(+{org.extraDevices})</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {org.subscription ? (
                            <div className="text-xs">
                              <Badge
                                variant="outline"
                                className={cn(
                                  'text-[10px] h-5 px-1.5 border',
                                  org.subscription.status === 'ACTIVE'
                                    ? 'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/30 dark:bg-emerald-900/30 dark:text-emerald-400'
                                    : org.subscription.status === 'PENDING'
                                      ? 'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/30 dark:bg-amber-900/30 dark:text-amber-400'
                                      : org.subscription.status === 'CANCELLED'
                                        ? 'border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400'
                                        : 'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/30 dark:bg-rose-900/30 dark:text-rose-400'
                                )}
                              >
                                {org.subscription.status}
                              </Badge>
                              {org.daysRemaining !== null && org.subscription.status === 'ACTIVE' && (
                                <p className="mt-0.5 text-muted-foreground">
                                  {org.daysRemaining <= 7
                                    ? `Expires in ${org.daysRemaining}d`
                                    : `${org.daysRemaining}d remaining`}
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {org.outstandingAmount > 0 ? (
                            <span className="text-xs font-medium text-amber-600">
                              {org.outstandingCurrency} {org.outstandingAmount.toLocaleString()}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">৳0</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('text-[10px] h-5 px-1.5 border', statusConfig.className)}>
                            <StatusIcon className="w-3 h-3 mr-1" />
                            {statusConfig.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <Users className="w-3.5 h-3.5 text-muted-foreground" />
                            <span className="text-sm">{org.memberCount}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs text-muted-foreground">
                            {new Date(org.createdAt).toLocaleDateString()}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 px-2 text-xs"
                              onClick={() => openManage(org)}
                            >
                              <Settings className="w-3.5 h-3.5 mr-1" />
                              Manage
                            </Button>
                            {org.status === 'active' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                                disabled={actionLoading === org.id}
                                onClick={() =>
                                  setStatusDialog({
                                    open: true,
                                    orgId: org.id,
                                    orgName: org.name,
                                    currentStatus: 'active',
                                    newStatus: 'suspended',
                                  })
                                }
                              >
                                {actionLoading === org.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <>
                                    <Pause className="w-3.5 h-3.5 mr-1" />
                                    Suspend
                                  </>
                                )}
                              </Button>
                            )}
                            {org.status === 'suspended' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50"
                                disabled={actionLoading === org.id}
                                onClick={() =>
                                  setStatusDialog({
                                    open: true,
                                    orgId: org.id,
                                    orgName: org.name,
                                    currentStatus: 'suspended',
                                    newStatus: 'active',
                                  })
                                }
                              >
                                {actionLoading === org.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <>
                                    <Play className="w-3.5 h-3.5 mr-1" />
                                    Reactivate
                                  </>
                                )}
                              </Button>
                            )}
                            {(org.status === 'active' || org.status === 'suspended') && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 px-2 text-xs text-slate-600 hover:text-slate-700 hover:bg-slate-50"
                                disabled={actionLoading === org.id}
                                onClick={() =>
                                  setStatusDialog({
                                    open: true,
                                    orgId: org.id,
                                    orgName: org.name,
                                    currentStatus: org.status,
                                    newStatus: 'archived',
                                  })
                                }
                              >
                                <Archive className="w-3.5 h-3.5 mr-1" />
                                Archive
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {/* Pagination */}
          {pagination.pages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t">
              <p className="text-xs text-muted-foreground">
                Showing {((pagination.page - 1) * pagination.pageSize) + 1}–{Math.min(pagination.page * pagination.pageSize, pagination.total)} of {pagination.total}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-xs text-muted-foreground px-2">
                  Page {pagination.page} of {pagination.pages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-8 p-0"
                  disabled={page >= pagination.pages}
                  onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Status Change Dialog */}
      <Dialog open={statusDialog.open} onOpenChange={(open) => !open && setStatusDialog({ ...statusDialog, open: false })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {statusDialog.newStatus === 'active'
                ? 'Reactivate Organization'
                : statusDialog.newStatus === 'suspended'
                  ? 'Suspend Organization'
                  : 'Archive Organization'}
            </DialogTitle>
            <DialogDescription>
              {statusDialog.newStatus === 'active'
                ? `Reactivate "${statusDialog.orgName}"? Members will regain access immediately.`
                : statusDialog.newStatus === 'suspended'
                  ? `Suspend "${statusDialog.orgName}"? All active web sessions will be blocked. Agents will be denied.`
                  : `Archive "${statusDialog.orgName}"? This is a permanent status change. All sessions will be blocked.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatusDialog({ ...statusDialog, open: false })}>
              Cancel
            </Button>
            <Button
              variant={statusDialog.newStatus === 'active' ? 'default' : 'destructive'}
              disabled={actionLoading === statusDialog.orgId}
              onClick={handleStatusChange}
            >
              {actionLoading === statusDialog.orgId && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {statusDialog.newStatus === 'active' ? 'Reactivate' : statusDialog.newStatus === 'suspended' ? 'Suspend' : 'Archive'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
