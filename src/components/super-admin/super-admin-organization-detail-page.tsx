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
  LogIn,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

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
  createdAt: string;
  memberCount: number;
}

export function SuperAdminOrganizationDetailPage() {
  const { pageContext: orgId, pageContextLabel: orgName, setCurrentPage } = useAppStore();
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const login = useAuthStore((s) => s.login);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [switching, setSwitching] = useState(false);

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
  const { data: orgData, isLoading: orgLoading } = useQuery({
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
  const { data: membersData, isLoading: membersLoading, isError: membersError } = useQuery({
    queryKey: ['super-admin-org-members', orgId],
    queryFn: async () => {
      if (!orgId) return [] as Member[];
      const res = await fetch(`/api/organizations/${orgId}/members`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      return (data.members || []) as Member[];
    },
    enabled: !!orgId,
  });

  const members = membersData || [];
  const memberCount = orgData?.memberCount ?? members.length;

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

  const handleSwitchToOrganization = async () => {
    if (!orgId || switching) return;
    setSwitching(true);
    try {
      const res = await fetch('/api/me/organization/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'same-origin',
        body: JSON.stringify({ organizationId: orgId }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.organization && token && user) {
          login(token, user, {
            id: data.organization.id,
            name: data.organization.name,
            slug: data.organization.slug || data.organization.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            email: null,
            phone: null,
            address: null,
            logo: null,
            status: 'active',
            timezone: 'Asia/Dhaka',
            currency: 'USD',
          });
        }
        queryClient.invalidateQueries();
        toast.success(`Entered ${data.organization?.name || 'organization'}`);
        setCurrentPage('dashboard');
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to switch organization');
      }
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSwitching(false);
    }
  };

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
        <Button
          variant="default"
          size="sm"
          className="shrink-0"
          disabled={switching || (!orgData && orgLoading)}
          onClick={handleSwitchToOrganization}
        >
          {switching ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <LogIn className="w-4 h-4 mr-2" />}
          Switch to Organization
        </Button>
      </div>

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
