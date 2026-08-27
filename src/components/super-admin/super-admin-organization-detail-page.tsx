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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Users,
  Loader2,
  Search,
  Plus,
  Pause,
  Play,
  UserMinus,
  ChevronLeft,
  Monitor,
  FolderOpen,
  FileText,
  Shield,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const ORG_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  viewer: 'Viewer',
};
const ROLE_COLORS: Record<string, string> = {
  owner: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-400',
  admin: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400',
  manager: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400',
  viewer: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-900/30 dark:text-slate-400',
};
const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400',
  INVITED: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400',
  SUSPENDED: 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400',
  REMOVED: 'bg-slate-100 text-slate-500 border-slate-200 dark:bg-slate-900/30 dark:text-slate-400',
};
const EMPLOYEE_STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  inactive: 'bg-slate-100 text-slate-700 border-slate-200',
  archived: 'bg-amber-100 text-amber-700 border-amber-200',
};
const DEVICE_STATUS_COLORS: Record<string, string> = {
  online: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  offline: 'bg-slate-100 text-slate-700 border-slate-200',
  inactive: 'bg-amber-100 text-amber-700 border-amber-200',
};
const PROJECT_STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  on_hold: 'bg-amber-100 text-amber-700 border-amber-200',
  completed: 'bg-blue-100 text-blue-700 border-blue-200',
  cancelled: 'bg-slate-100 text-slate-700 border-slate-200',
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

interface Employee {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  designation: string | null;
  status: string;
  type: string;
  joinDate: string | null;
  createdAt: string;
  department: { id: string; name: string } | null;
  deviceCount: number;
}

interface Device {
  id: string;
  name: string;
  hostname: string | null;
  operatingSystem: string | null;
  status: string;
  lastHeartbeat: string | null;
  employee: { id: string; firstName: string; lastName: string; employeeId: string } | null;
}

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  priority: string;
  createdAt: string;
  department: { id: string; name: string } | null;
  memberCount: number;
}

interface AuditLog {
  id: string;
  action: string;
  resource: string;
  resourceId: string | null;
  description: string;
  userId: string | null;
  ipAddress: string | null;
  createdAt: string;
}

