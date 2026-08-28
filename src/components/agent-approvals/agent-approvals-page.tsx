'use client';

import { useState, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { QuickStats, type QuickStat } from '@/components/ui/quick-stats';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
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
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Cpu,
  HardDrive,
  Globe,
  Network,
  User,
  Building2,
  ChevronRight,
  Loader2,
  Fingerprint,
  Laptop,
  FolderKanban,
  PowerOff,
  Search,
  PauseCircle,
  PlayCircle,
  ArrowRightLeft,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { EmployeeCombobox, type EmployeeOption } from '@/components/employees/employee-combobox';
import { toast } from 'sonner';
import { getPermissionDeniedMessage } from '@/lib/permissions';

interface EmployeeData {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  designation?: string;
  status: string;
  department?: { id: string; name: string } | null;
}



// ─── Zero-touch device claim types ──────────────────────────────────────────
interface ClaimEmployee {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  status: string;
  departmentId: string | null;
  department: { id: string; name: string } | null;
}

interface GuestData {
  id: string;
  deviceId: string;
  employeeId: string;
  status: string; // ACTIVE | SUSPENDED | REVOKED | REJECTED
  approvedAt: string | null;
  suspendedAt: string | null;
  revokedAt: string | null;
}

interface DeviceClaimData {
  id: string;
  deviceId: string;
  status: string; // pending | approved | rejected | revoked
  createdAt: string;
  expiresAt: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  device: {
    id: string;
    name: string;
    hostname: string;
    operatingSystem: string | null;
    osVersion: string | null;
    processor: string | null;
    memory: string | null;
    agentVersion: string | null;
    status: string;
    lastHeartbeat: string | null;
    registeredAt: string;
  };
  employee: ClaimEmployee | null;
  projects: Array<{ id: string; name: string; status: string; color: string; role: string }>;
  // Guest enrichment (populated client-side from /api/guests)
  guestId?: string;
  guestStatus?: string;
}

const statusConfig: Record<string, { icon: React.ElementType; color: string; bg: string; borderAccent: string; label: string }> = {
  pending: { icon: Clock, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20', borderAccent: 'border-l-amber-400', label: 'Pending' },
  approved: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20', borderAccent: 'border-l-emerald-400', label: 'Approved' },
  rejected: { icon: XCircle, color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20', borderAccent: 'border-l-rose-400', label: 'Rejected' },
  revoked: { icon: PowerOff, color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-900/20', borderAccent: 'border-l-gray-400', label: 'Revoked' },
  expired: { icon: XCircle, color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-900/20', borderAccent: 'border-l-gray-400', label: 'Expired' },
};

const claimStatusConfig: Record<string, { icon: React.ElementType; color: string; bg: string; borderAccent: string; label: string }> = {
  pending: { icon: Clock, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20', borderAccent: 'border-l-amber-400', label: 'Pending Assignment' },
  approved: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20', borderAccent: 'border-l-emerald-400', label: 'Active' },
  rejected: { icon: XCircle, color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20', borderAccent: 'border-l-rose-400', label: 'Rejected' },
  revoked: { icon: PowerOff, color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-900/20', borderAccent: 'border-l-gray-400', label: 'Revoked' },
  cancelled: { icon: XCircle, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/20', borderAccent: 'border-l-blue-400', label: 'Cancelled' },
  expired: { icon: XCircle, color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-900/20', borderAccent: 'border-l-gray-400', label: 'Expired' },
};

function getTimeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = now - then;
  const diffMin = diffMs / (1000 * 60);
  const diffHours = diffMin / 60;
  const diffDays = diffHours / 24;

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${Math.floor(diffMin)}m ago`;
  if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
  if (diffDays < 7) return `${Math.floor(diffDays)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function SystemInfoRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value?: string | null }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground min-w-[90px]">{label}</span>
      <span className="font-medium truncate">{value || '—'}</span>
    </div>
  );
}

// ─── Zero-touch devices tab ─────────────────────────────────────────────────
function ZeroTouchDevicesTab() {
  const queryClient = useQueryClient();
  const [claimFilter, setClaimFilter] = useState('pending');
  const [claimPage, setClaimPage] = useState(1);
  const [claimSearchInput, setClaimSearchInput] = useState('');
  const [claimSearch, setClaimSearch] = useState('');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<DeviceClaimData | null>(null);
  const [rejectTarget, setRejectTarget] = useState<DeviceClaimData | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<DeviceClaimData | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [revokeReason, setRevokeReason] = useState('');
  // Guest lifecycle state
  const [guestActionTarget, setGuestActionTarget] = useState<{ id: string; action: 'suspend' | 'reactivate' | 'revoke'; hostname: string } | null>(null);
  const [guestActionReason, setGuestActionReason] = useState('');
  const [convertTarget, setConvertTarget] = useState<DeviceClaimData | null>(null);
  const [convertForm, setConvertForm] = useState({ firstName: '', lastName: '', email: '', employeeId: '' });
  const [converting, setConverting] = useState(false);
  // Approval dialog state
  const [approveMode, setApproveMode] = useState<'employee' | 'guest'>('employee');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeOption | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);

  // Debounced server-side search (the list itself is org-scoped server-side).
  // A new committed term restarts at page 1 — the filter reset lives in the
  // Select's onValueChange handler below.
  useEffect(() => {
    const t = setTimeout(() => {
      const trimmed = claimSearchInput.trim().slice(0, 100);
      if (trimmed !== claimSearch) {
        setClaimSearch(trimmed);
        setClaimPage(1);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [claimSearchInput, claimSearch]);

  const { data, isLoading } = useQuery({
    queryKey: ['device-claims', claimFilter, claimSearch, claimPage],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (claimFilter && claimFilter !== 'all') params.set('status', claimFilter);
      if (claimSearch) params.set('q', claimSearch);
      params.set('page', String(claimPage));
      params.set('pageSize', '10');
      const res = await fetch(`/api/device-claims?${params}`);
      if (!res.ok) throw new Error('Failed to fetch device claims');
      return res.json();
    },
  });

  // Fetch active guests to enrich approved guest claims with lifecycle data
  const { data: guestsData } = useQuery({
    queryKey: ['guests', 'approval-enrichment'],
    queryFn: async () => {
      const res = await fetch('/api/guests?pageSize=200');
      if (!res.ok) return { data: [] };
      return res.json();
    },
    staleTime: 30_000,
  });

  // Build a deviceId → guest lookup map for quick enrichment
  const guestByDeviceId = useMemo(() => {
    const map = new Map<string, GuestData>();
    for (const g of (guestsData?.data ?? []) as GuestData[]) {
      map.set(g.deviceId, g);
    }
    return map;
  }, [guestsData]);

  // Server-side status counts (groupBy) — complete queue, never a first-page
  // projection. Prefix-invalidated by the realtime device-claim event.
  const { data: summaryData } = useQuery({
    queryKey: ['device-claims', 'summary'],
    queryFn: async () => {
      const res = await fetch('/api/device-claims?summary=true');
      if (!res.ok) throw new Error('Failed to fetch device claim stats');
      return res.json();
    },
  });

  const { data: projects } = useQuery({
    queryKey: ['projects', 'claim-assign'],
    queryFn: async () => {
      const res = await fetch('/api/projects?pageSize=200');
      if (!res.ok) throw new Error('Failed to fetch projects');
      return res.json();
    },
  });

  // Enrich approved claims with guest data
  const claims: DeviceClaimData[] = useMemo(() => {
    const raw: DeviceClaimData[] = data?.data || [];
    return raw.map((claim) => {
      if (claim.status === 'approved') {
        const guest = guestByDeviceId.get(claim.deviceId);
        if (guest) {
          return { ...claim, guestId: guest.id, guestStatus: guest.status };
        }
      }
      return claim;
    });
  }, [data?.data, guestByDeviceId]);
  const summary = summaryData?.summary;

  const pendingCount = summary?.pending ?? 0;
  const approvedCount = summary?.approved ?? 0;
  const rejectedCount = (summary?.rejected ?? 0) + (summary?.revoked ?? 0);
  const cancelledCount = summary?.cancelled ?? 0;
  const expiredCount = summary?.expired ?? 0;

  const stats: QuickStat[] = [
    { label: 'Pending Devices', value: pendingCount, icon: Laptop, color: 'amber' },
    { label: 'Active Devices', value: approvedCount, icon: CheckCircle2, color: 'emerald' },
    { label: 'Rejected/Revoked', value: rejectedCount, icon: ShieldX, color: 'rose' },
    { label: 'Cancelled', value: cancelledCount, icon: XCircle, color: 'blue' },
    { label: 'Expired', value: expiredCount, icon: Clock, color: 'default' },
  ];

  const assignableProjects = useMemo(
    () => (projects?.data || []).filter((p: { status: string }) => p.status === 'active' || p.status === 'on_hold'),
    [projects]
  );

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['device-claims'] });
    queryClient.invalidateQueries({ queryKey: ['employees'] });
    queryClient.invalidateQueries({ queryKey: ['devices'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    queryClient.invalidateQueries({ queryKey: ['guests'] });
  };

  const openApprove = (claim: DeviceClaimData) => {
    setApproveTarget(claim);
    setApproveMode('employee');
    setSelectedEmployeeId(claim.employee?.id || '');
    setSelectedEmployee(
      claim.employee
        ? {
            id: claim.employee.id,
            employeeId: claim.employee.employeeId,
            firstName: claim.employee.firstName,
            lastName: claim.employee.lastName,
            email: claim.employee.email,
            designation: null,
            avatar: null,
            departmentName: claim.employee.department?.name ?? null,
          }
        : null
    );
    setSelectedProjectIds(claim.projects.map((p) => p.id));
  };

  const handleApprove = async () => {
    if (!approveTarget) return;
    if (approveMode === 'employee' && !selectedEmployeeId) {
      toast.error('Please select an employee to assign this device to');
      return;
    }
    setActionLoading(approveTarget.id);
    try {
      const body =
        approveMode === 'guest'
          ? { mode: 'guest' }
          : { mode: 'employee', employeeId: selectedEmployeeId, projectIds: selectedProjectIds };
      const res = await fetch(`/api/device-claims/${approveTarget.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to approve device');
      }
      if (approveMode === 'guest') {
        toast.success('Device approved as guest — enrolled without employee credentials, monitoring consent auto-granted');
      } else {
        const emp = selectedEmployee;
        toast.success(`Device approved and assigned to ${emp ? `${emp.firstName} ${emp.lastName}` : 'employee'}`);
      }
      invalidateAll();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to approve device');
    } finally {
      setActionLoading(null);
      setApproveTarget(null);
    }
  };

  const handleReject = async () => {
    if (!rejectTarget) return;
    setActionLoading(rejectTarget.id);
    try {
      const res = await fetch(`/api/device-claims/${rejectTarget.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: rejectReason || undefined }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to reject device');
      }
      toast.success('Device claim rejected');
      invalidateAll();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to reject device');
    } finally {
      setActionLoading(null);
      setRejectTarget(null);
      setRejectReason('');
    }
  };

  // ─── Employee-mode device revoke (device claim revoke) ───────────────────
  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setActionLoading(revokeTarget.id);
    try {
      const res = await fetch(`/api/device-claims/${revokeTarget.id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: revokeReason || undefined }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to revoke device');
      }
      toast.success('Device access revoked');
      invalidateAll();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to revoke device');
    } finally {
      setActionLoading(null);
      setRevokeTarget(null);
      setRevokeReason('');
    }
  };

  // ─── Guest lifecycle handlers ───────────────────────────────────────────

  const handleGuestAction = async () => {
    if (!guestActionTarget) return;
    setActionLoading(guestActionTarget.id);
    try {
      const res = await fetch(`/api/guests/${guestActionTarget.id}/${guestActionTarget.action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: guestActionReason || undefined }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `Failed to ${guestActionTarget.action} guest`);
      }
      const actionLabel = guestActionTarget.action === 'suspend' ? 'Suspended' : guestActionTarget.action === 'reactivate' ? 'Reactivated' : 'Revoked';
      toast.success(`${actionLabel} guest — ${guestActionTarget.hostname}`);
      invalidateAll();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Guest action failed');
    } finally {
      setActionLoading(null);
      setGuestActionTarget(null);
      setGuestActionReason('');
    }
  };

  const openConvert = (claim: DeviceClaimData) => {
    setConvertTarget(claim);
    setConvertForm({
      firstName: claim.employee?.firstName === 'Guest' ? '' : (claim.employee?.firstName ?? ''),
      lastName: claim.employee?.lastName === claim.device.hostname ? '' : (claim.employee?.lastName ?? ''),
      email: claim.employee?.email && !claim.employee.email.endsWith('@guests.invalid') ? claim.employee.email : '',
      employeeId: claim.employee?.employeeId?.startsWith('GUEST-') ? '' : (claim.employee?.employeeId ?? ''),
    });
  };

  const submitConvert = async () => {
    if (!convertTarget?.guestId) return;
    if (!convertForm.firstName.trim() || !convertForm.lastName.trim() || !convertForm.email.trim()) {
      toast.error('First name, last name and email are required');
      return;
    }
    setConverting(true);
    try {
      const res = await fetch(`/api/guests/${convertTarget.guestId}/convert`, {
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
      if (!res.ok) {
        if (res.status === 403) {
          const permissionMsg = getPermissionDeniedMessage('guests.manage', '');
          toast.error(permissionMsg.title, { description: permissionMsg.message });
        } else {
          toast.error(body.error || 'Failed to convert guest');
        }
        return;
      }
      toast.success('Guest converted to employee — telemetry history preserved');
      setConvertTarget(null);
      invalidateAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to convert guest');
    } finally {
      setConverting(false);
    }
  };

  const toggleProject = (projectId: string) => {
    setSelectedProjectIds((prev) =>
      prev.includes(projectId) ? prev.filter((id) => id !== projectId) : [...prev, projectId]
    );
  };

  return (
    <div className="space-y-4" role="region" aria-label="Agent Approvals">
      <QuickStats stats={stats} />

      {/* Filters */}
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-medium text-muted-foreground">
            {claimFilter === 'all' ? 'All Devices' : `${claimStatusConfig[claimFilter]?.label || claimFilter} Devices`}
            <span className="ml-2 text-xs text-muted-foreground/60">({data?.total ?? 0})</span>
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              value={claimSearchInput}
              onChange={(e) => setClaimSearchInput(e.target.value)}
              placeholder="Search device, hostname, employee…"
              className="h-8 w-56 pl-8 text-xs"
            />
          </div>
          <Select
            value={claimFilter}
            onValueChange={(value) => {
              setClaimFilter(value);
              setClaimPage(1);
            }}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Filter Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending Assignment</SelectItem>
              <SelectItem value="approved">Active</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="revoked">Revoked</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
              <SelectItem value="all">All Status</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Info banner: zero-touch means no employee action required */}
      <div className="flex items-start gap-2 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/15 rounded-md p-3">
        <Fingerprint className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          These devices registered themselves automatically — the employee never entered credentials.
          Assign the device to an employee, or approve it as a guest (no employee account required).
          Department comes from the employee; guests get no monitoring consent by default.
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 bg-muted/30 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : claims.length === 0 ? (
        <EmptyState
          icon={Laptop}
          title="No devices found"
          description={claimFilter === 'pending'
            ? 'No pending devices. New devices appear here automatically when the agent runs.'
            : 'No devices match your current filter.'}
        />
      ) : (
        <div className="space-y-3">
          <AnimatePresence mode="popLayout">
            {claims.map((claim, idx) => {
              const sc = claimStatusConfig[claim.status] || claimStatusConfig.pending;
              const Icon = sc.icon;
              // A pending claim is actionable only while it is inside its
              // redemption window — the server flips expired rows on read, but
              // this client-side guard also hides the actions for a claim that
              // expired between the fetch and the render (no stale approve).
              const isPending = claim.status === 'pending' && (!claim.expiresAt || new Date(claim.expiresAt).getTime() > Date.now());
              const isExpired = claim.status === 'expired' || (claim.status === 'pending' && claim.expiresAt && new Date(claim.expiresAt).getTime() <= Date.now());
              const isApproved = claim.status === 'approved';
              const deviceName = claim.device.name || claim.device.hostname || 'Unknown device';

              return (
                <motion.div
                  key={claim.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -12 }}
                  transition={{ duration: 0.25, delay: idx * 0.05 }}
                >
                  <Card className={`border shadow-sm border-l-4 ${sc.borderAccent} overflow-hidden`}>
                    <CardContent className="p-4 md:p-5">
                      <div className="flex flex-col lg:flex-row lg:items-start gap-4">
                        {/* Left: Device Identity */}
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          <div className={`h-10 w-10 rounded-lg ${sc.bg} flex items-center justify-center shrink-0`}>
                            <Icon className={`w-5 h-5 ${sc.color}`} />
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="text-sm font-semibold">{deviceName}</h3>
                              <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-mono">
                                {claim.deviceId.slice(0, 8)}…
                              </Badge>
                              <Badge className={`${sc.bg} ${sc.color} border-0 text-[10px] h-5 px-1.5`} variant="secondary">
                                {sc.label}
                              </Badge>
                            </div>

                            <div className="flex items-center gap-4 mt-1.5 text-xs text-muted-foreground flex-wrap">
                              {claim.employee ? (
                                <span className="flex items-center gap-1">
                                  <User className="w-3 h-3" />
                                  {claim.employee.firstName} {claim.employee.lastName}
                                  <Badge variant="outline" className="text-[10px] h-5 px-1.5 font-mono">{claim.employee.employeeId}</Badge>
                                </span>
                              ) : (
                                <span className="flex items-center gap-1">
                                  <User className="w-3 h-3" />
                                  Unassigned
                                </span>
                              )}
                              {claim.employee?.department && (
                                <span className="flex items-center gap-1">
                                  <Building2 className="w-3 h-3" />
                                  {claim.employee.department.name}
                                </span>
                              )}
                              {claim.projects.length > 0 && (
                                <span className="flex items-center gap-1">
                                  <FolderKanban className="w-3 h-3" />
                                  {claim.projects.map((p) => p.name).join(', ')}
                                </span>
                              )}
                              <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                Discovered {getTimeAgo(claim.createdAt)}
                              </span>
                              {claim.status === 'pending' && claim.expiresAt && (
                                <span className="flex items-center gap-1">
                                  <Clock className="w-3 h-3" />
                                  {new Date(claim.expiresAt).getTime() <= Date.now()
                                    ? `Expired ${getTimeAgo(claim.expiresAt)}`
                                    : `Expires ${getTimeAgo(claim.expiresAt)}`}
                                </span>
                              )}
                            </div>

                            {claim.status === 'rejected' && claim.rejectionReason && (
                              <div className="mt-2 p-2 rounded-md bg-rose-50 dark:bg-rose-900/15 border border-rose-200 dark:border-rose-800/30">
                                <p className="text-xs text-rose-700 dark:text-rose-300">
                                  <span className="font-medium">Rejection reason: </span>
                                  {claim.rejectionReason}
                                </p>
                              </div>
                            )}
                            {claim.status === 'revoked' && claim.rejectionReason && (
                              <div className="mt-2 p-2 rounded-md bg-gray-100 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-700/50">
                                <p className="text-xs text-gray-600 dark:text-gray-300">
                                  <span className="font-medium">Revoked: </span>
                                  {claim.rejectionReason}
                                </p>
                              </div>
                            )}
                            {claim.status === 'cancelled' && (
                              <div className="mt-2 p-2 rounded-md bg-blue-50 dark:bg-blue-900/15 border border-blue-200 dark:border-blue-800/30">
                                <p className="text-xs text-blue-700 dark:text-blue-300">
                                  <span className="font-medium">Cancelled by the device: </span>
                                  The employee cancelled this registration. The agent will submit a new request automatically.
                                </p>
                              </div>
                            )}
                            {isExpired && (
                              <div className="mt-2 p-2 rounded-md bg-gray-100 dark:bg-gray-800/40 border border-gray-200 dark:border-gray-700/50">
                                <p className="text-xs text-gray-600 dark:text-gray-300">
                                  <span className="font-medium">Expired: </span>
                                  This registration expired while awaiting approval. The agent will submit a new request automatically.
                                </p>
                              </div>
                            )}
                          </div>
                        </div>

                        {/* Right: System Info + Actions */}
                        <div className="lg:border-l lg:pl-4 lg:min-w-[280px] space-y-3">
                          <div className="space-y-1.5">
                            <h4 className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                              <Monitor className="w-3 h-3" />
                              Device Information
                            </h4>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-1.5">
                              <SystemInfoRow icon={Monitor} label="Hostname" value={claim.device.hostname} />
                              <SystemInfoRow icon={Cpu} label="OS" value={claim.device.operatingSystem && claim.device.osVersion ? `${claim.device.operatingSystem} ${claim.device.osVersion}` : claim.device.operatingSystem} />
                              <SystemInfoRow icon={Cpu} label="Processor" value={claim.device.processor} />
                              <SystemInfoRow icon={HardDrive} label="Memory" value={claim.device.memory} />
                              <SystemInfoRow icon={ShieldCheck} label="Agent" value={claim.device.agentVersion} />
                              <SystemInfoRow icon={Clock} label="Last seen" value={claim.device.lastHeartbeat ? getTimeAgo(claim.device.lastHeartbeat) : '—'} />
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-2 pt-1 flex-wrap">
                            {isPending && (
                              <>
                                <Button
                                  size="sm"
                                  className="h-8 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
                                  onClick={() => openApprove(claim)}
                                  disabled={actionLoading === claim.id}
                                >
                                  {actionLoading === claim.id ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                  )}
                                  Approve &amp; Activate
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8 gap-1.5 border-rose-300 text-rose-600 hover:bg-rose-50 hover:text-rose-700 text-xs"
                                  onClick={() => { setRejectTarget(claim); setRejectReason(''); }}
                                  disabled={actionLoading === claim.id}
                                >
                                  <XCircle className="w-3.5 h-3.5" />
                                  Reject
                                </Button>
                              </>
                            )}
                            {isApproved && (
                              <>
                                {/* Guest lifecycle actions for approved guest claims */}
                                {claim.guestStatus === 'ACTIVE' && (
                                  <>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 gap-1.5 text-xs"
                                      onClick={() => openConvert(claim)}
                                      disabled={actionLoading === claim.id}
                                    >
                                      <ArrowRightLeft className="w-3.5 h-3.5" />
                                      Convert to Employee
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 gap-1.5 border-amber-300 text-amber-600 hover:bg-amber-50 hover:text-amber-700 text-xs"
                                      onClick={() => setGuestActionTarget({ id: claim.guestId!, action: 'suspend', hostname: deviceName })}
                                      disabled={actionLoading === claim.id}
                                    >
                                      <PauseCircle className="w-3.5 h-3.5" />
                                      Suspend
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 gap-1.5 border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-gray-700 text-xs"
                                      onClick={() => setGuestActionTarget({ id: claim.guestId!, action: 'revoke', hostname: deviceName })}
                                      disabled={actionLoading === claim.id}
                                    >
                                      <PowerOff className="w-3.5 h-3.5" />
                                      Revoke
                                    </Button>
                                  </>
                                )}
                                {claim.guestStatus === 'SUSPENDED' && (
                                  <>
                                    <Button
                                      size="sm"
                                      className="h-8 gap-1.5 text-xs"
                                      onClick={() => setGuestActionTarget({ id: claim.guestId!, action: 'reactivate', hostname: deviceName })}
                                      disabled={actionLoading === claim.id}
                                    >
                                      <PlayCircle className="w-3.5 h-3.5" />
                                      Reactivate
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 gap-1.5 border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-gray-700 text-xs"
                                      onClick={() => setGuestActionTarget({ id: claim.guestId!, action: 'revoke', hostname: deviceName })}
                                      disabled={actionLoading === claim.id}
                                    >
                                      <PowerOff className="w-3.5 h-3.5" />
                                      Revoke
                                    </Button>
                                  </>
                                )}
                                {/* Employee-only approved claims: revoke device access */}
                                {!claim.guestStatus && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-8 gap-1.5 border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-gray-700 text-xs"
                                    onClick={() => {
                                      setRevokeTarget(claim);
                                      setRevokeReason('');
                                    }}
                                    disabled={actionLoading === claim.id}
                                  >
                                    <PowerOff className="w-3.5 h-3.5" />
                                    Revoke Access
                                  </Button>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}

      {/* Server-side pagination for the filtered list */}
      <PaginationControls
        currentPage={claimPage}
        totalPages={data?.totalPages ?? 1}
        totalItems={data?.total ?? 0}
        pageSize={10}
        onPageChange={setClaimPage}
      />

      {/* Approve & Activate Dialog */}
      <Dialog open={!!approveTarget} onOpenChange={(open) => { if (!open) setApproveTarget(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="w-5 h-5 text-emerald-600" />
              {approveMode === 'guest' ? 'Approve as Guest' : 'Approve &amp; Activate Device'}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3">
                <p>
                  {approveMode === 'guest'
                    ? 'Approve this device as a guest. A guest workforce state is created automatically — no employee account and no Admin Panel login. The person joins as a Guest and can be converted to an Employee later. Standard monitoring consent is auto-granted.'
                    : 'Assign this device to an employee and optionally to projects. The employee will be notified automatically — no action is required on their PC.'}
                </p>
                {approveTarget && (
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1.5">
                    <div className="flex items-center gap-2 text-sm">
                      <Laptop className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium">{approveTarget.device.name || approveTarget.device.hostname}</span>
                      <span className="text-xs text-muted-foreground">{approveTarget.device.operatingSystem} {approveTarget.device.osVersion}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Fingerprint className="w-3.5 h-3.5" />
                      <span className="font-mono">{approveTarget.deviceId}</span>
                    </div>
                  </div>
                )}

                {/* Approval mode */}
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">Approval mode</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setApproveMode('employee')}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                        approveMode === 'employee'
                          ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
                          : 'border-border hover:bg-muted/50 text-muted-foreground'
                      }`}
                    >
                      <User className="w-4 h-4 shrink-0" />
                      <span className="text-left">
                        <span className="block font-medium">Employee</span>
                        <span className="block text-[10px] font-normal">Assign to an employee</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setApproveMode('guest')}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                        approveMode === 'guest'
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                          : 'border-border hover:bg-muted/50 text-muted-foreground'
                      }`}
                    >
                      <Fingerprint className="w-4 h-4 shrink-0" />
                      <span className="text-left">
                        <span className="block font-medium">Guest</span>
                        <span className="block text-[10px] font-normal">Join as guest, convert later</span>
                      </span>
                    </button>
                  </div>
                </div>

                {approveMode === 'employee' && (
                  <>
                    {/* Employee selection (REQUIRED) */}
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium">
                        Employee <span className="text-rose-500">*</span>
                      </Label>
                      <EmployeeCombobox
                        value={selectedEmployeeId || null}
                        onValueChange={(v) => setSelectedEmployeeId((v as string) ?? '')}
                        onSelect={setSelectedEmployee}
                        status="active"
                        placeholder="Select employee"
                        labelFormat="name-id"
                        ariaLabel="Assign employee"
                      />
                    </div>

                    {/* Department auto-derived from the employee */}
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium">Department</Label>
                      <div className="rounded-md border px-3 py-2 text-sm bg-muted/30">
                        {selectedEmployee?.departmentName ? (
                          <span className="flex items-center gap-2">
                            <Building2 className="w-4 h-4 text-muted-foreground" />
                            {selectedEmployee.departmentName}
                            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">auto from employee</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">No department assigned to this employee</span>
                        )}
                      </div>
                    </div>

                    {/* Project selection */}
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium">Projects (optional)</Label>
                      {assignableProjects.length === 0 ? (
                        <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground bg-muted/30">
                          No active projects available
                        </div>
                      ) : (
                        <div className="rounded-md border divide-y divide-border max-h-44 overflow-y-auto">
                          {assignableProjects.map((proj: { id: string; name: string; color: string }) => (
                            <label
                              key={proj.id}
                              className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50 transition-colors"
                            >
                              <Checkbox
                                checked={selectedProjectIds.includes(proj.id)}
                                onCheckedChange={() => toggleProject(proj.id)}
                              />
                              <span
                                className="w-2 h-2 rounded-full shrink-0"
                                style={{ backgroundColor: proj.color || '#10b981' }}
                              />
                              <span className="truncate">{proj.name}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}

                <div className="flex items-start gap-2 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/15 rounded-md p-2">
                  <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    {approveMode === 'guest'
                      ? 'The person joins the organization as a Guest. No Admin Panel login is created. A Guest can be converted to an Employee at any time by an Org Admin or Manager.'
                      : 'Approval activates the device only. Monitoring consent is managed separately and remains the employee&apos;s right to control.'}
                  </span>
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproveTarget(null)}>Cancel</Button>
            <Button
              className={approveMode === 'guest' ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-emerald-600 hover:bg-emerald-700 text-white'}
              onClick={handleApprove}
              disabled={actionLoading === approveTarget?.id || (approveMode === 'employee' && !selectedEmployeeId)}
            >
              {actionLoading === approveTarget?.id ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <CheckCircle2 className="w-4 h-4 mr-2" />
              )}
              {approveMode === 'guest' ? 'Approve as Guest' : 'Approve &amp; Activate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={!!rejectTarget} onOpenChange={(open) => { if (!open) { setRejectTarget(null); setRejectReason(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldX className="w-5 h-5 text-rose-600" />
              Reject Device
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Rejecting denies this device access. The employee will see that the device was not approved. You may optionally provide a reason.
                </p>
                {rejectTarget && (
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1.5">
                    <div className="flex items-center gap-2 text-sm">
                      <Laptop className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium">{rejectTarget.device.name || rejectTarget.device.hostname}</span>
                    </div>
                  </div>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">Rejection Reason (optional)</label>
            <Textarea
              placeholder="e.g., Unrecognized device, please contact IT support..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setRejectTarget(null); setRejectReason(''); }}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={actionLoading === rejectTarget?.id}
            >
              {actionLoading === rejectTarget?.id ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <XCircle className="w-4 h-4 mr-2" />
              )}
              Reject Device
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke Device Dialog (for employee-mode approved claims) */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => { if (!open) { setRevokeTarget(null); setRevokeReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <PowerOff className="w-5 h-5 text-gray-600" />
              Revoke Device Access?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  The device will be deactivated immediately. Its agent will stop collecting data and lose access. You may optionally provide a reason.
                </p>
                {revokeTarget && (
                  <div className="bg-muted/50 rounded-lg p-3 space-y-1.5">
                    <div className="flex items-center gap-2 text-sm">
                      <Laptop className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium">{revokeTarget.device.name || revokeTarget.device.hostname}</span>
                    </div>
                    {revokeTarget.employee && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <User className="w-3.5 h-3.5" />
                        <span>{revokeTarget.employee.firstName} {revokeTarget.employee.lastName}</span>
                      </div>
                    )}
                  </div>
                )}
                <Textarea
                  placeholder="Reason (optional)"
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                  rows={2}
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-gray-700 hover:bg-gray-800 text-white"
              onClick={() => revokeTarget && handleRevoke()}
            >
              {actionLoading === revokeTarget?.id ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : (
                <PowerOff className="w-4 h-4 mr-2" />
              )}
              Revoke Access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Guest Action Confirm Dialog (suspend/reactivate/revoke guest) */}
      <AlertDialog open={!!guestActionTarget} onOpenChange={(open) => { if (!open) { setGuestActionTarget(null); setGuestActionReason(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              {guestActionTarget?.action === 'suspend' && <PauseCircle className="w-5 h-5 text-amber-600" />}
              {guestActionTarget?.action === 'reactivate' && <PlayCircle className="w-5 h-5 text-emerald-600" />}
              {guestActionTarget?.action === 'revoke' && <PowerOff className="w-5 h-5 text-gray-600" />}
              {guestActionTarget?.action === 'suspend' ? 'Suspend Guest?' : guestActionTarget?.action === 'reactivate' ? 'Reactivate Guest?' : 'Revoke Guest?'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  {guestActionTarget?.action === 'suspend' && 'The guest device will lose monitoring access but the record and telemetry history are preserved. You can reactivate later.'}
                  {guestActionTarget?.action === 'reactivate' && 'The guest device will resume monitoring under its previous consent terms.'}
                  {guestActionTarget?.action === 'revoke' && 'The guest will be permanently deactivated. This action cannot be undone.'}
                </p>
                {guestActionTarget && (
                  <div className="bg-muted/50 rounded-lg p-3">
                    <span className="text-sm font-medium">{guestActionTarget.hostname}</span>
                  </div>
                )}
                <Textarea
                  placeholder="Reason (optional)"
                  value={guestActionReason}
                  onChange={(e) => setGuestActionReason(e.target.value)}
                  rows={2}
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={guestActionTarget?.action === 'revoke' ? 'bg-gray-700 hover:bg-gray-800 text-white' : ''}
              onClick={() => guestActionTarget && handleGuestAction()}
            >
              {actionLoading === guestActionTarget?.id ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              {guestActionTarget?.action === 'suspend' ? 'Suspend Guest' : guestActionTarget?.action === 'reactivate' ? 'Reactivate Guest' : 'Revoke Guest'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Convert Guest → Employee Dialog */}
      <Dialog open={convertTarget !== null} onOpenChange={(open) => { if (!open) setConvertTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convert Guest to Employee</DialogTitle>
            <DialogDescription>
              The guest becomes an Employee workforce identity. The device, telemetry history and employee record are preserved, and the guest record is removed. No Admin Panel login is created.
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
    </div>
  );
}

export function AgentApprovalsPage() {
  return (
    <div className="space-y-4">
      <ZeroTouchDevicesTab />
    </div>
  );
}
