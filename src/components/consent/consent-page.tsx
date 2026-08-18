'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShieldCheck,
  Clock,
  FileCheck,
  Users,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Search,
  RefreshCw,
  ChevronRight,
  Loader2,
  UserCheck,
  UserX,
  Fingerprint,
  Camera,
  Monitor,
  Keyboard,
  Usb,
  Webcam,
  MapPin,
  Mail,
  ClipboardCheck,
  History,
  Ban,
  ScrollText,
  Plus,
  Send,
  Archive,
  Trash2,
  Pencil,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { PresenceDot } from '@/components/ui/presence-dot';
import { toast } from 'sonner';

// ==================== Types ====================

interface ConsentRecord {
  id: string;
  employeeId: string;
  consentType: string;
  status: string;
  grantedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  consentVersion: string;
  notes: string | null;
  createdAt: string;
  employee?: { id: string; firstName: string; lastName: string; employeeId: string; avatar: string | null; designation: string | null; department?: { name: string } | null };
}

interface ConsentSummary {
  summary: { totalEmployees: number; fullyCompliant: number; nonCompliant: number; overallPct: number };
  typeBreakdown: Array<{ type: string; label: string; total: number; granted: number; pending: number; denied: number; revoked: number; expired: number; policyVersion: string | null; requiresReconsent: number; pct: number }>;
  employees: Array<{
    employee: NonNullable<ConsentRecord['employee']>;
    total: number; granted: number; pending: number; denied: number; revoked: number; expired: number;
    pct: number; allGranted: boolean; hasPending: boolean; hasRevoked: boolean; hasDenied: boolean;
    complianceStatus: string; lastConsent: string | null;
    consents: Array<{ id: string; consentType: string; status: string; grantedAt: string | null; revokedAt: string | null; consentVersion: string | null; policyId: string | null; requiresReconsent: boolean }>;
  }>;
}

interface ConsentStats {
  total: number;
  employees: number;
  byStatus: { granted: number; pending: number; denied: number; revoked: number; expired: number };
  byType: Record<string, number>;
}

interface ConsentPolicy {
  id: string;
  organizationId: string;
  consentType: string;
  title: string;
  content: string;
  version: string;
  status: string;
  effectiveAt: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
  createdAt: string;
}

interface PolicyGroup {
  type: string;
  label: string;
  published: ConsentPolicy | null;
  versions: ConsentPolicy[];
}

interface ConsentLog {
  id: string;
  consentId: string;
  action: string;
  description: string;
  performedBy: string | null;
  createdAt: string;
}

// ==================== Constants ====================

const TYPE_CONFIG: Record<string, { icon: React.ElementType; label: string; color: string; bg: string; description: string }> = {
  monitoring: { icon: Monitor, label: 'General Monitoring', color: 'text-emerald-500', bg: 'bg-emerald-100 dark:bg-emerald-900/30', description: 'General employee activity monitoring including apps, websites, and work patterns' },
  screenshot: { icon: Camera, label: 'Screenshot Capture', color: 'text-violet-500', bg: 'bg-violet-100 dark:bg-violet-900/30', description: 'Periodic desktop screenshots for productivity verification' },
  activity_tracking: { icon: ClipboardCheck, label: 'Activity Tracking', color: 'text-blue-500', bg: 'bg-blue-100 dark:bg-blue-900/30', description: 'Application and website DOMAIN usage during work activity (domains only — never full URLs)' },
  keystroke: { icon: Keyboard, label: 'Keystroke Logging', color: 'text-rose-500', bg: 'bg-rose-100 dark:bg-rose-900/30', description: 'Monitoring of keystroke patterns for security and productivity analysis' },
  usb_monitoring: { icon: Usb, label: 'USB Monitoring', color: 'text-amber-500', bg: 'bg-amber-100 dark:bg-amber-900/30', description: 'Monitoring of USB device connections and data transfers' },
  webcam_access: { icon: Webcam, label: 'Webcam Access', color: 'text-red-500', bg: 'bg-red-100 dark:bg-red-900/30', description: 'Access to device webcam for presence verification' },
  location: { icon: MapPin, label: 'Location Tracking', color: 'text-cyan-500', bg: 'bg-cyan-100 dark:bg-cyan-900/30', description: 'GPS-based location tracking of company devices' },
  // email_monitoring is CONSENT-ONLY: recording consent for this type does not
  // mean email monitoring is active — no email collector exists today (the
  // consent is recorded for future capability; nothing is collected).
  email_monitoring: { icon: Mail, label: 'Email Monitoring', color: 'text-indigo-500', bg: 'bg-indigo-100 dark:bg-indigo-900/30', description: 'Consent for email monitoring is recorded for future capability — no email monitoring is currently performed' },
};

const STATUS_CONFIG: Record<string, { icon: React.ElementType; label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; color: string }> = {
  granted: { icon: CheckCircle2, label: 'Granted', variant: 'secondary', color: 'text-emerald-600' },
  pending: { icon: Clock, label: 'Pending', variant: 'default', color: 'text-amber-600' },
  denied: { icon: Ban, label: 'Denied', variant: 'outline', color: 'text-red-600' },
  revoked: { icon: XCircle, label: 'Revoked', variant: 'destructive', color: 'text-rose-600' },
  expired: { icon: AlertTriangle, label: 'Expired', variant: 'outline', color: 'text-slate-600' },
};