export function SuperAdminOrganizationDetailPage() {
  const { pageContext: orgId, pageContextLabel: orgName, setCurrentPage } = useAppStore();
  const token = useAuthStore((s) => s.token);
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('members');

  // Add member dialog
  const [addDialog, setAddDialog] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState('viewer');
  const [addLoading, setAddLoading] = useState(false);

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

  // ─── Members query ───────────────────────────────────────────────────
  const { data: membersData, isLoading: membersLoading } = useQuery({
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

  // ─── Employees query ─────────────────────────────────────────────────
  const { data: employeesData, isLoading: employeesLoading } = useQuery({
    queryKey: ['super-admin-org-employees', orgId],
    queryFn: async () => {
      if (!orgId) return { employees: [] as Employee[], pagination: { total: 0 } };
      const res = await fetch(`/api/super-admin/organizations/${orgId}/employees?pageSize=100`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load');
      return await res.json();
    },
    enabled: !!orgId && activeTab === 'employees',
  });

  // ─── Devices query ───────────────────────────────────────────────────
  const { data: devicesData, isLoading: devicesLoading } = useQuery({
    queryKey: ['super-admin-org-devices', orgId],
    queryFn: async () => {
      if (!orgId) return { devices: [] as Device[], pagination: { total: 0 } };
      const res = await fetch(`/api/super-admin/organizations/${orgId}/devices?pageSize=100`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load');
      return await res.json();
    },
    enabled: !!orgId && activeTab === 'devices',
  });

  // ─── Projects query ──────────────────────────────────────────────────
  const { data: projectsData, isLoading: projectsLoading } = useQuery({
    queryKey: ['super-admin-org-projects', orgId],
    queryFn: async () => {
      if (!orgId) return { projects: [] as Project[], pagination: { total: 0 } };
      const res = await fetch(`/api/super-admin/organizations/${orgId}/projects?pageSize=100`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load');
      return await res.json();
    },
    enabled: !!orgId && activeTab === 'projects',
  });

  // ─── Audit logs query ────────────────────────────────────────────────
  const { data: auditData, isLoading: auditLoading } = useQuery({
    queryKey: ['super-admin-org-audit', orgId],
    queryFn: async () => {
      if (!orgId) return { data: [] as AuditLog[], pagination: { total: 0 } };
      const res = await fetch(`/api/super-admin/organizations/${orgId}/audit-logs?pageSize=50`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load');
      return await res.json();
    },
    enabled: !!orgId && activeTab === 'audit',
  });

  const members = membersData || [];
  const employees = employeesData?.employees || [];
  const devices = devicesData?.devices || [];
  const projects = projectsData?.projects || [];
  const auditLogs = auditData?.data || [];

  // ─── Member actions ──────────────────────────────────────────────────
  const handleAddMember = async () => {
    if (!addEmail.trim() || !orgId) return;
    setAddLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'same-origin',
        body: JSON.stringify({ email: addEmail.trim().toLowerCase(), role: addRole }),
      });
      if (res.ok) {
        toast.success('Member added');
        setAddDialog(false);
        setAddEmail('');
        setAddRole('viewer');
        queryClient.invalidateQueries({ queryKey: ['super-admin-org-members', orgId] });
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to add member');
      }
    } catch {
      toast.error('Network error');
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
        toast.success(`Member ${statusDialog.newStatus === 'ACTIVE' ? 'reactivated' : 'suspended'}`);
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
        toast.success('Member removed');
        queryClient.invalidateQueries({ queryKey: ['super-admin-org-members', orgId] });
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCurrentPage('super-admin-organizations')}
          className="shrink-0"
        >
          <ChevronLeft className="w-4 h-4 mr-1" />
          Back
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{orgName || 'Organization'}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage organization details, members, and resources
          </p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="members" className="gap-1.5">
            <Users className="w-3.5 h-3.5" />
            Members
            <Badge variant="outline" className="text-[10px] ml-1 h-4 px-1">{members.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="employees" className="gap-1.5">
            <Users className="w-3.5 h-3.5" />
            Employees
            {employeesData?.pagination?.total !== undefined && (
              <Badge variant="outline" className="text-[10px] ml-1 h-4 px-1">{employeesData.pagination.total}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="devices" className="gap-1.5">
            <Monitor className="w-3.5 h-3.5" />
            Devices
            {devicesData?.pagination?.total !== undefined && (
              <Badge variant="outline" className="text-[10px] ml-1 h-4 px-1">{devicesData.pagination.total}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="projects" className="gap-1.5">
            <FolderOpen className="w-3.5 h-3.5" />
            Projects
            {projectsData?.pagination?.total !== undefined && (
              <Badge variant="outline" className="text-[10px] ml-1 h-4 px-1">{projectsData.pagination.total}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5">
            <FileText className="w-3.5 h-3.5" />
            Audit Logs
            {auditData?.pagination?.total !== undefined && (
              <Badge variant="outline" className="text-[10px] ml-1 h-4 px-1">{auditData.pagination.total}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ─── Members Tab ──────────────────────────────────────────────── */}
        <TabsContent value="members">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Users className="w-4 h-4" />
                  Members
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
              ) : filteredMembers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Users className="w-12 h-12 text-muted-foreground/40 mb-3" />
                  <p className="text-sm font-medium text-muted-foreground">No members found</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
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
        </TabsContent>

        {/* ─── Employees Tab ────────────────────────────────────────────── */}
        <TabsContent value="employees">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Users className="w-4 h-4" />
                Employees
                <Badge variant="outline" className="text-xs font-normal">{employeesData?.pagination?.total || 0}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {employeesLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : employees.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Users className="w-12 h-12 text-muted-foreground/40 mb-3" />
                  <p className="text-sm font-medium text-muted-foreground">No employees</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Employee</TableHead>
                        <TableHead>Department</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Devices</TableHead>
                        <TableHead>Joined</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {employees.map((emp: Employee) => (
                        <TableRow key={emp.id}>
                          <TableCell>
                            <div>
                              <p className="font-medium text-sm">{emp.firstName} {emp.lastName}</p>
                              <p className="text-xs text-muted-foreground">{emp.employeeId} · {emp.email}</p>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm">{emp.department?.name || '—'}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn('text-[10px] h-5 px-1.5 border', EMPLOYEE_STATUS_COLORS[emp.status] || '')}>
                              {emp.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm">{emp.deviceCount}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{emp.joinDate ? new Date(emp.joinDate).toLocaleDateString() : '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Devices Tab ──────────────────────────────────────────────── */}
        <TabsContent value="devices">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Monitor className="w-4 h-4" />
                Devices
                <Badge variant="outline" className="text-xs font-normal">{devicesData?.pagination?.total || 0}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {devicesLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : devices.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Monitor className="w-12 h-12 text-muted-foreground/40 mb-3" />
                  <p className="text-sm font-medium text-muted-foreground">No devices</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Device</TableHead>
                        <TableHead>Employee</TableHead>
                        <TableHead>OS</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Last Heartbeat</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {devices.map((dev: Device) => (
                        <TableRow key={dev.id}>
                          <TableCell>
                            <p className="font-medium text-sm">{dev.name}</p>
                            {dev.hostname && <p className="text-xs text-muted-foreground">{dev.hostname}</p>}
                          </TableCell>
                          <TableCell className="text-sm">{dev.employee ? `${dev.employee.firstName} ${dev.employee.lastName}` : '—'}</TableCell>
                          <TableCell className="text-sm">{dev.operatingSystem || '—'}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn('text-[10px] h-5 px-1.5 border', DEVICE_STATUS_COLORS[dev.status] || '')}>
                              {dev.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {dev.lastHeartbeat ? new Date(dev.lastHeartbeat).toLocaleString() : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Projects Tab ─────────────────────────────────────────────── */}
        <TabsContent value="projects">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FolderOpen className="w-4 h-4" />
                Projects
                <Badge variant="outline" className="text-xs font-normal">{projectsData?.pagination?.total || 0}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {projectsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : projects.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <FolderOpen className="w-12 h-12 text-muted-foreground/40 mb-3" />
                  <p className="text-sm font-medium text-muted-foreground">No projects</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Project</TableHead>
                        <TableHead>Department</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Priority</TableHead>
                        <TableHead>Members</TableHead>
                        <TableHead>Created</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {projects.map((proj: Project) => (
                        <TableRow key={proj.id}>
                          <TableCell>
                            <p className="font-medium text-sm">{proj.name}</p>
                            {proj.description && <p className="text-xs text-muted-foreground truncate max-w-[200px]">{proj.description}</p>}
                          </TableCell>
                          <TableCell className="text-sm">{proj.department?.name || '—'}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={cn('text-[10px] h-5 px-1.5 border', PROJECT_STATUS_COLORS[proj.status] || '')}>
                              {proj.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm capitalize">{proj.priority}</TableCell>
                          <TableCell className="text-sm">{proj.memberCount}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{new Date(proj.createdAt).toLocaleDateString()}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Audit Logs Tab ───────────────────────────────────────────── */}
        <TabsContent value="audit">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="w-4 h-4" />
                Audit Logs
                <Badge variant="outline" className="text-xs font-normal">{auditData?.pagination?.total || 0}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {auditLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : auditLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <FileText className="w-12 h-12 text-muted-foreground/40 mb-3" />
                  <p className="text-sm font-medium text-muted-foreground">No audit logs</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Action</TableHead>
                        <TableHead>Resource</TableHead>
                        <TableHead>Description</TableHead>
                        <TableHead>IP</TableHead>
                        <TableHead>Time</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {auditLogs.map((log: AuditLog) => (
                        <TableRow key={log.id}>
                          <TableCell>
                            <Badge variant="outline" className="text-[10px] h-5 px-1.5">{log.action}</Badge>
                          </TableCell>
                          <TableCell className="text-sm">{log.resource}</TableCell>
                          <TableCell className="text-sm max-w-[300px] truncate">{log.description}</TableCell>
                          <TableCell className="text-xs text-muted-foreground font-mono">{log.ipAddress || '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{new Date(log.createdAt).toLocaleString()}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ─── Dialogs ────────────────────────────────────────────────────── */}
      {/* Add Member Dialog */}
      <Dialog open={addDialog} onOpenChange={(open) => !open && setAddDialog(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Member</DialogTitle>
            <DialogDescription>Add an existing user to this organization by email.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium">Email</label>
              <Input placeholder="user@example.com" value={addEmail} onChange={(e) => setAddEmail(e.target.value)} className="mt-1" type="email"
                onKeyDown={(e) => e.key === 'Enter' && handleAddMember()} />
            </div>
            <div>
              <label className="text-sm font-medium">Role</label>
              <Select value={addRole} onValueChange={setAddRole}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ORG_ROLES.map((r) => (<SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddDialog(false)}>Cancel</Button>
            <Button disabled={addLoading || !addEmail.trim()} onClick={handleAddMember}>
              {addLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Add Member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Role Change Dialog */}
      <Dialog open={roleDialog.open} onOpenChange={(open) => !open && setRoleDialog({ ...roleDialog, open: false })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change Role</DialogTitle>
            <DialogDescription>Change the organization role for {roleDialog.name}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Select value={roleDialog.newRole} onValueChange={(v) => setRoleDialog({ ...roleDialog, newRole: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {ORG_ROLES.map((r) => (<SelectItem key={r} value={r}>{ROLE_LABELS[r]}</SelectItem>))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoleDialog({ ...roleDialog, open: false })}>Cancel</Button>
            <Button disabled={roleLoading || roleDialog.newRole === roleDialog.currentRole} onClick={handleRoleChange}>
              {roleLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Status Change Dialog */}
      <Dialog open={statusDialog.open} onOpenChange={(open) => !open && setStatusDialog({ ...statusDialog, open: false })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{statusDialog.newStatus === 'ACTIVE' ? 'Reactivate' : 'Suspend'} Member</DialogTitle>
            <DialogDescription>
              {statusDialog.newStatus === 'ACTIVE'
                ? `Reactivate ${statusDialog.name}'s membership?`
                : `Suspend ${statusDialog.name}'s membership? They will lose access to this organization.`}
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

      {/* Remove Member Dialog */}
      <Dialog open={removeDialog.open} onOpenChange={(open) => !open && setRemoveDialog({ open: false, userId: '', name: '' })}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Member</DialogTitle>
            <DialogDescription>Remove {removeDialog.name} from this organization? They will lose all access.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveDialog({ open: false, userId: '', name: '' })}>Cancel</Button>
            <Button variant="destructive" disabled={removeLoading} onClick={handleRemove}>
              {removeLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
