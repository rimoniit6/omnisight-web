'use client';

import { useEffect, useState } from 'react';
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
  Users,
  Loader2,
  Search,
  Plus,
  Pause,
  Play,
  UserMinus,
  ChevronLeft,
  Shield,
  Building2,
  Wallet,
  Pencil,
  KeyRound,
  Copy,
  Download,
  Eye,
  Ban,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ErrorState, LoadingBlock, Pagination } from './ui';

const ORG_ROLES = ['org_admin', 'manager', 'viewer'] as const;
const ROLE_LABELS: Record<string, string> = {
  org_admin: 'Organization Admin',
  admin: 'Organization Admin',  // legacy alias
  owner: 'Organization Admin',  // legacy alias
  manager: 'Manager',
  viewer: 'Viewer',
};
const ROLE_DESCRIPTIONS: Record<string, string> = {
  org_admin: 'Full administrative control over this organization, including users and settings.',
  manager: 'Can manage assigned operational areas but cannot perform organization administration.',
  viewer: 'Read-only access to permitted organization data.',
};
const ROLE_COLORS: Record<string, string> = {
  org_admin: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400',
  admin: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400',
  owner: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400',
  manager: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400',
  viewer: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/30 dark:text-slate-400',
};
const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400',
  INVITED: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400',
  SUSPENDED: 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400',
  REMOVED: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-900/30 dark:text-slate-400',
};
const ORG_STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  active: {
    label: 'Active',
    className: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400',
  },
  suspended: {
    label: 'Suspended',
    className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400',
  },
  archived: {
    label: 'Archived',
    className: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/30 dark:text-slate-400',
  },
};

interface Member {
  userId: string;
  email: string;
  name: string;
  avatar: string | null;
  isActive: boolean;
  role: string;
  roleLabel: string;
  status: string;
  createdAt: string;
}

interface OrganizationDetail {
  id: string;
  name: string;
  slug: string;
  status: string;
  deploymentMode: 'MANAGED' | 'CUSTOMER_DB' | 'PRIVATE';
  deploymentModeUnresolved: boolean;
  trialEndsAt: string | null;
  createdAt: string;
  memberCount: number;
  subscription: {
    id: string;
    status: string;
    startDate: string;
    endDate: string | null;
    plan: { id: string; name: string; priceMonthly: number; currency: string };
    invoices: {
      id: string;
      invoiceNumber: string;
      amount: number;
      currency: string;
      status: string;
      paidAt: string | null;
      paymentMethod: string | null;
      transactionId: string | null;
      dueDate: string;
      notes: string | null;
    }[];
  } | null;
  licenseKey: { id: string; isActive: boolean; isRevoked: boolean; validUntil: string } | null;
}

// ─── Manual Payments (payment history) ───────────────────────────────────
// Every payment is an independent Invoice row. Adding a payment creates a NEW
// record — existing history is never overwritten.
interface PaymentRow {
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
}

// ─── License (PRIVATE deployment runtime authorization) ──────────────────
// Reuses the existing license-key architecture — LicenseKey model, SA-gated
// /api/admin/licenses* mutations (atomic + audit-logged) and the public
// POST /api/license/validate contract the customer installation calls.
interface LicenseRow {
  id: string;
  key: string;
  validFrom: string;
  validUntil: string;
  isActive: boolean;
  isRevoked: boolean;
  revokedAt: string | null;
  createdAt: string;
  organization: { id: string; name: string };
  plan: { id: string; name: string };
}
interface SelfHostedPlanRow { id: string; name: string; isSelfHosted: boolean }
type LicenseState = 'none' | 'active' | 'expired' | 'revoked' | 'inactive';

// Expiry is computed, not trusted from a stored status: an expired license
// must never present itself as active.
function licenseStateOf(l: { isActive: boolean; isRevoked: boolean; validUntil: string } | null | undefined): LicenseState {
  if (!l) return 'none';
  if (l.isRevoked) return 'revoked';
  if (new Date(l.validUntil).getTime() <= Date.now()) return 'expired';
  if (!l.isActive) return 'inactive';
  return 'active';
}