const COMPLIANCE_COLORS: Record<string, { text: string; bg: string; label: string }> = {
  fully_compliant: { text: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/30', label: 'Fully Compliant' },
  partial: { text: 'text-amber-600', bg: 'bg-amber-100 dark:bg-amber-900/30', label: 'Partial' },
  non_compliant: { text: 'text-rose-600', bg: 'bg-rose-100 dark:bg-rose-900/30', label: 'Non-Compliant' },
};

// ==================== Cache sync helpers ====================
// The admin dialog renders from the `['consent-summary']` cache. After a
// server-confirmed mutation we PATCH that cache immediately (so the open
// dialog and its header counters update instantly) and then invalidate for an
// authoritative refetch. The recompute helpers mirror the server aggregation
// in /api/consent/summary exactly, so counters never drift.

const TYPE_KEYS = Object.keys(TYPE_CONFIG);

function recomputeEmployee(emp: ConsentSummary['employees'][number]): ConsentSummary['employees'][number] {
  const granted = emp.consents.filter((c) => c.status === 'granted').length;
  const total = TYPE_KEYS.length;
  const pct = Math.round((granted / total) * 100);
  // Mirrors the server exactly. NOT vacuous: an employee with ZERO consents
  // (brand-new / never-consented) must never be labeled fully compliant.
  const allGranted = emp.consents.length > 0 && emp.consents.every((c) => c.status === 'granted');
  const hasPending = emp.consents.some((c) => c.status === 'pending');
  const hasRevoked = emp.consents.some((c) => c.status === 'revoked');
  const hasDenied = emp.consents.some((c) => c.status === 'denied');
  return {
    ...emp,
    granted,
    pending: emp.consents.filter((c) => c.status === 'pending').length,
    denied: emp.consents.filter((c) => c.status === 'denied').length,
    revoked: emp.consents.filter((c) => c.status === 'revoked').length,
    expired: emp.consents.filter((c) => c.status === 'expired').length,
    pct,
    allGranted,
    hasPending,
    hasRevoked,
    hasDenied,
    complianceStatus: allGranted ? 'fully_compliant' : pct >= 60 ? 'partial' : 'non_compliant',
  };
}

function rebuildSummaryCache(
  prev: ConsentSummary | undefined,
  employeeId: string,
  update: (emp: ConsentSummary['employees'][number]) => ConsentSummary['employees'][number]
): ConsentSummary | undefined {
  if (!prev) return prev;
  const employees = prev.employees.map((e) => (e.employee.id === employeeId ? update(e) : e));

  // Recompute the type-level breakdown (mirrors the server).
  const typeBreakdown = TYPE_KEYS.map((type) => {
    const typeConsents = employees.flatMap((e) => e.consents.filter((c) => c.consentType === type));
    const granted = typeConsents.filter((c) => c.status === 'granted').length;
    const published = prev.typeBreakdown.find((tb) => tb.type === type);
    return {
      type,
      label: published?.label ?? type,
      total: typeConsents.length,
      granted,
      pending: typeConsents.filter((c) => c.status === 'pending').length,
      denied: typeConsents.filter((c) => c.status === 'denied').length,
      revoked: typeConsents.filter((c) => c.status === 'revoked').length,
      expired: typeConsents.filter((c) => c.status === 'expired').length,
      policyVersion: published?.policyVersion ?? null,
      requiresReconsent: typeConsents.filter((c) => c.status === 'granted' && c.requiresReconsent).length,
      pct: typeConsents.length > 0 ? Math.round((granted / typeConsents.length) * 100) : 0,
    };
  });

  // Recompute the top-level summary aggregates.
  const totalEmployees = employees.length;
  const fullyCompliant = employees.filter((e) => e.allGranted).length;
  const nonCompliant = employees.filter((e) => e.pct < 60).length;
  const overallPct = totalEmployees > 0 ? Math.round(employees.reduce((s, e) => s + e.pct, 0) / totalEmployees) : 0;

  return {
    summary: { totalEmployees, fullyCompliant, nonCompliant, overallPct },
    typeBreakdown,
    employees: employees.sort((a, b) => b.pct - a.pct),
  };
}

function toSummaryConsent(c: {
  id: string;
  consentType: string;
  status: string;
  grantedAt: string | null;
  revokedAt: string | null;
  consentVersion: string;
  policyId: string | null;
}): ConsentSummary['employees'][number]['consents'][number] {
  // A fresh server-confirmed grant binds the CURRENT published policy version,
  // so requiresReconsent is false; non-granted statuses never require it.
  return {
    id: c.id,
    consentType: c.consentType,
    status: c.status,
    grantedAt: c.grantedAt,
    revokedAt: c.revokedAt,
    consentVersion: c.consentVersion,
    policyId: c.policyId,
    requiresReconsent: false,
  };
}

// ==================== Employee Consent Dialog ====================

function EmployeeConsentDialog({ emp, open, onClose }: { emp: ConsentSummary['employees'][0] | null; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [revokeAllArmed, setRevokeAllArmed] = useState(false);
  const [pendingToggleId, setPendingToggleId] = useState<string | null>(null);
  // Tracks the single-type bulk grant while a zero-consent row is in flight
  // (those rows have no real consent id yet, so pendingToggleId can't cover them).
  const [pendingBulkType, setPendingBulkType] = useState<string | null>(null);
  const employeeId = emp?.employee.id;

  // Shared fetch wrapper: the server response is authoritative — the UI only
  // updates from `response.ok` + the returned consent object, never optimistically.
  const request = async (url: string, init: RequestInit) => {
    const res = await fetch(url, init);
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error((body as { error?: string } | null)?.error || 'Request failed') as Error & { status?: number };
      error.status = res.status;
      throw error;
    }
    return body;
  };

  const invalidateConsentQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['consent'] });
    queryClient.invalidateQueries({ queryKey: ['consent-summary'] });
    queryClient.invalidateQueries({ queryKey: ['consent-logs'] });
  };

  const handleMutationError = (error: unknown) => {
    const err = error as { status?: number; message?: string };
    const status = err?.status;
    if (status === 401) {
      toast.error('Your session expired. Please sign in again.');
    } else if (status === 403) {
      toast.error("You're not authorized to update this consent.");
    } else if (status === 404) {
      toast.error('Consent not found. It may have been removed.');
    } else if (status === 409) {
      // Two kinds of 409: a concurrent change (never overwrite the newer server
      // state) OR — common now that zero-consent employees can be granted — a
      // missing published policy ("Cannot grant: no published policy…"). Surface
      // the server message when present so the admin knows to publish the policy;
      // otherwise treat it as a conflict and refetch.
      if (err?.message) {
        toast.error(err.message);
      } else {
        toast.error('The consent changed before your action completed. Refreshing the latest status.');
      }
      queryClient.invalidateQueries({ queryKey: ['consent-summary'] });
      queryClient.invalidateQueries({ queryKey: ['consent'] });
    } else if (status === 422) {
      toast.error(err?.message || 'Invalid request.');
    } else {
      toast.error(err?.message || 'Failed to update consent');
    }
  };

  const grantAllMutation = useMutation({
    mutationFn: () =>
      request('/api/consent/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId, action: 'grant_all' }),
      }),
    onSuccess: () => {
      if (!employeeId) return;
      // Patch every consent type for this employee to granted immediately.
      queryClient.setQueryData<ConsentSummary>(['consent-summary'], (prev) =>
        rebuildSummaryCache(prev, employeeId, (e) => {
          const existing = new Map(e.consents.map((c) => [c.consentType, c]));
          const consents = TYPE_KEYS.map((type) => {
            const cur = existing.get(type);
            if (cur) return { ...cur, status: 'granted', requiresReconsent: false };
            // Placeholder (bulk response carries no per-record ids); the
            // invalidation refetch replaces it with the real record.
            return { id: `bulk-${employeeId}-${type}`, consentType: type, status: 'granted', grantedAt: new Date().toISOString(), revokedAt: null, consentVersion: 'v1', policyId: null, requiresReconsent: false };
          });
          return recomputeEmployee({ ...e, consents });
        })
      );
      invalidateConsentQueries();
      toast.success(`All consents granted for ${emp?.employee.firstName ?? ''}`);
    },
    onError: handleMutationError,
  });

  const revokeAllMutation = useMutation({
    mutationFn: () =>
      request('/api/consent/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId, action: 'revoke_all' }),
      }),
    onSuccess: () => {
      if (!employeeId) return;
      queryClient.setQueryData<ConsentSummary>(['consent-summary'], (prev) =>
        rebuildSummaryCache(prev, employeeId, (e) => {
          const existing = new Map(e.consents.map((c) => [c.consentType, c]));
          const consents = TYPE_KEYS.map((type) => {
            const cur = existing.get(type);
            if (cur) return { ...cur, status: 'revoked', requiresReconsent: false };
            return { id: `bulk-${employeeId}-${type}`, consentType: type, status: 'revoked', grantedAt: null, revokedAt: new Date().toISOString(), consentVersion: 'v1', policyId: null, requiresReconsent: false };
          });
          return recomputeEmployee({ ...e, consents });
        })
      );
      invalidateConsentQueries();
      toast.success(`All consents revoked for ${emp?.employee.firstName ?? ''}`);
      setRevokeAllArmed(false);
    },
    onError: (error) => { setRevokeAllArmed(false); handleMutationError(error); },
  });

  const handleRevokeAll = () => {
    if (!revokeAllArmed) {
      setRevokeAllArmed(true);
      return;
    }
    setRevokeAllArmed(false);
    revokeAllMutation.mutate();
  };

  const toggleMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) =>
      request(`/api/consent/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, performedBy: 'admin' }),
      }),
    onMutate: ({ id }) => setPendingToggleId(id),
    onSuccess: (updated: {
      id: string;
      consentType: string;
      status: string;
      grantedAt: string | null;
      revokedAt: string | null;
      consentVersion: string;
      policyId: string | null;
    }) => {
      // The SERVER response is the source of truth — patch the exact record
      // into the summary cache immediately so the open dialog re-renders.
      if (employeeId) {
        queryClient.setQueryData<ConsentSummary>(['consent-summary'], (prev) =>
          rebuildSummaryCache(prev, employeeId, (e) => {
            const exists = e.consents.some((c) => c.id === updated.id);
            const consents = exists
              ? e.consents.map((c) => (c.id === updated.id ? toSummaryConsent(updated) : c))
              : [...e.consents, toSummaryConsent(updated)];
            return recomputeEmployee({ ...e, consents });
          })
        );
      }
      invalidateConsentQueries();
      const label = updated.status === 'granted' ? 'granted' : updated.status === 'revoked' ? 'revoked' : updated.status === 'denied' ? 'denied' : 'updated';
      toast.success(`Consent ${label}`);
    },
    onError: handleMutationError,
    onSettled: () => setPendingToggleId(null),
  });

  // Single-type grant for an employee with NO consent record yet (consents=[]).
  // Goes through the SAME bulk state machine (grant_types) so the record is
  // created and bound to the current published policy version in one audited
  // transition — never a direct row write from the UI. Returns 409 when no
  // policy is published for the type.
  const bulkGrantTypeMutation = useMutation({
    mutationFn: async ({ type }: { type: string }) =>
      request('/api/consent/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId, action: 'grant_types', consentTypes: [type] }),
      }),
    onMutate: ({ type }) => setPendingBulkType(type),
    onSuccess: (_body, { type }) => {
      if (!employeeId) return;
      // Patch ONLY the granted type into the summary cache (the refetch
      // replaces the placeholder with the authoritative record).
      queryClient.setQueryData<ConsentSummary>(['consent-summary'], (prev) =>
        rebuildSummaryCache(prev, employeeId, (e) => {
          const exists = e.consents.some((c) => c.consentType === type);
          const consents = exists
            ? e.consents.map((c) => (c.consentType === type ? { ...c, status: 'granted', requiresReconsent: false } : c))
            : [...e.consents, { id: `bulk-${employeeId}-${type}`, consentType: type, status: 'granted', grantedAt: new Date().toISOString(), revokedAt: null, consentVersion: 'v1', policyId: null, requiresReconsent: false }];
          return recomputeEmployee({ ...e, consents });
        })
      );
      invalidateConsentQueries();
      toast.success(`Consent granted for ${TYPE_CONFIG[type]?.label ?? type}`);
    },
    onError: handleMutationError,
    onSettled: () => setPendingBulkType(null),
  });

  if (!emp) return null;

  // Real per-type consent records returned by /api/consent/summary — the
  // dialog renders actual DB statuses and mutates real consent IDs.
  const consentByType = new Map(emp.consents.map((c) => [c.consentType, c]));

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[550px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary font-bold text-sm">
              {emp.employee.firstName[0]}{emp.employee.lastName[0]}
            </div>
            <div>
              <DialogTitle className="text-base">{emp.employee.firstName} {emp.employee.lastName}</DialogTitle>
              <DialogDescription>{emp.employee.employeeId} · {emp.employee.designation || 'Employee'}{emp.employee.department ? ` · ${emp.employee.department.name}` : ''}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          {/* Compliance summary */}
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
            <div className="text-2xl font-bold">{emp.pct}%</div>
            <div className="flex-1">
              <div className="h-2 rounded-full bg-muted overflow-hidden">
                <motion.div
                  className={`h-full rounded-full ${emp.pct >= 80 ? 'bg-emerald-500' : emp.pct >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`}
                  initial={{ width: 0 }}
                  animate={{ width: `${emp.pct}%` }}
                  transition={{ duration: 0.6 }}
                />
              </div>
              <div className="flex gap-3 mt-1 text-[10px] text-muted-foreground">
                <span>{emp.granted} granted</span>
                <span>{emp.pending} pending</span>
                <span>{emp.denied} denied</span>
                <span>{emp.revoked} revoked</span>
              </div>
            </div>
          </div>

          {/* Consent type cards */}
          {Object.entries(TYPE_CONFIG).map(([type, cfg]) => {
            const record = consentByType.get(type);
            const status = record?.status || 'pending';
            const requiresReconsent = record?.requiresReconsent || false;
            const isGranted = status === 'granted';
            const isPendingRow = pendingToggleId === record?.id || pendingBulkType === type;
            // Placeholder rows created by the optimistic bulk cache patch have
            // no real id yet — the refetch replaces them; keep them inert.
            const isPlaceholder = !!record?.id && record.id.startsWith('bulk-');
            const busy = grantAllMutation.isPending || revokeAllMutation.isPending || toggleMutation.isPending || bulkGrantTypeMutation.isPending;
            return (
              <div key={type} className="flex items-center gap-3 p-3 rounded-lg border border-border/50">
                <div className={`h-8 w-8 rounded-md flex items-center justify-center ${cfg.bg}`}>
                  <cfg.icon className={`h-4 w-4 ${cfg.color}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{cfg.label}</p>
                  <p className="text-[10px] text-muted-foreground">{cfg.description}</p>
                  {requiresReconsent && (
                    <p className="text-[10px] font-medium text-amber-600 mt-0.5 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> Re-consent required — policy updated to v{record?.consentVersion ? `v${record.consentVersion.replace('v', '')}` : 'new'}
                    </p>
                  )}
                  {status === 'denied' && (
                    <p className="text-[10px] font-medium text-red-600 mt-0.5 flex items-center gap-1">
                      <Ban className="h-3 w-3" /> Employee denied this type
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <Button
                    size="sm"
                    variant={isGranted ? 'secondary' : 'outline'}
                    className={`h-7 text-[11px] ${isGranted ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'hover:bg-rose-100 hover:text-rose-700'}`}
                    onClick={() => {
                      if (isPlaceholder || isPendingRow || busy) return;
                      if (!record) {
                        // No record yet — create + grant through the bulk state
                        // machine (binds the current published policy; 409 when
                        // no policy is published for this type).
                        bulkGrantTypeMutation.mutate({ type });
                        return;
                      }
                      toggleMutation.mutate({ id: record.id, status: isGranted ? 'revoked' : 'granted' });
                    }}
                    disabled={isPendingRow || isPlaceholder || busy}
                    title={
                      isPlaceholder
                        ? 'Syncing…' 
                        : record
                          ? isGranted ? 'Click to revoke' : 'Click to grant'
                          : 'No consent record yet — click to create and grant'
                    }
                  >
                    {isPendingRow ? (
                      <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> {isGranted ? 'Revoking…' : 'Granting…'}</>
                    ) : isGranted ? (
                      <><CheckCircle2 className="h-3 w-3 mr-1" /> Granted</>
                    ) : (
                      <><XCircle className="h-3 w-3 mr-1" /> {status === 'denied' ? 'Denied' : 'Not Granted'}</>
                    )}
                  </Button>
                  {status === 'denied' && !isPendingRow && (
                    <span className="text-[9px] text-muted-foreground">Click to grant via admin</span>
                  )}
                </div>
              </div>
            );
          })}

          {/* Bulk actions — cross-disabled so Grant All and Revoke All can never run concurrently */}
          <div className="flex gap-2 pt-2">
            <Button size="sm" onClick={() => { setRevokeAllArmed(false); grantAllMutation.mutate(); }} disabled={grantAllMutation.isPending || revokeAllMutation.isPending} className="flex-1 bg-emerald-600 hover:bg-emerald-700">
              {grantAllMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              <UserCheck className="h-3.5 w-3.5 mr-1" /> Grant All
            </Button>
            <Button size="sm" variant={revokeAllArmed ? 'destructive' : 'outline'} onClick={handleRevokeAll} disabled={revokeAllMutation.isPending || grantAllMutation.isPending} className="flex-1 text-rose-600 hover:bg-rose-50">
              {revokeAllMutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              <UserX className="h-3.5 w-3.5 mr-1" /> {revokeAllArmed ? 'Confirm revoke?' : 'Revoke All'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==================== Policies Panel ====================

function PoliciesPanel({
  groups,
  loading,
  onRefresh,
}: {
  groups: PolicyGroup[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<ConsentPolicy | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['consent-policies'] });
    queryClient.invalidateQueries({ queryKey: ['consent-summary'] });
    queryClient.invalidateQueries({ queryKey: ['consent'] });
  };

  const policyMutation = useMutation({
    mutationFn: async ({ id, action, body }: { id?: string; action: 'create' | 'publish' | 'archive' | 'delete' | 'edit' | 'redraft'; body?: Record<string, unknown> }) => {
      const res = id
        ? await fetch(`/api/consent/policies/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }) })
        : await fetch('/api/consent/policies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || 'Request failed');
      }
      return res.json();
    },
    onSuccess: (_, vars) => {
      toast.success(vars.action === 'publish' ? 'Policy published — employees must re-consent' : 'Policy updated');
      setCreateOpen(false);
      setEditing(null);
      invalidate();
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Failed to update policy'),
  });

  if (loading) {
    return <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}</div>;
  }

  return (
    <div className="space-y-4">
      <Card className="falcon-card p-0">
        <CardContent className="p-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <ScrollText className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-medium">Consent Policies</h3>
              <span className="text-[10px] text-muted-foreground">Publishing a new version invalidates existing consents until employees re-consent</span>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onRefresh} disabled={loading}>
                <RefreshCw className="h-3 w-3 mr-1" /> Refresh
              </Button>
              <Button size="sm" className="h-8 text-xs" onClick={() => { setEditing(null); setCreateOpen(true); }}>
                <Plus className="h-3.5 w-3.5 mr-1" /> New Draft
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {groups.map((group) => {
          const cfg = TYPE_CONFIG[group.type] || TYPE_CONFIG.monitoring;
          const drafts = group.versions.filter((v) => v.status === 'draft');
          return (
            <Card key={group.type} className="falcon-card p-0">
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <div className={`h-7 w-7 rounded-md flex items-center justify-center ${cfg.bg}`}>
                    <cfg.icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                  </div>
                  <span className="text-xs font-semibold flex-1">{cfg.label}</span>
                  {group.published ? (
                    <Badge variant="secondary" className="text-[9px] h-4 px-1.5 bg-emerald-100 text-emerald-700 border-0">
                      v{group.published.version.replace('v', '')} published
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5 text-amber-600">no published version</Badge>
                  )}
                </div>

                {group.published ? (
                  <div className="p-2.5 rounded-lg bg-muted/40">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Active policy · v{group.published.version.replace('v', '')}</p>
                    <p className="text-xs font-medium mt-1">{group.published.title}</p>
                    <p className="text-[11px] text-muted-foreground mt-1 line-clamp-3">{group.published.content}</p>
                    <div className="flex items-center gap-2 mt-2">
                      {group.published.effectiveAt && (
                        <span className="text-[10px] text-muted-foreground">Effective {new Date(group.published.effectiveAt).toLocaleDateString()}</span>
                      )}
                      <span className="flex-1" />
                      <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => { setEditing(group.published); setCreateOpen(true); }}>
                        <Pencil className="h-3 w-3 mr-1" /> View
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground py-1">No published policy — draft one and publish it.</p>
                )}

                {drafts.length > 0 && (
                  <div className="space-y-1.5">
                    {drafts.map((d) => (
                      <div key={d.id} className="flex items-center gap-2 p-2 rounded-lg border border-dashed border-border/60">
                        <Badge variant="outline" className="text-[9px] h-4 px-1">draft v{d.version.replace('v', '')}</Badge>
                        <span className="text-[11px] truncate flex-1">{d.title}</span>
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" title="Edit" onClick={() => { setEditing(d); setCreateOpen(true); }}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-emerald-600" title="Publish" disabled={policyMutation.isPending} onClick={() => policyMutation.mutate({ id: d.id, action: 'publish' })}>
                          <Send className="h-3 w-3" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-rose-600" title="Delete draft" disabled={policyMutation.isPending} onClick={() => policyMutation.mutate({ id: d.id, action: 'delete' })}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                {group.versions.length > 1 && (
                  <details className="text-[10px] text-muted-foreground">
                    <summary className="cursor-pointer hover:text-foreground">Version history ({group.versions.length})</summary>
                    <ul className="mt-1 space-y-0.5 pl-1">
                      {[...group.versions].reverse().map((v) => (
                        <li key={v.id} className="flex items-center gap-2">
                          <span className="font-mono">v{v.version.replace('v', '')}</span>
                          <Badge variant="outline" className={`text-[9px] h-3.5 px-1 ${v.status === 'published' ? 'text-emerald-600' : v.status === 'draft' ? 'text-amber-600' : 'text-slate-500'}`}>{v.status}</Badge>
                          {v.publishedAt && <span>{new Date(v.publishedAt).toLocaleDateString()}</span>}
                          {v.status === 'archived' && (
                            <Button size="sm" variant="ghost" className="h-5 w-5 p-0" title="Redraft" onClick={() => policyMutation.mutate({ id: v.id, action: 'redraft' })}>
                              <Archive className="h-3 w-3" />
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <PolicyDialog
        open={createOpen}
        onOpenChange={(o) => { setCreateOpen(o); if (!o) setEditing(null); }}
        editing={editing}
        groups={groups}
        onSave={(payload) => policyMutation.mutate(editing ? { id: editing.id, action: 'edit', body: payload } : { action: 'create', body: payload })}
        submitting={policyMutation.isPending}
      />
    </div>
  );
}

// ==================== Policy Create/Edit Dialog ====================

function PolicyDialog({
  open,
  onOpenChange,
  editing,
  groups,
  onSave,
  submitting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: ConsentPolicy | null;
  groups: PolicyGroup[];
  onSave: (payload: { consentType: string; title: string; content: string }) => void;
  submitting: boolean;
}) {
  const [consentType, setConsentType] = useState('screenshot');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  // Reset fields when the dialog opens for a different policy
  const openKey = `${open}-${editing?.id ?? 'new'}`;
  const [lastKey, setLastKey] = useState(openKey);
  if (openKey !== lastKey) {
    setLastKey(openKey);
    setConsentType(editing?.consentType || 'screenshot');
    setTitle(editing?.title || '');
    setContent(editing?.content || '');
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base">{editing ? `Edit ${editing.title} (v${editing.version.replace('v', '')})` : 'New Consent Policy Draft'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Only drafts can be edited. Publish to make it the active policy — existing consents then require re-consent.'
              : 'Draft a new policy version. Publishing will ask employees to re-consent.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium mb-1 block">Consent Type</label>
            <Select value={consentType} onValueChange={setConsentType} disabled={!!editing}>
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {groups.map((g) => (
                  <SelectItem key={g.type} value={g.type}>{g.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Policy Title</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Screenshot Capture Policy" className="h-9 text-xs" />
          </div>
          <div>
            <label className="text-xs font-medium mb-1 block">Policy Content (shown to employees before consent)</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Describe what data is collected, how it is used, retention, and employee rights..."
              className="w-full min-h-[140px] rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={submitting || content.trim().length < 20 || !title.trim()}
              onClick={() => onSave({ consentType, title: title.trim(), content: content.trim() })}
            >
              {submitting && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              {editing ? 'Save Draft' : 'Create Draft'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ==================== Main Page ====================

export function ConsentPage() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<'overview' | 'details' | 'logs' | 'policies'>('overview');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  // The dialog derives the selected employee from the LIVE summary cache each
  // render (keyed by id) instead of a frozen snapshot. Mutations patch the
  // cache + invalidate, so the open dialog re-renders with the authoritative
  // state immediately — no close/reopen needed.
  const [selectedEmpId, setSelectedEmpId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  // Fetch summary data
  const { data: summaryData, isLoading: summaryLoading } = useQuery({
    queryKey: ['consent-summary'],
    queryFn: async () => { const res = await fetch('/api/consent/summary'); return res.json() as Promise<ConsentSummary>; },
  });

  // Fetch detail list
  const { data: detailData, isLoading: detailLoading, refetch: refetchDetail } = useQuery({
    queryKey: ['consent', typeFilter, statusFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (typeFilter) params.set('type', typeFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (search) params.set('search', search);
      params.set('pageSize', '100');
      const res = await fetch(`/api/consent?${params}`);
      return res.json() as Promise<{ data: ConsentRecord[]; total: number; stats: ConsentStats }>;
    },
    enabled: view === 'details',
  });

  // Fetch logs
  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useQuery({
    queryKey: ['consent-logs'],
    queryFn: async () => { const res = await fetch('/api/consent/logs?pageSize=50'); return res.json(); },
    enabled: view === 'logs',
  });

  // Fetch policies
  const { data: policiesData, isLoading: policiesLoading, refetch: refetchPolicies } = useQuery({
    queryKey: ['consent-policies'],
    queryFn: async () => { const res = await fetch('/api/consent/policies'); return res.json(); },
    enabled: view === 'policies',
  });

  const summary = summaryData as ConsentSummary | undefined;
  const selectedEmp = summary?.employees.find((e) => e.employee.id === selectedEmpId) ?? null;
  const consents: ConsentRecord[] = detailData?.data || [];
  const stats: ConsentStats = detailData?.stats || { total: 0, employees: 0, byStatus: { granted: 0, pending: 0, denied: 0, revoked: 0, expired: 0 }, byType: {} };
  const logs: ConsentLog[] = (logsData as { data: ConsentLog[] } | undefined)?.data || [];
  const policyGroups: PolicyGroup[] = (policiesData as { data: PolicyGroup[] } | undefined)?.data || [];

  const clearFilters = () => { setTypeFilter(''); setStatusFilter(''); setSearch(''); };

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card className="falcon-card p-0">
        <CardContent className="p-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <FileCheck className="h-5 w-5 text-white" />
              </div>
              <div>
                <h2 className="text-base font-semibold">Consent Management</h2>
                <p className="text-xs text-muted-foreground">Employee monitoring consent tracking &amp; compliance</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => { queryClient.invalidateQueries({ queryKey: ['consent'] }); queryClient.invalidateQueries({ queryKey: ['consent-summary'] }); queryClient.invalidateQueries({ queryKey: ['consent-logs'] }); }}>
              <RefreshCw className="h-4 w-4 mr-1" /> Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* View Toggle */}
      <div className="flex gap-1 p-1 rounded-lg bg-muted/50 w-fit flex-wrap">
        {([
          { key: 'overview' as const, label: 'Compliance Overview', icon: ShieldCheck },
          { key: 'details' as const, label: 'Consent Records', icon: Fingerprint },
          { key: 'policies' as const, label: 'Policies', icon: ScrollText },
          { key: 'logs' as const, label: 'Audit Trail', icon: History },
        ]).map(v => (
          <Button key={v.key} size="sm" variant={view === v.key ? 'default' : 'ghost'} className="h-8 text-xs gap-1.5" onClick={() => setView(v.key)}>
            <v.icon className="h-3.5 w-3.5" /> {v.label}
          </Button>
        ))}
      </div>

      {/* ===== OVERVIEW VIEW ===== */}
      {view === 'overview' && (
        <AnimatePresence mode="wait">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
            {/* Summary Stats */}
            {summaryLoading ? (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
              </div>
            ) : summary && (
              <>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  {[
                    { label: 'Total Employees', value: summary.summary.totalEmployees, icon: Users, color: 'text-slate-600', bg: 'bg-slate-100 dark:bg-slate-800' },
                    { label: 'Fully Compliant', value: summary.summary.fullyCompliant, icon: UserCheck, color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
                    { label: 'Non-Compliant', value: summary.summary.nonCompliant, icon: UserX, color: 'text-rose-600', bg: 'bg-rose-100 dark:bg-rose-900/30' },
                    { label: 'Overall Compliance', value: `${summary.summary.overallPct}%`, icon: ShieldCheck, color: summary.summary.overallPct >= 70 ? 'text-emerald-600' : 'text-amber-600', bg: summary.summary.overallPct >= 70 ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-amber-100 dark:bg-amber-900/30' },
                  ].map((card, i) => (
                    <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                      <Card className="falcon-card p-0">
                        <CardContent className="p-3 flex items-center gap-3">
                          <div className={`h-9 w-9 rounded-lg ${card.bg} flex items-center justify-center`}>
                            <card.icon className={`h-4 w-4 ${card.color}`} />
                          </div>
                          <div>
                            <p className="text-[10px] text-muted-foreground">{card.label}</p>
                            <p className={`text-lg font-bold ${card.color}`}>{card.value}</p>
                          </div>
                        </CardContent>
                      </Card>
                    </motion.div>
                  ))}
                </div>

                {/* Overall Compliance Bar */}
                <Card className="falcon-card p-0">
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between text-xs mb-2">
                      <span className="text-muted-foreground">Compliance Distribution</span>
                      <span className="font-medium">{summary.summary.overallPct}% average</span>
                    </div>
                    <div className="flex h-4 rounded-full overflow-hidden bg-muted">
                      <motion.div className="h-full bg-emerald-500" initial={{ width: 0 }} animate={{ width: `${summary.summary.fullyCompliant / Math.max(summary.summary.totalEmployees, 1) * 100}%` }} transition={{ duration: 0.8 }} />
                      <motion.div className="h-full bg-amber-400" initial={{ width: 0 }} animate={{ width: `${(summary.summary.totalEmployees - summary.summary.fullyCompliant - summary.summary.nonCompliant) / Math.max(summary.summary.totalEmployees, 1) * 100}%` }} transition={{ duration: 0.8, delay: 0.2 }} />
                      <motion.div className="h-full bg-rose-400" initial={{ width: 0 }} animate={{ width: `${summary.summary.nonCompliant / Math.max(summary.summary.totalEmployees, 1) * 100}%` }} transition={{ duration: 0.8, delay: 0.4 }} />
                    </div>
                    <div className="flex gap-4 mt-2 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1"><div className="h-2 w-2 rounded-full bg-emerald-500" /> Fully Compliant: {summary.summary.fullyCompliant}</span>
                      <span className="flex items-center gap-1"><div className="h-2 w-2 rounded-full bg-amber-400" /> Partial: {summary.summary.totalEmployees - summary.summary.fullyCompliant - summary.summary.nonCompliant}</span>
                      <span className="flex items-center gap-1"><div className="h-2 w-2 rounded-full bg-rose-400" /> Non-Compliant: {summary.summary.nonCompliant}</span>
                    </div>
                  </CardContent>
                </Card>

                {/* Type Breakdown */}
                <Card className="falcon-card p-0">
                  <CardContent className="p-3">
                    <h3 className="text-sm font-medium mb-3">Consent by Type</h3>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                      {summary.typeBreakdown.map((tb) => {
                        const cfg = TYPE_CONFIG[tb.type] || TYPE_CONFIG.monitoring;
                        return (
                          <motion.div key={tb.type} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.05 }} className="p-2.5 rounded-lg border border-border/50">
                            <div className="flex items-center gap-2 mb-1.5">
                              <div className={`h-6 w-6 rounded flex items-center justify-center ${cfg.bg}`}>
                                <cfg.icon className={`h-3 w-3 ${cfg.color}`} />
                              </div>
                              <span className="text-[11px] font-medium truncate">{cfg.label}</span>
                            </div>
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden mb-1">
                              <div className={`h-full rounded-full transition-all ${tb.pct >= 70 ? 'bg-emerald-500' : tb.pct >= 40 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${tb.pct}%` }} />
                            </div>
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                              <span>{tb.granted}/{tb.total} granted</span>
                              <span className="flex items-center gap-2">
                                {tb.requiresReconsent > 0 && (
                                  <span className="text-amber-600 font-medium" title="Granted against an outdated policy version">
                                    {tb.requiresReconsent} re-consent
                                  </span>
                                )}
                                {tb.denied > 0 && <span className="text-red-600">{tb.denied} denied</span>}
                                <span className={`font-semibold ${tb.pct >= 70 ? 'text-emerald-600' : tb.pct >= 40 ? 'text-amber-600' : 'text-rose-600'}`}>{tb.pct}%</span>
                              </span>
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>

                {/* Employee List */}
                <Card className="falcon-card p-0">
                  <CardContent className="p-3">
                    <h3 className="text-sm font-medium mb-3">Employee Compliance ({summary.employees.length})</h3>
                    <div className="space-y-1.5 max-h-[400px] overflow-y-auto pr-1">
                      {summary.employees.map((emp, idx) => {
                        const comp = COMPLIANCE_COLORS[emp.complianceStatus] || COMPLIANCE_COLORS.partial;
                        return (
                          <motion.div
                            key={emp.employee.id}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: Math.min(idx * 0.02, 0.5) }}
                            className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 cursor-pointer transition-colors"
                            onClick={() => { setSelectedEmpId(emp.employee.id); setDetailOpen(true); }}
                          >
                            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold shrink-0">
                              {emp.employee.firstName[0]}{emp.employee.lastName[0]}
                            </div>
                            <div className="flex-1 min-w-0">
                              <span className="flex items-center gap-1.5">
                                <PresenceDot employeeId={emp.employee.id} />
                                <p className="text-sm font-medium truncate">{emp.employee.firstName} {emp.employee.lastName}</p>
                              </span>
                              <p className="text-[10px] text-muted-foreground">{emp.employee.employeeId} · {emp.employee.designation || 'Employee'}</p>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <div className="w-16">
                                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                                  <div className={`h-full rounded-full ${emp.pct >= 80 ? 'bg-emerald-500' : emp.pct >= 50 ? 'bg-amber-500' : 'bg-rose-500'}`} style={{ width: `${emp.pct}%` }} />
                                </div>
                              </div>
                              <Badge variant="outline" className={`text-[9px] h-5 px-1.5 ${comp.bg} ${comp.text} border-0`}>
                                {emp.pct}%
                              </Badge>
                              <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                            </div>
                          </motion.div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              </>
            )}
          </motion.div>
        </AnimatePresence>
      )}

      {/* ===== DETAILS VIEW ===== */}
      {view === 'details' && (
        <AnimatePresence mode="wait">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
            {/* Stats row */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              {[
                { label: 'Total Records', value: stats.total, icon: Fingerprint, color: 'text-slate-600', bg: 'bg-slate-100 dark:bg-slate-800' },
                { label: 'Granted', value: stats.byStatus.granted, icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
                { label: 'Pending', value: stats.byStatus.pending, icon: Clock, color: 'text-amber-600', bg: 'bg-amber-100 dark:bg-amber-900/30' },
                { label: 'Denied', value: stats.byStatus.denied, icon: Ban, color: 'text-red-600', bg: 'bg-red-100 dark:bg-red-900/30' },
                { label: 'Revoked', value: stats.byStatus.revoked, icon: XCircle, color: 'text-rose-600', bg: 'bg-rose-100 dark:bg-rose-900/30' },
              ].map((card, i) => (
                <Card key={i} className="falcon-card p-0">
                  <CardContent className="p-3 flex items-center gap-3">
                    <div className={`h-9 w-9 rounded-lg ${card.bg} flex items-center justify-center`}>
                      <card.icon className={`h-4 w-4 ${card.color}`} />
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground">{card.label}</p>
                      <p className={`text-lg font-bold ${card.color}`}>{card.value}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Toolbar */}
            <Card className="falcon-card p-0">
              <CardContent className="p-3">
                <div className="flex flex-wrap gap-2 items-center">
                  <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input placeholder="Search employee..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 h-8 text-xs" />
                  </div>
                  <Select value={typeFilter || 'all'} onValueChange={(v) => setTypeFilter(v === 'all' ? '' : v)}>
                    <SelectTrigger className="h-8 text-xs w-[150px]">
                      <SelectValue placeholder="All Types" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Types</SelectItem>
                      {Object.entries(TYPE_CONFIG).map(([key, cfg]) => (
                        <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={statusFilter || 'all'} onValueChange={(v) => setStatusFilter(v === 'all' ? '' : v)}>
                    <SelectTrigger className="h-8 text-xs w-[120px]">
                      <SelectValue placeholder="Status" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Status</SelectItem>
                      <SelectItem value="granted">Granted</SelectItem>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="denied">Denied</SelectItem>
                      <SelectItem value="revoked">Revoked</SelectItem>
                      <SelectItem value="expired">Expired</SelectItem>
                    </SelectContent>
                  </Select>
                  {(typeFilter || statusFilter || search) && (
                    <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearFilters}>
                      <XCircle className="h-3 w-3 mr-1" /> Clear
                    </Button>
                  )}
                  <div className="flex-1" />
                  <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => refetchDetail()} disabled={detailLoading}>
                    <RefreshCw className={`h-3 w-3 mr-1 ${detailLoading ? 'animate-spin' : ''}`} /> Refresh
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Records List */}
            {detailLoading ? (
              <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
            ) : consents.length === 0 ? (
              <EmptyState icon={FileCheck} title="No consent records" description="Consent records will appear here when employees sign consent agreements." />
            ) : (
              <div className="space-y-1.5 max-h-[500px] overflow-y-auto pr-1">
                {consents.map((c, idx) => {
                  const typeCfg = TYPE_CONFIG[c.consentType] || TYPE_CONFIG.monitoring;
                  const statusCfg = STATUS_CONFIG[c.status] || STATUS_CONFIG.pending;
                  const StatusIcon = statusCfg.icon;
                  const TypeIcon = typeCfg.icon;
                  return (
                    <motion.div
                      key={c.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: Math.min(idx * 0.02, 0.4) }}
                      className={`falcon-card p-0 flex items-center gap-3 ${c.status === 'granted' ? 'border-l-2 border-l-emerald-500' : c.status === 'revoked' ? 'border-l-2 border-l-rose-500' : c.status === 'pending' ? 'border-l-2 border-l-amber-500' : c.status === 'denied' ? 'border-l-2 border-l-red-500' : 'border-l-2 border-l-slate-400'}`}
                    >
                      <CardContent className="p-3 flex items-center gap-3 flex-1 min-w-0">
                        <div className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${typeCfg.bg}`}>
                          <TypeIcon className={`h-4 w-4 ${typeCfg.color}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            {c.employee && (
                              <span className="text-sm font-medium">{c.employee.firstName} {c.employee.lastName}</span>
                            )}
                            <Badge variant={statusCfg.variant} className="text-[9px] h-4 px-1 gap-0.5">
                              <StatusIcon className="h-2.5 w-2.5" />
                              {statusCfg.label}
                            </Badge>
                            <Badge variant="outline" className="text-[9px] h-4 px-1">{c.consentVersion}</Badge>
                          </div>
                          <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
                            <span>{typeCfg.label}</span>
                            {c.employee?.department && <span>· {c.employee.department.name}</span>}
                            <span className="ml-auto">{new Date(c.createdAt).toLocaleDateString()}</span>
                          </div>
                        </div>
                      </CardContent>
                    </motion.div>
                  );
                })}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      )}

      {/* ===== POLICIES VIEW ===== */}
      {view === 'policies' && (
        <AnimatePresence mode="wait">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <PoliciesPanel groups={policyGroups} loading={policiesLoading} onRefresh={() => refetchPolicies()} />
          </motion.div>
        </AnimatePresence>
      )}

      {/* ===== LOGS VIEW ===== */}
      {view === 'logs' && (
        <AnimatePresence mode="wait">
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-4">
            <Card className="falcon-card p-0">
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Consent Audit Trail</h3>
                  <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => refetchLogs()} disabled={logsLoading}>
                    <RefreshCw className={`h-3 w-3 mr-1 ${logsLoading ? 'animate-spin' : ''}`} />
                  </Button>
                </div>
              </CardContent>
            </Card>

            {logsLoading ? (
              <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
            ) : logs.length === 0 ? (
              <EmptyState icon={History} title="No consent logs" description="Consent activity logs will appear here." />
            ) : (
              <div className="space-y-1.5 max-h-[500px] overflow-y-auto pr-1">
                {logs.map((log, idx) => (
                  <motion.div
                    key={log.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(idx * 0.02, 0.3) }}
                    className="falcon-card p-0"
                  >
                    <CardContent className="p-3 flex items-center gap-3">
                      <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 ${
                        log.action === 'granted' || log.action === 'renewed' ? 'bg-emerald-100 dark:bg-emerald-900/30' :
                        log.action === 'revoked' || log.action === 'admin_revoked' ? 'bg-rose-100 dark:bg-rose-900/30' :
                        'bg-slate-100 dark:bg-slate-800'
                      }`}>
                        {(log.action === 'granted' || log.action === 'renewed') ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> :
                         (log.action === 'revoked' || log.action === 'admin_revoked') ? <XCircle className="h-3.5 w-3.5 text-rose-600" /> :
                         <Clock className="h-3.5 w-3.5 text-slate-600" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs truncate">{log.description}</p>
                        <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                          <Badge variant="outline" className="text-[9px] h-4 px-1">{log.action}</Badge>
                          {log.performedBy && <span>by {log.performedBy}</span>}
                          <span className="ml-auto">{new Date(log.createdAt).toLocaleString()}</span>
                        </div>
                      </div>
                    </CardContent>
                  </motion.div>
                ))}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      )}

      <EmployeeConsentDialog emp={selectedEmp} open={detailOpen} onClose={() => setDetailOpen(false)} />
    </div>
  );
}