const LICENSE_STATE_META: Record<LicenseState, { label: string; className: string }> = {
  none: { label: 'Not Issued', className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700' },
  active: { label: 'Active', className: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800' },
  expired: { label: 'Expired', className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800' },
  revoked: { label: 'Revoked', className: 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400 dark:border-rose-800' },
  inactive: { label: 'Inactive', className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-900/40 dark:text-slate-300 dark:border-slate-700' },
};

function maskLicenseKey(key: string): string {
  return key ? `${key.slice(0, 10)}••••-••••-••••` : '—';
}

export function SuperAdminOrganizationDetailPage() {
  const { pageContext: orgId, pageContextLabel: orgName, setCurrentPage } = useAppStore();
  const token = useAuthStore((s) => s.token);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');

  // Add user dialog
  const [addDialog, setAddDialog] = useState(false);
  const [addMode, setAddMode] = useState<'existing' | 'new'>('existing'); // existing user vs create new
  const [addSearch, setAddSearch] = useState('');
  const [addRole, setAddRole] = useState('viewer');
  const [addLoading, setAddLoading] = useState(false);
  const [selectedUser, setSelectedUser] = useState<{ id: string; name: string; email: string } | null>(null);
  // Create new user fields
  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');

  // Role change dialog
  const [roleDialog, setRoleDialog] = useState<{
    open: boolean;
    userId: string;
    name: string;
    currentRole: string;
    newRole: string;
  }>({ open: false, userId: '', name: '', currentRole: '', newRole: '' });
  const [roleLoading, setRoleLoading] = useState(false);

  // Status change dialog
  const [statusDialog, setStatusDialog] = useState<{
    open: boolean;
    userId: string;
    name: string;
    currentStatus: string;
    newStatus: string;
  }>({ open: false, userId: '', name: '', currentStatus: '', newStatus: '' });
  const [statusLoading, setStatusLoading] = useState(false);

  // Remove member dialog
  const [removeDialog, setRemoveDialog] = useState<{
    open: boolean;
    userId: string;
    name: string;
  }>({ open: false, userId: '', name: '' });
  const [removeLoading, setRemoveLoading] = useState(false);

  // ─── Organization metadata query ──────────────────────────────────────
  const { data: orgData, isLoading: orgLoading, isError: orgError, refetch: refetchOrg } = useQuery({
    queryKey: ['super-admin-org-detail', orgId],
    queryFn: async () => {
      if (!orgId) return null as OrganizationDetail | null;
      const res = await fetch(`/api/super-admin/organizations/${orgId}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load organization');
      const data = await res.json();
      return (data.organization || null) as OrganizationDetail | null;
    },
    enabled: !!orgId,
  });

  // ─── Members query ───────────────────────────────────────────────────
  const [membersPage, setMembersPage] = useState(1);
  const { data: membersData, isLoading: membersLoading, isError: membersError, refetch: refetchMembers } = useQuery({
    queryKey: ['super-admin-org-members', orgId, membersPage],
    queryFn: async () => {
      if (!orgId) return { members: [] as Member[], pagination: null };
      const res = await fetch(`/api/organizations/${orgId}/members?page=${membersPage}&pageSize=25`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      return {
        members: (data.members || []) as Member[],
        pagination: data.pagination
          ? {
              page: data.pagination.page,
              pageSize: data.pagination.pageSize,
              total: data.pagination.total,
              pages: data.pagination.pages,
            }
          : null,
      };
    },
    enabled: !!orgId,
  });

  const members = membersData?.members || [];
  const membersPagination = membersData?.pagination ?? null;
  const memberCount = orgData?.memberCount ?? members.length;

  // The member search filter is page-scoped, so a new query always restarts on
  // page 1 — a term must never invisibly filter a later page.
  useEffect(() => {
    setMembersPage(1);
  }, [search]);

  // ─── Manual payment (invoice ledger) ────────────────────────────────
  // ─── Manual Payments history (all invoices for this organization) ──────
  const { data: paymentsData, isLoading: paymentsLoading } = useQuery<{ invoices: PaymentRow[] }>({
    queryKey: ['sa-org-payments', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const res = await fetch(`/api/admin/invoices?organizationId=${orgId}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`invoices ${res.status}`);
      return res.json();
    },
  });
  const payments: PaymentRow[] = paymentsData?.invoices ?? [];
  const totalPaid = payments
    .filter((p) => p.status === 'PAID')
    .reduce((sum, p) => sum + Number(p.amount), 0);
  const paidCurrency = payments.find((p) => p.status === 'PAID')?.currency ?? 'BDT';

  // Add Payment dialog state
  const [addPayOpen, setAddPayOpen] = useState(false);
  const [addPayForm, setAddPayForm] = useState({
    amount: '',
    currency: 'BDT',
    paidAt: new Date().toISOString().slice(0, 10),
    paymentMethod: 'Bank_Transfer',
    transactionId: '',
    status: 'PAID',
    notes: '',
  });
  const [addPaySaving, setAddPaySaving] = useState(false);
  // View single payment dialog
  const [viewPay, setViewPay] = useState<PaymentRow | null>(null);
  const [payEdit, setPayEdit] = useState(false);
  const [payEditInvoice, setPayEditInvoice] = useState<PaymentRow | null>(null);
  const [payForm, setPayForm] = useState<{
    status: string;
    paymentMethod: string;
    transactionId: string;
    paidAt: string;
    notes: string;
  } | null>(null);
  const [paySaving, setPaySaving] = useState(false);

  const openPayEdit = (p: PaymentRow) => {
    setPayEditInvoice(p);
    setPayForm({
      status: p.status === 'CANCELLED' || p.status === 'OVERDUE' ? 'PENDING' : p.status,
      paymentMethod: p.paymentMethod ?? '',
      transactionId: p.transactionId ?? '',
      paidAt: p.paidAt ? new Date(p.paidAt).toISOString().slice(0, 10) : '',
      notes: p.notes ?? '',
    });
    setPayEdit(true);
  };

  // ─── Subscription activation (manual sales) ─────────────────────────
  // The subscription lifecycle is managed from the Organization. PENDING
  // subscriptions are activated here once the manual payment is confirmed —
  // the backend transition makes the organization operational (no separate
  // payment-verification workflow).
  const [activatingSub, setActivatingSub] = useState(false);
  const activateSubscription = async () => {
    const sub = orgData?.subscription;
    if (!sub || activatingSub) return;
    setActivatingSub(true);
    try {
      const res = await fetch(`/api/super-admin/subscriptions/${sub.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'activate' }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Activation failed');
        return;
      }
      toast.success('Subscription activated — organization is operational.');
      queryClient.invalidateQueries({ queryKey: ['super-admin-org-detail', orgId] });
      queryClient.invalidateQueries({ queryKey: ['super-admin-organizations'] });
      queryClient.invalidateQueries({ queryKey: ['sa-metrics'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setActivatingSub(false);
    }
  };

  // ─── License management (control plane, PRIVATE only) ────────────────
  const [issueOpen, setIssueOpen] = useState(false);
  const [issuePlanId, setIssuePlanId] = useState('');
  const [issueValidity, setIssueValidity] = useState<'1y' | '2y' | 'custom'>('1y');
  const [issueCustomUntil, setIssueCustomUntil] = useState('');
  const [issueSaving, setIssueSaving] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState('');
  const [revokeSaving, setRevokeSaving] = useState(false);

  const { data: licenseList } = useQuery<{ data: { licenses: LicenseRow[]; total: number } }>({
    queryKey: ['sa-org-licenses', orgId],
    enabled: !!orgId,
    queryFn: async () => {
      const res = await fetch(`/api/admin/licenses?organizationId=${orgId}&status=all`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`licenses ${res.status}`);
      return res.json();
    },
  });

  // Self-hosted plans available for license issuance (SA-gated catalog API).
  const { data: planCatalog } = useQuery<{ data: SelfHostedPlanRow[] }>({
    queryKey: ['sa-selfhosted-plans'],
    enabled: issueOpen,
    queryFn: async () => {
      const res = await fetch('/api/super-admin/packages?includeInactive=false&pageSize=200', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`packages ${res.status}`);
      return res.json();
    },
  });

  const licenseRows: LicenseRow[] = licenseList?.data?.licenses ?? [];
  const currentLicense: LicenseRow | null =
    licenseRows.find((l) => l.id === orgData?.licenseKey?.id) ?? licenseRows[0] ?? null;
  const licState = licenseStateOf(orgData?.licenseKey ?? currentLicense);
  const licensePlans: SelfHostedPlanRow[] = (planCatalog?.data ?? []).filter((p) => p.isSelfHosted);

  const issueLicense = async () => {
    if (issueSaving) return;
    // Presets are computed here but the server re-validates the final date.
    const validUntil =
      issueValidity === '1y'
        ? new Date(Date.now() + 365 * 864e5).toISOString()
        : issueValidity === '2y'
          ? new Date(Date.now() + 730 * 864e5).toISOString()
          : issueCustomUntil
            ? new Date(`${issueCustomUntil}T23:59:59`).toISOString()
            : '';
    if (!validUntil || Number.isNaN(new Date(validUntil).getTime())) {
      toast.error('Choose a validity period.');
      return;
    }
    setIssueSaving(true);
    try {
      const res = await fetch('/api/admin/licenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ organizationId: orgId, planId: issuePlanId, validUntil }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 = duplicate-active protection (server-side, never silent)
        toast.error(json.error ?? 'Failed to issue license');
        return;
      }
      toast.success('License issued — copy or download it for the customer installation.');
      setIssueOpen(false);
      queryClient.invalidateQueries({ queryKey: ['sa-org-licenses', orgId] });
      queryClient.invalidateQueries({ queryKey: ['super-admin-org-detail', orgId] });
      queryClient.invalidateQueries({ queryKey: ['super-admin-organizations'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setIssueSaving(false);
    }
  };

  const revokeLicense = async () => {
    if (revokeSaving || !currentLicense) return;
    setRevokeSaving(true);
    try {
      const res = await fetch(`/api/admin/licenses/${currentLicense.id}/revoke`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ reason: revokeReason.trim() || undefined }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to revoke license');
        return;
      }
      toast.success('License revoked — the customer installation will fail validation.');
      setRevokeOpen(false);
      setRevokeReason('');
      queryClient.invalidateQueries({ queryKey: ['sa-org-licenses', orgId] });
      queryClient.invalidateQueries({ queryKey: ['super-admin-org-detail', orgId] });
      queryClient.invalidateQueries({ queryKey: ['super-admin-organizations'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setRevokeSaving(false);
    }
  };

  const copyLicense = async () => {
    if (!currentLicense) return;
    try {
      await navigator.clipboard.writeText(currentLicense.key);
      toast.success('License copied to clipboard.');
    } catch {
      toast.error('Could not access the clipboard.');
    }
  };

  const downloadLicense = () => {
    if (!currentLicense || !orgData) return;
    // Customer-safe payload only: the license key is the activation secret;
    // no server secrets, signing material or internal identifiers.
    const payload = {
      product: 'OmniSight',
      licenseKey: currentLicense.key,
      organizationName: orgData.name,
      organizationSlug: orgData.slug,
      deploymentMode: 'PRIVATE',
      plan: currentLicense.plan.name,
      validFrom: currentLicense.validFrom,
      validUntil: currentLicense.validUntil,
      issuedAt: currentLicense.createdAt,
      validationEndpoint: '/api/license/validate',
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `omnisight-license-${orgData.slug}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('License downloaded.');
  };

  const savePayment = async () => {
    if (!payEditInvoice || !payForm) return;
    setPaySaving(true);
    try {
      const res = await fetch(`/api/admin/invoices/${payEditInvoice.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          status: payForm.status,
          paymentMethod: payForm.paymentMethod || null,
          transactionId: payForm.transactionId || null,
          paidAt: payForm.paidAt || null,
          notes: payForm.notes || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to update payment record');
        return;
      }
      toast.success('Manual payment record updated.');
      setPayEdit(false);
      queryClient.invalidateQueries({ queryKey: ['super-admin-org-detail', orgId] });
      queryClient.invalidateQueries({ queryKey: ['sa-org-payments', orgId] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setPaySaving(false);
    }
  };

  // ─── Add Payment — creates a NEW payment record (history is append-only) ─
  const recordPayment = async () => {
    if (addPaySaving) return;
    const amountNum = Number(addPayForm.amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      toast.error('Enter a positive payment amount.');
      return;
    }
    setAddPaySaving(true);
    try {
      const res = await fetch('/api/admin/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          organizationId: orgId,
          amount: amountNum,
          currency: addPayForm.currency,
          status: addPayForm.status,
          paidAt: addPayForm.paidAt ? new Date(`${addPayForm.paidAt}T00:00:00`).toISOString() : undefined,
          paymentMethod: addPayForm.paymentMethod || undefined,
          transactionId: addPayForm.transactionId.trim() || undefined,
          notes: addPayForm.notes.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to record payment');
        return;
      }
      toast.success(`Payment ${json.invoice?.invoiceNumber ?? ''} recorded — a new history entry was created.`);
      setAddPayOpen(false);
      setAddPayForm({
        amount: '',
        currency: addPayForm.currency,
        paidAt: new Date().toISOString().slice(0, 10),
        paymentMethod: 'Bank_Transfer',
        transactionId: '',
        status: 'PAID',
        notes: '',
      });
      queryClient.invalidateQueries({ queryKey: ['sa-org-payments', orgId] });
      queryClient.invalidateQueries({ queryKey: ['super-admin-org-detail', orgId] });
      queryClient.invalidateQueries({ queryKey: ['super-admin-organizations'] });
      queryClient.invalidateQueries({ queryKey: ['sa-metrics'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setAddPaySaving(false);
    }
  };

  // ─── Member actions ──────────────────────────────────────────────────
  // ─── User search for Add Member dialog ──────────────────────────────
  const { data: searchResults, isLoading: searchLoading } = useQuery({
    queryKey: ['user-search', addSearch],
    queryFn: async () => {
      const q = addSearch.trim();
      if (q.length < 2) return [] as { id: string; name: string; email: string }[];
      const res = await fetch(`/api/auth/users?search=${encodeURIComponent(q)}&limit=10`, {
        credentials: 'same-origin',
      });
      if (!res.ok) return [] as { id: string; name: string; email: string }[];
      const data = await res.json();
      return (data.users || []).map((u: { id: string; name: string; email: string }) => ({
        id: u.id,
        name: u.name,
        email: u.email,
      }));
    },
    enabled: addDialog && addSearch.trim().length >= 2 && !selectedUser,
  });

  // ─── Organization switching is NOT part of the Super Admin UX ───────
  // The platform administrator manages organizations from the control plane.
  // The org-switch API remains server-side for legitimate multi-membership
  // users and support use — only this UI path was removed (no
  // operational-access button replaces it).

  const handleAddMember = async () => {
    if (!selectedUser || !orgId) return;
    setAddLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'same-origin',
        body: JSON.stringify({ userId: selectedUser.id, role: addRole }),
      });
      if (res.ok) {
        toast.success('User added to organization');
        setAddDialog(false);
        setAddSearch('');
        setAddRole('viewer');
        setSelectedUser(null);
        setAddMode('existing');
        queryClient.invalidateQueries({ queryKey: ['super-admin-org-members', orgId] });
        queryClient.invalidateQueries({ queryKey: ['super-admin-organizations'] });
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to add user');
      }
    } catch {
      toast.error('Network error');
    } finally {
      setAddLoading(false);
    }
  };

  const handleCreateNewUser = async () => {
    if (!orgId || !newUserName.trim() || !newUserEmail.trim() || !newUserPassword.trim()) {
      return;
    }

    // Client-side validation: password policy (must match server-side)
    if (newUserPassword.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    if (!/[A-Z]/.test(newUserPassword)) {
      toast.error('Password must contain at least one uppercase letter');
      return;
    }
    if (!/[a-z]/.test(newUserPassword)) {
      toast.error('Password must contain at least one lowercase letter');
      return;
    }
    if (!ORG_ROLES.includes(addRole as typeof ORG_ROLES[number])) {
      toast.error('Please select a valid organization role');
      return;
    }

    setAddLoading(true);
    try {
      // AbortController for timeout protection (15s)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const res = await fetch('/api/auth/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({
          name: newUserName.trim(),
          email: newUserEmail.trim(),
          password: newUserPassword,
          role: addRole,
          organizationId: orgId,
        }),
      });
      clearTimeout(timeout);

      if (res.ok) {
        toast.success('User created and added to the organization');
        setAddDialog(false);
        setNewUserName('');
        setNewUserEmail('');
        setNewUserPassword('');
        setAddRole('viewer');
        setAddMode('existing');
        queryClient.invalidateQueries({ queryKey: ['super-admin-org-members', orgId] });
        queryClient.invalidateQueries({ queryKey: ['super-admin-organizations'] });
      } else {
        const err = await res.json().catch(() => ({}));
        if (res.status === 409) {
          toast.error('A user with this email already exists. Search for the existing user and add them instead.');
        } else if (res.status === 403) {
          toast.error(err.error || 'You do not have permission to create users');
        } else if (res.status === 400) {
          toast.error(err.error || 'Please check your input and try again');
        } else {
          toast.error(err.error || 'Failed to create user. Please try again.');
        }
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        toast.error('Request timed out. Please try again.');
      } else {
        toast.error('Network error. Please check your connection and try again.');
      }
    } finally {
      setAddLoading(false);
    }
  };

  const handleRoleChange = async () => {
    if (!roleDialog.userId || !orgId || !roleDialog.newRole) return;
    setRoleLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/${roleDialog.userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'same-origin',
        body: JSON.stringify({ role: roleDialog.newRole }),
      });
      if (res.ok) {
        toast.success('Role updated');
        queryClient.invalidateQueries({ queryKey: ['super-admin-org-members', orgId] });
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to update role');
      }
    } catch {
      toast.error('Network error');
    } finally {
      setRoleLoading(false);
      setRoleDialog({ open: false, userId: '', name: '', currentRole: '', newRole: '' });
    }
  };

  const handleStatusChange = async () => {
    if (!statusDialog.userId || !orgId) return;
    setStatusLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/${statusDialog.userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'same-origin',
        body: JSON.stringify({ status: statusDialog.newStatus }),
      });
      if (res.ok) {
        toast.success(`User ${statusDialog.newStatus === 'ACTIVE' ? 'reactivated' : 'suspended'}`);
        queryClient.invalidateQueries({ queryKey: ['super-admin-org-members', orgId] });
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to update status');
      }
    } catch {
      toast.error('Network error');
    } finally {
      setStatusLoading(false);
      setStatusDialog({ open: false, userId: '', name: '', currentStatus: '', newStatus: '' });
    }
  };

  const handleRemove = async () => {
    if (!removeDialog.userId || !orgId) return;
    setRemoveLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members/${removeDialog.userId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        credentials: 'same-origin',
      });
      if (res.ok) {
        toast.success('User removed from organization');
        queryClient.invalidateQueries({ queryKey: ['super-admin-org-members', orgId] });
        queryClient.invalidateQueries({ queryKey: ['super-admin-organizations'] });
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to remove member');
      }
    } catch {
      toast.error('Network error');
    } finally {
      setRemoveLoading(false);
      setRemoveDialog({ open: false, userId: '', name: '' });
    }
  };

  const filteredMembers = members.filter(
    (m) =>
      m.email.toLowerCase().includes(search.toLowerCase()) ||
      m.name.toLowerCase().includes(search.toLowerCase())
  );

  const orgStatus = orgData?.status ? ORG_STATUS_CONFIG[orgData.status] || ORG_STATUS_CONFIG.active : null;

  if (orgLoading) {
    return (
      <div className="space-y-6">
        <LoadingBlock label="Loading organization…" />
      </div>
    );
  }
  if (orgError) {
    return (
      <div className="space-y-6">
        <ErrorState title="Unable to load organization" onRetry={() => refetchOrg()} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div className="flex items-start gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCurrentPage('super-admin-organizations')}
            className="shrink-0 mt-0.5"
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Back
          </Button>
          <div>
            <div className="flex items-center gap-2.5 flex-wrap">
              <h1 className="text-2xl font-bold tracking-tight">{orgName || 'Organization'}</h1>
              {orgStatus && (
                <Badge variant="outline" className={cn('text-[10px] h-5 px-1.5 border', orgStatus.className)}>
                  {orgStatus.label}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5">
              <span className="inline-flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5" />
                Super Admin is managing this organization
              </span>
            </p>
            {orgData && orgData.deploymentMode !== 'MANAGED' && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                <p className="font-semibold">
                  {orgData.deploymentMode === 'CUSTOMER_DB' ? 'Customer-Owned Environment' : 'Private Deployment'}
                </p>
                <p className="mt-0.5">
                  {orgData.deploymentMode === 'CUSTOMER_DB'
                    ? 'Operational data is managed in the customer\u2019s infrastructure. Super Admin access is limited to control-plane management.'
                    : 'This organization\u2019s OmniSight environment is hosted in customer infrastructure. Operational data is not accessible from the central Super Admin console.'}
                </p>
              </div>
            )}
            {(orgData?.slug || orgData?.createdAt) && (
              <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                {orgData?.slug && (
                  <span className="inline-flex items-center gap-1">
                    <Building2 className="w-3 h-3" />
                    {orgData.slug}
                  </span>
                )}
                {orgData?.slug && orgData?.createdAt && <span>·</span>}
                {orgData?.createdAt && (
                  <span>Created {new Date(orgData.createdAt).toLocaleDateString()}</span>
                )}
                <span className="inline-flex items-center gap-1 ml-1">
                  <Users className="w-3 h-3" />
                  {memberCount} member{memberCount === 1 ? '' : 's'}
                </span>
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ─── Control-plane overview (Phase 2 §28) ─────────────────────────── */}
      {orgData && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="w-4 h-4" />
              Control Plane
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Service Type</p>
                <p className="font-medium mt-0.5">
                  {orgData.deploymentMode === 'MANAGED' ? 'Managed' : orgData.deploymentMode === 'CUSTOMER_DB' ? 'Customer DB' : 'Private'}
                  {orgData.deploymentModeUnresolved && <span className="text-amber-600"> · needs review</span>}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Package</p>
                <p className="font-medium mt-0.5">{orgData.subscription?.plan.name ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Subscription</p>
                <p className="font-medium mt-0.5">{orgData.subscription?.status ?? 'none'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">License</p>
                <p className="font-medium mt-0.5">
                  {!orgData.licenseKey
                    ? 'none'
                    : orgData.licenseKey.isRevoked
                      ? 'revoked'
                      : !orgData.licenseKey.isActive
                        ? 'inactive'
                        : 'active'}
                </p>
              </div>
            </div>

            {/* Subscription period + license validity + lifecycle action */}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">Subscription period</p>
                  <p className="font-medium mt-0.5">
                    {orgData.subscription
                      ? `${new Date(orgData.subscription.startDate).toLocaleDateString()} → ${orgData.subscription.endDate ? new Date(orgData.subscription.endDate).toLocaleDateString() : '—'}`
                      : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">License valid until</p>
                  <p className="font-medium mt-0.5">
                    {orgData.licenseKey?.validUntil ? new Date(orgData.licenseKey.validUntil).toLocaleDateString() : '—'}
                  </p>
                </div>
              </div>
              {orgData.subscription?.status === 'PENDING' && (
                <Button size="sm" onClick={activateSubscription} disabled={activatingSub}>
                  {activatingSub ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
                  Activate Subscription
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Manual Payments — full-width payment history (manual sales) ── */}
      {orgData && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <CardTitle className="text-base flex items-center gap-2">
                  <Wallet className="w-4 h-4" />
                  Manual Payments
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Payment history for this organization — every payment is a separate record.
                </p>
              </div>
              <Button size="sm" onClick={() => setAddPayOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                Add Payment
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {/* Lightweight summary — organization-specific, not analytics */}
            {payments.length > 0 && (
              <div className="grid grid-cols-3 gap-4 pb-4 border-b border-border/60 mb-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Total Paid</p>
                  <p className="font-semibold mt-0.5">
                    {paidCurrency} {totalPaid.toLocaleString()}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Payments</p>
                  <p className="font-semibold mt-0.5">{payments.length}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Latest Payment</p>
                  <p className="font-semibold mt-0.5">
                    {payments[0]?.paidAt
                      ? new Date(payments[0].paidAt).toLocaleDateString()
                      : payments[0]?.dueDate
                        ? new Date(payments[0].dueDate).toLocaleDateString()
                        : '—'}
                  </p>
                </div>
              </div>
            )}

            {paymentsLoading ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Loading payment history…
              </div>
            ) : payments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Wallet className="w-10 h-10 text-muted-foreground/40 mb-2" />
                <p className="text-sm font-medium text-muted-foreground">
                  No manual payments have been recorded for this organization yet.
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Paid plans create an invoice at provisioning; use Add Payment to record subsequent payments.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell>
                          <span className="text-sm">{p.paidAt ? new Date(p.paidAt).toLocaleDateString() : '—'}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm font-medium">
                            {p.currency} {Number(p.amount).toLocaleString()}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{p.paymentMethod?.replace(/_/g, ' ') ?? '—'}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm font-mono">{p.transactionId ?? p.invoiceNumber}</span>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px] h-5 px-1.5 border',
                              p.status === 'PAID'
                                ? 'border-emerald-200 bg-emerald-100 text-emerald-700 dark:border-emerald-900/30 dark:bg-emerald-900/30 dark:text-emerald-400'
                                : p.status === 'PENDING'
                                  ? 'border-amber-200 bg-amber-100 text-amber-700 dark:border-amber-900/30 dark:bg-amber-900/30 dark:text-amber-400'
                                  : p.status === 'CANCELLED'
                                    ? 'border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400'
                                    : 'border-rose-200 bg-rose-100 text-rose-700 dark:border-rose-900/30 dark:bg-rose-900/30 dark:text-rose-400'
                            )}
                          >
                            {p.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => setViewPay(p)}>
                              View
                            </Button>
                            <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={() => openPayEdit(p)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Add Payment dialog (creates a NEW record) ─────────────────── */}
      <Dialog open={addPayOpen} onOpenChange={setAddPayOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Add Manual Payment</DialogTitle>
            <DialogDescription>
              Records a new payment history entry. Existing payment records are never modified.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Organization</p>
                <p className="font-medium mt-0.5">{orgData?.name ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Package</p>
                <p className="font-medium mt-0.5">{orgData?.subscription?.plan.name ?? '—'}</p>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Amount</span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="e.g. 50000"
                  value={addPayForm.amount}
                  onChange={(e) => setAddPayForm({ ...addPayForm, amount: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Currency</span>
                <select
                  value={addPayForm.currency}
                  onChange={(e) => setAddPayForm({ ...addPayForm, currency: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {['BDT', 'USD', 'EUR', 'GBP', 'INR'].map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Payment date</span>
                <Input
                  type="date"
                  value={addPayForm.paidAt}
                  onChange={(e) => setAddPayForm({ ...addPayForm, paidAt: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Payment method</span>
                <select
                  value={addPayForm.paymentMethod}
                  onChange={(e) => setAddPayForm({ ...addPayForm, paymentMethod: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {['Bank_Transfer', 'bKash', 'Nagad', 'Rocket', 'Cash', 'Other'].map((m) => (
                    <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Reference</span>
                <Input
                  placeholder="e.g. bank ref or INV-2026-001"
                  value={addPayForm.transactionId}
                  onChange={(e) => setAddPayForm({ ...addPayForm, transactionId: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Payment status</span>
                <select
                  value={addPayForm.status}
                  onChange={(e) => setAddPayForm({ ...addPayForm, status: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="PAID">Paid</option>
                  <option value="PENDING">Pending</option>
                  <option value="OVERDUE">Overdue</option>
                  <option value="CANCELLED">Cancelled</option>
                </select>
              </label>
            </div>
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground mb-1 block">Notes</span>
              <textarea
                rows={3}
                placeholder="e.g. Annual Enterprise renewal"
                value={addPayForm.notes}
                onChange={(e) => setAddPayForm({ ...addPayForm, notes: e.target.value })}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
              />
            </label>
            <p className="text-xs text-muted-foreground border-t border-border pt-3">
              The subscription period this payment covers is managed from the Subscription section above — payment
              and service period remain separate records.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddPayOpen(false)}>
              Cancel
            </Button>
            <Button onClick={recordPayment} disabled={addPaySaving || !addPayForm.amount}>
              {addPaySaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Plus className="w-4 h-4 mr-2" />}
              Record Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── View single payment ─────────────────────────────────────────── */}
      <Dialog open={!!viewPay} onOpenChange={(o) => !o && setViewPay(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Payment {viewPay?.invoiceNumber}</DialogTitle>
            <DialogDescription>Independent payment record — editing affects only this entry.</DialogDescription>
          </DialogHeader>
          {viewPay && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm py-1">
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <p className="font-medium mt-0.5">{viewPay.status}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Amount</p>
                <p className="font-medium mt-0.5">
                  {viewPay.currency} {Number(viewPay.amount).toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Payment date</p>
                <p className="font-medium mt-0.5">{viewPay.paidAt ? new Date(viewPay.paidAt).toLocaleDateString() : '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Method</p>
                <p className="font-medium mt-0.5">{viewPay.paymentMethod?.replace(/_/g, ' ') ?? '—'}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Reference</p>
                <p className="font-mono font-medium mt-0.5">{viewPay.transactionId ?? viewPay.invoiceNumber}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Package</p>
                <p className="font-medium mt-0.5">{viewPay.planName ?? '—'}</p>
              </div>
              <div className="col-span-2">
                <p className="text-xs text-muted-foreground">Notes</p>
                <p className="font-medium mt-0.5 whitespace-pre-wrap">{viewPay.notes ?? '—'}</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setViewPay(null)}>
              Close
            </Button>
            {viewPay && (
              <Button
                variant="outline"
                onClick={() => {
                  const target = viewPay;
                  setViewPay(null);
                  openPayEdit(target);
                }}
              >
                <Pencil className="w-4 h-4 mr-2" />
                Edit
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={payEdit} onOpenChange={(o) => !o && setPayEdit(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit payment {payEditInvoice?.invoiceNumber}</DialogTitle>
            <DialogDescription>
              Modifies only this payment record. Historical payments remain untouched. No customer
              payment-verification workflow — the Super Admin records payments manually.
            </DialogDescription>
          </DialogHeader>
          {payForm && (
            <div className="space-y-4">
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Payment status</span>
                <select
                  value={payForm.status}
                  onChange={(e) => setPayForm({ ...payForm, status: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="PENDING">Pending</option>
                  <option value="PAID">Paid</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-4">
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground mb-1 block">Payment method</span>
                  <select
                    value={payForm.paymentMethod}
                    onChange={(e) => setPayForm({ ...payForm, paymentMethod: e.target.value })}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">—</option>
                    {['Bank_Transfer', 'bKash', 'Nagad', 'Rocket', 'Cash', 'Other'].map((m) => (
                      <option key={m} value={m}>
                        {m.replace(/_/g, ' ')}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground mb-1 block">Payment date</span>
                  <Input
                    type="date"
                    value={payForm.paidAt}
                    onChange={(e) => setPayForm({ ...payForm, paidAt: e.target.value })}
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Transaction / reference ID</span>
                <Input
                  placeholder="e.g. bank ref or bKash trx"
                  value={payForm.transactionId}
                  onChange={(e) => setPayForm({ ...payForm, transactionId: e.target.value })}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Notes</span>
                <textarea
                  rows={3}
                  value={payForm.notes}
                  onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
                />
              </label>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPayEdit(false)}>
              Cancel
            </Button>
            <Button onClick={savePayment} disabled={paySaving || !payForm}>
              {paySaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Save payment record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── License — PRIVATE deployment runtime authorization ────────── */}
      {orgData && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
              <CardTitle className="text-base flex items-center gap-2">
                <KeyRound className="w-4 h-4" />
                License
                <Badge variant="outline" className={cn('text-[10px] h-5 px-1.5 border', LICENSE_STATE_META[licState].className)}>
                  {LICENSE_STATE_META[licState].label}
                </Badge>
              </CardTitle>
              {orgData.deploymentMode === 'PRIVATE' && (
                <div className="flex flex-wrap items-center gap-2">
                  {(licState === 'none' || licState === 'expired' || licState === 'revoked' || licState === 'inactive') && (
                    <Button
                      size="sm"
                      onClick={() => {
                        setIssuePlanId(licensePlans[0]?.id ?? '');
                        setIssueValidity('1y');
                        setIssueCustomUntil('');
                        setIssueOpen(true);
                      }}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      Issue License
                    </Button>
                  )}
                  {currentLicense && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setViewOpen(true)}>
                        <Eye className="w-3.5 h-3.5 mr-1" />
                        View
                      </Button>
                      <Button size="sm" variant="outline" onClick={copyLicense}>
                        <Copy className="w-3.5 h-3.5 mr-1" />
                        Copy
                      </Button>
                      <Button size="sm" variant="outline" onClick={downloadLicense}>
                        <Download className="w-3.5 h-3.5 mr-1" />
                        Download
                      </Button>
                      {licState === 'active' && (
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            setRevokeReason('');
                            setRevokeOpen(true);
                          }}
                        >
                          <Ban className="w-3.5 h-3.5 mr-1" />
                          Revoke
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {orgData.deploymentMode !== 'PRIVATE' ? (
              <p className="text-sm text-muted-foreground">
                Licenses authorize PRIVATE (self-hosted) deployments. This{' '}
                {orgData.deploymentMode === 'MANAGED' ? 'Managed' : 'Customer DB'} organization is governed by its
                subscription and manual payment — no license is required.
              </p>
            ) : !currentLicense ? (
              <p className="text-sm text-muted-foreground">
                No license has been issued for this private deployment. Issue a license to authorize the customer
                installation to run OmniSight on its own infrastructure.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm md:grid-cols-3 lg:grid-cols-6">
                <div>
                  <p className="text-xs text-muted-foreground">License ID</p>
                  <p className="font-mono font-medium mt-0.5">{maskLicenseKey(currentLicense.key)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Deployment</p>
                  <p className="font-medium mt-0.5">Private</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Package</p>
                  <p className="font-medium mt-0.5">{currentLicense.plan.name}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Valid From</p>
                  <p className="font-medium mt-0.5">{new Date(currentLicense.validFrom).toLocaleDateString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Valid Until</p>
                  <p className="font-medium mt-0.5">{new Date(currentLicense.validUntil).toLocaleDateString()}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Issued</p>
                  <p className="font-medium mt-0.5">{new Date(currentLicense.createdAt).toLocaleDateString()}</p>
                </div>
              </div>
            )}
            {orgData.deploymentMode === 'PRIVATE' && licState === 'expired' && (
              <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
                This license has expired — the customer installation will fail validation until a new license is issued.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── License dialogs ─────────────────────────────────────────────── */}
      {orgData && (
        <>
          {/* Issue License — spacious dialog */}
          <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
            <DialogContent className="sm:max-w-xl">
              <DialogHeader>
                <DialogTitle>Issue Private Deployment License</DialogTitle>
                <DialogDescription>
                  Authorizes the customer to run the PRIVATE OmniSight deployment. Final dates are validated by the
                  server; an active license must be revoked before reissue.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-1">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Organization</p>
                    <p className="font-medium mt-0.5">{orgData.name}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Deployment</p>
                    <p className="font-medium mt-0.5">Private</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Package</p>
                    <p className="font-medium mt-0.5">{orgData.subscription?.plan.name ?? '—'}</p>
                  </div>
                </div>
                <label className="block">
                  <span className="text-xs font-medium text-muted-foreground mb-1 block">License plan</span>
                  <select
                    value={issuePlanId}
                    onChange={(e) => setIssuePlanId(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">—</option>
                    {licensePlans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs font-medium text-muted-foreground mb-1 block">Validity</span>
                    <select
                      value={issueValidity}
                      onChange={(e) => setIssueValidity(e.target.value as '1y' | '2y' | 'custom')}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      <option value="1y">1 Year</option>
                      <option value="2y">2 Years</option>
                      <option value="custom">Custom</option>
                    </select>
                  </label>
                  {issueValidity === 'custom' && (
                    <label className="block">
                      <span className="text-xs font-medium text-muted-foreground mb-1 block">Valid Until</span>
                      <Input
                        type="date"
                        value={issueCustomUntil}
                        onChange={(e) => setIssueCustomUntil(e.target.value)}
                      />
                    </label>
                  )}
                </div>
                <p className="text-xs text-muted-foreground border-t border-border pt-3">
                  This license authorizes the customer to run the PRIVATE OmniSight deployment. The customer activates
                  it on their installation via the public license validation endpoint.
                </p>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setIssueOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={issueLicense}
                  disabled={issueSaving || !issuePlanId || (issueValidity === 'custom' && !issueCustomUntil)}
                >
                  {issueSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <KeyRound className="w-4 h-4 mr-2" />}
                  Issue License
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* View License — spacious readable representation */}
          <Dialog open={viewOpen} onOpenChange={setViewOpen}>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>License Details</DialogTitle>
                <DialogDescription>
                  Customer-safe license information for this PRIVATE deployment.
                </DialogDescription>
              </DialogHeader>
              {currentLicense && (
                <div className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm py-1 md:grid-cols-3">
                  <div className="col-span-2 md:col-span-3">
                    <p className="text-xs text-muted-foreground">License ID</p>
                    <p className="font-mono font-medium mt-0.5 break-all">{currentLicense.key}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Status</p>
                    <p className="font-medium mt-0.5">{LICENSE_STATE_META[licState].label}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Organization</p>
                    <p className="font-medium mt-0.5">{orgData.name}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Deployment</p>
                    <p className="font-medium mt-0.5">Private</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Package</p>
                    <p className="font-medium mt-0.5">{currentLicense.plan.name}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Valid From</p>
                    <p className="font-medium mt-0.5">{new Date(currentLicense.validFrom).toLocaleDateString()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Expires</p>
                    <p className="font-medium mt-0.5">{new Date(currentLicense.validUntil).toLocaleDateString()}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Issued</p>
                    <p className="font-medium mt-0.5">{new Date(currentLicense.createdAt).toLocaleDateString()}</p>
                  </div>
                </div>
              )}
              <DialogFooter>
                <Button variant="ghost" onClick={() => setViewOpen(false)}>
                  Close
                </Button>
                <Button variant="outline" onClick={copyLicense}>
                  <Copy className="w-4 h-4 mr-2" />
                  Copy License
                </Button>
                <Button onClick={downloadLicense}>
                  <Download className="w-4 h-4 mr-2" />
                  Download
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Revoke License — explicit confirmation */}
          <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Revoke License?</DialogTitle>
                <DialogDescription>
                  This will invalidate the license for this private deployment. The customer installation will fail
                  validation on its next check.
                </DialogDescription>
              </DialogHeader>
              {currentLicense && (
                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
                  <p>
                    <span className="text-muted-foreground">License:</span>{' '}
                    <span className="font-mono">{maskLicenseKey(currentLicense.key)}</span>
                  </p>
                  <p className="mt-0.5">
                    <span className="text-muted-foreground">Organization:</span> {orgData.name}
                  </p>
                </div>
              )}
              <label className="block">
                <span className="text-xs font-medium text-muted-foreground mb-1 block">Reason (optional)</span>
                <Input
                  placeholder="e.g. contract ended"
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                  maxLength={500}
                />
              </label>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setRevokeOpen(false)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={revokeLicense} disabled={revokeSaving}>
                  {revokeSaving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Ban className="w-4 h-4 mr-2" />}
                  Revoke License
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* ─── Members section ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-4 h-4" />
              Members
              <Badge variant="outline" className="text-[10px] ml-1 h-4 px-1">{memberCount}</Badge>
            </CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search members..."
                  className="pl-9 w-56"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Button size="sm" onClick={() => setAddDialog(true)}>
                <Plus className="w-4 h-4 mr-1" />
                Add Member
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {membersLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : membersError ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Users className="w-12 h-12 text-muted-foreground/40 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">Failed to load members</p>
              <p className="text-xs text-muted-foreground mt-1">Please try again</p>
              <Button size="sm" variant="outline" className="mt-4" onClick={() => refetchMembers()}>
                Retry
              </Button>
            </div>
          ) : filteredMembers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Users className="w-12 h-12 text-muted-foreground/40 mb-3" />
              <p className="text-sm font-medium text-muted-foreground">No members yet</p>
              <p className="text-xs text-muted-foreground mt-1">Add members to this organization to get started</p>
              <Button size="sm" variant="outline" className="mt-4" onClick={() => setAddDialog(true)}>
                <Plus className="w-4 h-4 mr-1" />
                Add Member
              </Button>
            </div>
          ) : (
            <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Joined</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredMembers.map((member) => {
                    const initials = member.name
                      ? member.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
                      : member.email.slice(0, 2).toUpperCase();
                    return (
                      <TableRow key={member.userId}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 text-xs font-semibold text-primary">
                              {initials}
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-sm truncate">{member.name}</p>
                              <p className="text-xs text-muted-foreground truncate">{member.email}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn('text-[10px] h-5 px-1.5 border cursor-pointer', ROLE_COLORS[member.role] || ROLE_COLORS.viewer)}
                            onClick={() => setRoleDialog({ open: true, userId: member.userId, name: member.name, currentRole: member.role, newRole: member.role })}
                            title="Click to change role"
                          >
                            {ROLE_LABELS[member.role] || member.role}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('text-[10px] h-5 px-1.5 border', STATUS_COLORS[member.status] || STATUS_COLORS.ACTIVE)}>
                            {member.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className={cn('text-xs', member.isActive ? 'text-emerald-600' : 'text-rose-600')}>
                            {member.isActive ? 'Active' : 'Disabled'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-xs text-muted-foreground">{new Date(member.createdAt).toLocaleDateString()}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {member.status === 'ACTIVE' && (
                              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-amber-600 hover:text-amber-700"
                                onClick={() => setStatusDialog({ open: true, userId: member.userId, name: member.name, currentStatus: 'ACTIVE', newStatus: 'SUSPENDED' })}>
                                <Pause className="w-3 h-3 mr-1" />Suspend
                              </Button>
                            )}
                            {member.status === 'SUSPENDED' && (
                              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-emerald-600 hover:text-emerald-700"
                                onClick={() => setStatusDialog({ open: true, userId: member.userId, name: member.name, currentStatus: 'SUSPENDED', newStatus: 'ACTIVE' })}>
                                <Play className="w-3 h-3 mr-1" />Reactivate
                              </Button>
                            )}
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-rose-600 hover:text-rose-700"
                              onClick={() => setRemoveDialog({ open: true, userId: member.userId, name: member.name })}>
                              <UserMinus className="w-3 h-3 mr-1" />Remove
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {search.length === 0 && membersPagination && membersPagination.pages > 1 && (
              <Pagination
                page={membersPagination.page}
                pages={membersPagination.pages}
                total={membersPagination.total}
                pageSize={membersPagination.pageSize}
                onPage={setMembersPage}
              />
            )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ─── Dialogs ────────────────────────────────────────────────────── */}
      {/* Add User Dialog */}
      <Dialog open={addDialog} onOpenChange={(open) => {
        if (!open) {
          setAddDialog(false);
          setAddSearch('');
          setSelectedUser(null);
          setNewUserName('');
          setNewUserEmail('');
          setNewUserPassword('');
          setAddMode('existing');
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Member</DialogTitle>
            <DialogDescription>Search for an existing user or create a new one.</DialogDescription>
          </DialogHeader>

          {/* Mode tabs */}
          <div className="flex border-b border-border">
            <button
              type="button"
              className={`flex-1 py-2 text-sm font-medium transition-colors ${addMode === 'existing' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setAddMode('existing')}
            >
              Existing User
            </button>
            <button
              type="button"
              className={`flex-1 py-2 text-sm font-medium transition-colors ${addMode === 'new' ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => setAddMode('new')}
            >
              Create New User
            </button>
          </div>

          <div className="space-y-4 py-2">
            {addMode === 'existing' ? (
              <>
                {/* User search / selected display */}
                <div>
                  <label className="text-sm font-medium">Search User</label>
                  {selectedUser ? (
                    <div className="mt-1 flex items-center justify-between rounded-md border border-border bg-muted/50 px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{selectedUser.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{selectedUser.email}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 shrink-0 ml-2"
                        onClick={() => { setSelectedUser(null); setAddSearch(''); }}
                        aria-label="Remove selected user"
                      >
                        ×
                      </Button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        placeholder="Search by name or email..."
                        className="pl-9"
                        value={addSearch}
                        onChange={(e) => { setAddSearch(e.target.value); setSelectedUser(null); }}
                        aria-label="Search users"
                      />
                      {addSearch.trim().length >= 2 && (
                        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md max-h-60 overflow-y-auto">
                          {searchLoading ? (
                            <div className="flex items-center justify-center py-4">
                              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                            </div>
                          ) : searchResults && searchResults.length > 0 ? (
                            searchResults.map((u: { id: string; name: string; email: string }) => (
                              <button
                                key={u.id}
                                type="button"
                                className="w-full text-left px-3 py-2 hover:bg-accent hover:text-accent-foreground text-sm transition-colors"
                                onClick={() => {
                                  setSelectedUser(u);
                                  setAddSearch('');
                                }}
                              >
                                <p className="font-medium truncate">{u.name}</p>
                                <p className="text-xs text-muted-foreground truncate">{u.email}</p>
                              </button>
                            ))
                          ) : (
                            <div className="py-4 text-center text-sm text-muted-foreground">
                              No users found
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <>
                {/* Create new user fields */}
                <div>
                  <label className="text-sm font-medium">Full Name</label>
                  <Input
                    placeholder="e.g. Rahim Ahmed"
                    className="mt-1"
                    value={newUserName}
                    onChange={(e) => setNewUserName(e.target.value)}
                    aria-label="Full name"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Email</label>
                  <Input
                    type="email"
                    placeholder="e.g. rahim@example.com"
                    className="mt-1"
                    value={newUserEmail}
                    onChange={(e) => setNewUserEmail(e.target.value)}
                    aria-label="Email"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Password</label>
                  <Input
                    type="password"
                    placeholder="Minimum 8 characters"
                    className="mt-1"
                    value={newUserPassword}
                    onChange={(e) => setNewUserPassword(e.target.value)}
                    aria-label="Password"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    At least 8 characters with uppercase and lowercase letters.
                  </p>
                </div>
              </>
            )}

            {/* Role selection with descriptions */}
            <div>
              <label className="text-sm font-medium">Organization Role</label>
              <div className="mt-2 space-y-2">
                {ORG_ROLES.map((r) => (
                  <label
                    key={r}
                    className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                      addRole === r ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="add-role"
                      value={r}
                      checked={addRole === r}
                      onChange={() => setAddRole(r)}
                      className="mt-0.5 accent-primary"
                    />
                    <div>
                      <p className="text-sm font-medium">{ROLE_LABELS[r]}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{ROLE_DESCRIPTIONS[r]}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setAddDialog(false);
              setAddSearch('');
              setSelectedUser(null);
              setNewUserName('');
              setNewUserEmail('');
              setNewUserPassword('');
              setAddMode('existing');
            }}>Cancel</Button>
            <Button
              disabled={addLoading || (addMode === 'existing' && !selectedUser) || (addMode === 'new' && (!newUserName.trim() || !newUserEmail.trim() || newUserPassword.length < 8 || !/[A-Z]/.test(newUserPassword) || !/[a-z]/.test(newUserPassword) || !ORG_ROLES.includes(addRole as typeof ORG_ROLES[number])))}
              onClick={() => { if (addMode === 'existing') handleAddMember(); else handleCreateNewUser(); }}
            >
              {addLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {addMode === 'existing' ? 'Add Member' : 'Create User'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Role Change Dialog */}
      <Dialog open={roleDialog.open} onOpenChange={(open) => !open && setRoleDialog({ ...roleDialog, open: false })}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Organization Role</DialogTitle>
            <DialogDescription>Change the organization role for {roleDialog.name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Current role display */}
            <div>
              <label className="text-sm font-medium text-muted-foreground">Current Role</label>
              <p className="text-sm font-medium mt-1">{ROLE_LABELS[roleDialog.currentRole] || roleDialog.currentRole}</p>
            </div>
            {/* New role selection */}
            <div>
              <label className="text-sm font-medium">New Role</label>
              <div className="mt-2 space-y-2">
                {ORG_ROLES.map((r) => (
                  <label
                    key={r}
                    className={`flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors ${
                      roleDialog.newRole === r ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="role-change"
                      value={r}
                      checked={roleDialog.newRole === r}
                      onChange={() => setRoleDialog({ ...roleDialog, newRole: r })}
                      className="mt-0.5 accent-primary"
                    />
                    <div>
                      <p className="text-sm font-medium">{ROLE_LABELS[r]}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{ROLE_DESCRIPTIONS[r]}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialog({ ...roleDialog, open: false })}>Cancel</Button>
            <Button disabled={roleLoading || roleDialog.newRole === roleDialog.currentRole} onClick={handleRoleChange}>
              {roleLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Status Change Dialog */}
      <Dialog open={statusDialog.open} onOpenChange={(open) => !open && setStatusDialog({ ...statusDialog, open: false })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{statusDialog.newStatus === 'ACTIVE' ? 'Reactivate' : 'Suspend'} User</DialogTitle>
            <DialogDescription>
              {statusDialog.newStatus === 'ACTIVE'
                ? `Reactivate ${statusDialog.name}'s access to this organization?`
                : `Suspend ${statusDialog.name}'s access? They will lose access to this organization.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStatusDialog({ ...statusDialog, open: false })}>Cancel</Button>
            <Button variant={statusDialog.newStatus === 'ACTIVE' ? 'default' : 'destructive'} disabled={statusLoading} onClick={handleStatusChange}>
              {statusLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}{statusDialog.newStatus === 'ACTIVE' ? 'Reactivate' : 'Suspend'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove User from Organization Dialog */}
      <Dialog open={removeDialog.open} onOpenChange={(open) => !open && setRemoveDialog({ open: false, userId: '', name: '' })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove from Organization</DialogTitle>
            <DialogDescription>
              <span className="block">{removeDialog.name} will no longer have access to this organization.</span>
              <span className="block mt-1 text-xs text-muted-foreground">This does not delete the user's global account.</span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveDialog({ open: false, userId: '', name: '' })}>Cancel</Button>
            <Button variant="destructive" disabled={removeLoading} onClick={handleRemove}>
              {removeLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Remove User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
