'use client';

import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  FolderKanban,
  Plus,
  Search,
  Clock,
  Users,
  AlertTriangle,
  Calendar,
  BarChart3,
  UserPlus,
  LayoutGrid,
  List,
  Timer,
  Briefcase,
  CircleDollarSign,
  ChevronRight,
  Loader2,
  X,
  Pencil,
  Archive,
  RefreshCw,
  Building2,
  ChevronLeft,
  MoreHorizontal,
  Trash2,
  RotateCcw,
  Activity,
} from 'lucide-react';
import { ExportDialog } from '@/components/export/export-dialog';
import { BulkImportDialog } from '@/components/import/bulk-import-dialog';
import {
  formatHours,
  formatCurrency,
  getDaysLeft,
  isOverdue,
  getStatusColor,
  getStatusLabel,
  getPriorityColor,
  getProgressColor,
  getInitials,
  getAvatarColor,
} from '@/components/projects/projects-helpers';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmployeeCombobox, type EmployeeOption } from '@/components/employees/employee-combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { PresenceDot } from '@/components/ui/presence-dot';

import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { PdfDownloadButton } from '@/components/reports/pdf-download-button';
import { ProjectSentimentTab } from '@/components/projects/project-sentiment-tab';
import { useAppStore } from '@/lib/store';
import { useAuthStore } from '@/lib/store';
import { hasRolePermission } from '@/lib/auth';
import { format } from 'date-fns';

// ==================== Types ====================

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: string;
  priority: string;
  startDate: string | null;
  deadline: string | null;
  estimatedHours: number;
  color: string;
  tags: string | null;
  budgetType: string | null;
  hourlyRate: number | null;
  createdAt: string;
  updatedAt: string;
  departmentId: string | null;
  department: { id: string; name: string } | null;
  organization?: { id: string; name: string } | null;
  memberCount: number;
  totalHours: number;
  members: Array<{
    id: string;
    role: string;
    employee: { id: string; firstName: string; lastName: string; avatar: string | null };
  }>;
}

interface ProjectMember {
  id: string;
  projectId: string;
  employeeId: string;
  role: string;
  hoursPerWeek: number;
  joinedAt: string;
  leftAt: string | null;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    designation: string | null;
    department?: { name: string } | null;
  };
  /** Admin-selected active tracking project (null = none selected). */
  activeTrackingProjectId?: string | null;
  /** True when THIS project is the employee's active tracking project. */
  isActiveTracking?: boolean;
  _count: { timeEntries: number };
  totalHours: number;
}

interface TimeEntry {
  id: string;
  projectId: string;
  employeeId: string;
  date: string;
  hours: number;
  description: string | null;
  category: string | null;
  billable: boolean;
  /** MANUAL (admin-entered) or ACTIVITY_AUTO (derived from agent activity). */
  source?: string;
  createdAt: string;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
  };
}

interface ProjectStats {
  totalProjects: number;
  activeProjects: number;
  totalHours: number;
  dailyAverageHours: number;
  uniqueMembers: number;
  overdueCount: number;
}
// ==================== Main Component ====================

export function ProjectsPage() {
  const queryClient = useQueryClient();
  // RBAC parity (UI): project mutations are admin+ at the API — hide the
  // controls for viewers/managers instead of surfacing 403s.
  const role = useAuthStore((s) => s.user?.role ?? '');
  const canManageProjects = hasRolePermission(role, 'admin');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  // Archived (cancelled) projects are hidden by default; toggle to include them.
  const [includeArchived, setIncludeArchived] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [sortBy, setSortBy] = useState('newest');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [addMemberDialogOpen, setAddMemberDialogOpen] = useState(false);
  const [addTimeEntryDialogOpen, setAddTimeEntryDialogOpen] = useState(false);
  const [editTimeEntryDialogOpen, setEditTimeEntryDialogOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [deleteEntryDialogOpen, setDeleteEntryDialogOpen] = useState(false);
  const [entryToDelete, setEntryToDelete] = useState<TimeEntry | null>(null);
  const [savingTE, setSavingTE] = useState(false);
  const [deletingTE, setDeletingTE] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [editError, setEditError] = useState('');

  // Create project form
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formStatus, setFormStatus] = useState('active');
  const [formPriority, setFormPriority] = useState('medium');
  const [formStartDate, setFormStartDate] = useState('');
  const [formDeadline, setFormDeadline] = useState('');
  const [formEstimatedHours, setFormEstimatedHours] = useState('');
  const [formColor, setFormColor] = useState('#10b981');
  const [formBudgetType, setFormBudgetType] = useState('hourly');
  const [formHourlyRate, setFormHourlyRate] = useState('');
  const [formDepartmentId, setFormDepartmentId] = useState('');
  const [creating, setCreating] = useState(false);

  // Edit project form (seeded from the detail response on open)
  const [editForm, setEditForm] = useState({
    name: '',
    description: '',
    status: 'active',
    priority: 'medium',
    startDate: '',
    deadline: '',
    estimatedHours: '',
    color: '#10b981',
    budgetType: '',
    hourlyRate: '',
    departmentId: '',
  });

  // Add member form
  const [memberEmployeeId, setMemberEmployeeId] = useState('');
  const [memberRole, setMemberRole] = useState('member');
  const [memberHoursPerWeek, setMemberHoursPerWeek] = useState('40');
  const [updatingRoleId, setUpdatingRoleId] = useState<string | null>(null);

  // Active tracking project confirmation (set / clear) — Phase 8 UX.
  const [activeProjectAction, setActiveProjectAction] = useState<{ member: ProjectMember; action: 'set' | 'clear' } | null>(null);
  const [settingActiveProject, setSettingActiveProject] = useState(false);

  // Add time entry form
  const [teEmployeeId, setTeEmployeeId] = useState('');
  const [teDate, setTeDate] = useState(new Date().toISOString().split('T')[0]);
  const [teHours, setTeHours] = useState('');
  const [teDescription, setTeDescription] = useState('');
  const [teCategory, setTeCategory] = useState('development');
  const [teBillable, setTeBillable] = useState(true);
  const [addingTE, setAddingTE] = useState(false);

  // Edit time entry form (seeded from the entry being edited)
  const [editTE, setEditTE] = useState({
    employeeId: '',
    date: '',
    hours: '',
    description: '',
    category: 'development',
    billable: true,
  });
  const [editTEError, setEditTEError] = useState('');

  // Detail tab filters + time-entry pagination
  const [teDateFrom, setTeDateFrom] = useState('');
  const [teDateTo, setTeDateTo] = useState('');
  const [teCategoryFilter, setTeCategoryFilter] = useState('all');
  const [teMemberFilter, setTeMemberFilter] = useState('all');
  const [tePage, setTePage] = useState(1);
  const TE_PAGE_SIZE = 20;

  // Detail-dialog tab (controlled so My Portal can deep-link into Sentiment).
  const [detailTab, setDetailTab] = useState('overview');
  // My Portal deep link: pageContext "project:<id>:sentiment"
  const pageContext = useAppStore((s) => s.pageContext);

  useEffect(() => {
    if (!pageContext) return;
    const match = /^project:([^:]+)(?::(sentiment))?$/.exec(pageContext);
    if (match) {
      // Deep link from My Portal: open this project's detail dialog on the
      // requested tab. Deferred out of the effect body (lint-safe) since this
      // is a one-shot navigation intent, not a render-driven sync.
      const t = setTimeout(() => {
        setSelectedProjectId(match[1]);
        setDetailDialogOpen(true);
        if (match[2]) setDetailTab(match[2]);
      }, 0);
      return () => clearTimeout(t);
    }
  }, [pageContext]);

  const presetColors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

  // ==================== Queries ====================

  const { data: projectsData, isLoading, isError, refetch } = useQuery({
    queryKey: ['projects', debouncedSearch, statusFilter, priorityFilter, sortBy, page, pageSize, includeArchived],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
      });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (priorityFilter !== 'all') params.set('priority', priorityFilter);
      if (sortBy) params.set('sortBy', sortBy);
      if (includeArchived) params.set('includeArchived', 'true');
      const res = await fetch(`/api/projects?${params}`);
      if (!res.ok) throw new Error('Failed to fetch projects');
      return res.json();
    },
    placeholderData: keepPreviousData,
  });

  // Departments for the create/edit forms (org-scoped server list). Uses a
  // DEDICATED cache key: the shared ['departments'] key is contractually a
  // Department[] array (the Departments page reads it directly), so this
  // selector must never write the raw { data } envelope into that cache — and
  // conversely must not read another page's stale array as the envelope. It
  // returns the same Department[] shape, unwrapped from json.data.
  const { data: departments = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['departments-select'],
    queryFn: async () => {
      const res = await fetch('/api/departments');
      if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
          const json = await res.json();
          if (json?.error) message = json.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      const json = await res.json();
      return json.data || [];
    },
  });

  const { data: projectDetail } = useQuery({
    queryKey: ['project-detail', selectedProjectId],
    queryFn: async () => {
      if (!selectedProjectId) return null;
      const res = await fetch(`/api/projects/${selectedProjectId}`);
      if (!res.ok) throw new Error('Failed to fetch project detail');
      const json = await res.json();
      // The API wraps the project in { data }; unwrap so the dialog reads it
      // directly (name/status/members/timeEntries are all on the object).
      return json.data ?? null;
    },
    enabled: !!selectedProjectId && detailDialogOpen,
  });

  const { data: projectMembers } = useQuery({
    queryKey: ['project-members', selectedProjectId],
    queryFn: async () => {
      if (!selectedProjectId) return [];
      const res = await fetch(`/api/projects/${selectedProjectId}/members`);
      if (!res.ok) throw new Error('Failed to fetch project members');
      return res.json();
    },
    enabled: !!selectedProjectId && detailDialogOpen,
  });

  const { data: timeEntries } = useQuery({
    queryKey: ['project-time-entries', selectedProjectId, teDateFrom, teDateTo, teCategoryFilter, teMemberFilter, tePage, TE_PAGE_SIZE],
    queryFn: async () => {
      if (!selectedProjectId) return [];
      const params = new URLSearchParams({
        page: String(tePage),
        pageSize: String(TE_PAGE_SIZE),
      });
      if (teDateFrom) params.set('dateFrom', teDateFrom);
      if (teDateTo) params.set('dateTo', teDateTo);
      if (teCategoryFilter !== 'all') params.set('category', teCategoryFilter);
      if (teMemberFilter !== 'all') params.set('employeeId', teMemberFilter);
      const res = await fetch(`/api/projects/${selectedProjectId}/time-entries?${params}`);
      if (!res.ok) throw new Error('Failed to fetch time entries');
      return res.json();
    },
    enabled: !!selectedProjectId && detailDialogOpen,
    placeholderData: keepPreviousData,
  });

  // Project members mapped to the shared employee-option shape so the member
  // selects reuse the searchable combobox (client-side filtering — member
  // lists are small and already loaded).
  const memberOptions: EmployeeOption[] = useMemo(
    () =>
      (projectMembers?.data || projectMembers || []).map((m: ProjectMember) => ({
        id: m.employeeId,
        employeeId: m.employee.id || m.employeeId,
        firstName: m.employee.firstName,
        lastName: m.employee.lastName,
        email: m.employee.email ?? null,
        designation: null,
        avatar: null,
        departmentName: null,
      })),
    [projectMembers]
  );

  // ==================== Mutations ====================

  const createProjectMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let message = 'Failed to create project';
        try {
          const json = await res.json();
          if (json?.error) message = json.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Project created successfully');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setCreateDialogOpen(false);
      resetCreateForm();
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Failed to create project');
    },
  });

  const addMemberMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch(`/api/projects/${selectedProjectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to add member');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Member added to project');
      queryClient.invalidateQueries({ queryKey: ['project-members', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-detail', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-time-entries', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['employee-projects'] });
      setAddMemberDialogOpen(false);
      setMemberEmployeeId('');
      setMemberRole('member');
      setMemberHoursPerWeek('40');
    },
    onError: () => {
      toast.error('Failed to add member');
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (memberId: string) => {
      const res = await fetch(`/api/projects/${selectedProjectId}/members/${memberId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to remove member');
    },
    onSuccess: () => {
      toast.success('Member removed from project');
      queryClient.invalidateQueries({ queryKey: ['project-members', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-detail', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-time-entries', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['employee-projects'] });
    },
    onError: () => {
      toast.error('Failed to remove member');
    },
  });

  // Admin-controlled active tracking project (Phase 4 API). Targeted
  // invalidation only — the Team tab, project card and employee-projects
  // list refresh without a page reload.
  const setActiveProjectMutation = useMutation({
    mutationFn: async ({ employeeId, projectId }: { employeeId: string; projectId: string | null }) => {
      const res = await fetch(`/api/employees/${employeeId}/active-project`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        let message = 'Failed to update active tracking project';
        try {
          const json = await res.json();
          if (json?.error) message = json.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Active tracking project updated');
      queryClient.invalidateQueries({ queryKey: ['project-members', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-detail', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['employee-projects'] });
      setActiveProjectAction(null);
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Failed to update active tracking project');
    },
    onSettled: () => setSettingActiveProject(false),
  });

  const addTimeEntryMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch(`/api/projects/${selectedProjectId}/time-entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let message = 'Failed to add time entry';
        try {
          const json = await res.json();
          if (json?.error) message = json.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Time entry added');
      queryClient.invalidateQueries({ queryKey: ['project-time-entries', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-detail', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['employee-projects'] });
      setAddTimeEntryDialogOpen(false);
      resetTEForm();
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Failed to add time entry');
    },
  });

  const updateTimeEntryMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch(`/api/projects/${selectedProjectId}/time-entries/${editingEntry?.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let message = 'Failed to update time entry';
        try {
          const json = await res.json();
          if (json?.error) message = json.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Time entry updated');
      queryClient.invalidateQueries({ queryKey: ['project-time-entries', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-detail', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['employee-projects'] });
      setEditTimeEntryDialogOpen(false);
      setEditingEntry(null);
      setEditTEError('');
    },
    onError: (e) => {
      // Keep the dialog open on failure so the user can correct the form.
      setEditTEError(e instanceof Error ? e.message : 'Failed to update time entry');
    },
    onSettled: () => setSavingTE(false),
  });

  const deleteTimeEntryMutation = useMutation({
    mutationFn: async (entryId: string) => {
      const res = await fetch(`/api/projects/${selectedProjectId}/time-entries/${entryId}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete time entry');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Time entry deleted');
      queryClient.invalidateQueries({ queryKey: ['project-time-entries', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-detail', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['employee-projects'] });
      setDeleteEntryDialogOpen(false);
      setEntryToDelete(null);
    },
    onError: () => {
      toast.error('Failed to delete time entry');
    },
    onSettled: () => setDeletingTE(false),
  });

  const restoreProjectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${selectedProjectId}/restore`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error('Failed to restore project');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Project restored');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project-detail', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-members', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-time-entries', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['employee-projects'] });
      setDetailDialogOpen(false);
      setSelectedProjectId(null);
    },
    onError: () => {
      toast.error('Failed to restore project');
    },
  });

  const updateMemberRoleMutation = useMutation({
    mutationFn: async ({ memberId, role }: { memberId: string; role: string }) => {
      const res = await fetch(`/api/projects/${selectedProjectId}/members/${memberId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error('Failed to update member role');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Member role updated');
      queryClient.invalidateQueries({ queryKey: ['project-members', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-detail', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: () => {
      toast.error('Failed to update member role');
    },
    onSettled: () => setUpdatingRoleId(null),
  });

  const editProjectMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch(`/api/projects/${selectedProjectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let message = 'Failed to update project';
        try {
          const json = await res.json();
          if (json?.error) message = json.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Project updated');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project-detail', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-members', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-time-entries', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['employee-projects'] });
      setEditDialogOpen(false);
      setEditError('');
    },
    onError: (e) => {
      setEditError(e instanceof Error ? e.message : 'Failed to update project');
    },
    onSettled: () => setSavingEdit(false),
  });

  const archiveProjectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${selectedProjectId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to archive project');
      return res.json();
    },
    onSuccess: () => {
      toast.success('Project archived');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project-detail', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-members', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['project-time-entries', selectedProjectId] });
      queryClient.invalidateQueries({ queryKey: ['employee-projects'] });
      setArchiveDialogOpen(false);
      setDetailDialogOpen(false);
      setSelectedProjectId(null);
    },
    onError: () => {
      toast.error('Failed to archive project');
    },
    onSettled: () => setArchiving(false),
  });

  // ==================== Effects ====================

  // Debounce the search box so every keystroke doesn't hit the server.
  // Changing any filter/search/sort/page-size resets to page 1 so the user
  // never lands past the end of a narrowed result set.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  // ==================== Helpers ====================

  function resetCreateForm() {
    setFormName('');
    setFormDesc('');
    setFormStatus('active');
    setFormPriority('medium');
    setFormStartDate('');
    setFormDeadline('');
    setFormEstimatedHours('');
    setFormColor('#10b981');
    setFormBudgetType('hourly');
    setFormHourlyRate('');
    setFormDepartmentId('');
  }

  function resetTEForm() {
    setTeEmployeeId('');
    setTeDate(new Date().toISOString().split('T')[0]);
    setTeHours('');
    setTeDescription('');
    setTeCategory('development');
    setTeBillable(true);
  }

  function handleCreateProject() {
    if (!formName.trim()) {
      toast.error('Project name is required');
      return;
    }
    setCreating(true);
    createProjectMutation.mutate(
      {
        name: formName,
        description: formDesc || null,
        status: formStatus,
        priority: formPriority,
        startDate: formStartDate || null,
        deadline: formDeadline || null,
        estimatedHours: parseFloat(formEstimatedHours) || 0,
        color: formColor,
        budgetType: formBudgetType,
        hourlyRate: parseFloat(formHourlyRate) || null,
        departmentId: formDepartmentId || null,
      },
      {
        onSettled: () => setCreating(false),
      }
    );
  }

  function handleOpenDetail(id: string) {
    setSelectedProjectId(id);
    setTePage(1);
    setDetailDialogOpen(true);
    // Reset to the default tab when opening a project from the list (the
    // deep-link effect sets the tab to 'sentiment' when arriving from My
    // Portal).
    setDetailTab('overview');
  }

  /** Seed the edit form from the current detail response. */
  function openEditDialog() {
    if (!projectDetail) return;
    const p = projectDetail;
    setEditForm({
      name: p.name ?? '',
      description: p.description ?? '',
      status: p.status ?? 'active',
      priority: p.priority ?? 'medium',
      startDate: p.startDate ? String(p.startDate).slice(0, 10) : '',
      deadline: p.deadline ? String(p.deadline).slice(0, 10) : '',
      estimatedHours: p.estimatedHours != null ? String(p.estimatedHours) : '',
      color: p.color ?? '#10b981',
      budgetType: p.budgetType ?? 'hourly',
      hourlyRate: p.hourlyRate != null ? String(p.hourlyRate) : '',
      departmentId: p.departmentId ?? '',
    });
    setEditError('');
    setEditDialogOpen(true);
  }

  function handleSaveEdit() {
    if (!editForm.name.trim()) {
      setEditError('Project name is required');
      return;
    }
    setSavingEdit(true);
    editProjectMutation.mutate({
      name: editForm.name,
      description: editForm.description || null,
      status: editForm.status,
      priority: editForm.priority,
      startDate: editForm.startDate || null,
      deadline: editForm.deadline || null,
      estimatedHours: parseFloat(editForm.estimatedHours) || 0,
      color: editForm.color,
      budgetType: editForm.budgetType || null,
      hourlyRate: editForm.hourlyRate ? parseFloat(editForm.hourlyRate) : null,
      departmentId: editForm.departmentId || null,
    });
  }

  /** Seed the edit-entry form from the clicked entry and open the dialog. */
  function openEditEntryDialog(entry: TimeEntry) {
    setEditingEntry(entry);
    setEditTE({
      employeeId: entry.employeeId,
      date: String(entry.date).split('T')[0],
      hours: String(entry.hours),
      description: entry.description || '',
      category: entry.category || 'development',
      billable: entry.billable,
    });
    setEditTEError('');
    setEditTimeEntryDialogOpen(true);
  }

  function handleSaveTimeEntryEdit() {
    if (!editTE.employeeId || !editTE.hours || parseFloat(editTE.hours) <= 0) {
      setEditTEError('Please fill in all required fields');
      return;
    }
    setSavingTE(true);
    updateTimeEntryMutation.mutate({
      employeeId: editTE.employeeId,
      date: editTE.date,
      hours: parseFloat(editTE.hours),
      description: editTE.description || null,
      category: editTE.category,
      billable: editTE.billable,
    });
  }

  function confirmDeleteEntry() {
    if (!entryToDelete) return;
    setDeletingTE(true);
    deleteTimeEntryMutation.mutate(entryToDelete.id);
  }

  // ==================== Computed data ====================

  // The list is server-filtered, server-sorted and server-paginated — the
  // client renders exactly what the API returned (no re-filtering in memory).
  const projects: Project[] = useMemo(() => projectsData?.data || [], [projectsData]);
  const stats: ProjectStats | null = projectsData?.stats || null;
  const totalPages: number = projectsData?.totalPages ?? 1;
  const totalItems: number = projectsData?.total ?? projects.length;

  /** Page numbers with ellipsis for large result sets. */
  function getPageItems(current: number, total: number): Array<number | 'ellipsis'> {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
    const items: Array<number | 'ellipsis'> = [1];
    if (current > 3) items.push('ellipsis');
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) items.push(i);
    if (current < total - 2) items.push('ellipsis');
    items.push(total);
    return items;
  }

  const PAGE_SIZE_OPTIONS = [20, 50, 100];
  const pageItems = getPageItems(page, totalPages);
  const rangeFrom = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const rangeTo = Math.min(page * pageSize, totalItems);

  // Analytics computed data for detail dialog
  const analyticsData = useMemo(() => {
    const entries: TimeEntry[] = timeEntries?.data || timeEntries || [];
    const categoryHours: Record<string, number> = {};
    const memberHours: Record<string, { name: string; hours: number }> = {};
    const dailyHours: Record<string, number> = {};
    let billableHours = 0;
    let nonBillableHours = 0;

    entries.forEach((entry) => {
      // Category breakdown
      const cat = entry.category || 'uncategorized';
      categoryHours[cat] = (categoryHours[cat] || 0) + entry.hours;

      // Member breakdown
      const memberName = `${entry.employee.firstName} ${entry.employee.lastName}`;
      if (!memberHours[entry.employeeId]) {
        memberHours[entry.employeeId] = { name: memberName, hours: 0 };
      }
      memberHours[entry.employeeId].hours += entry.hours;

      // Daily breakdown
      const day = entry.date.split('T')[0];
      dailyHours[day] = (dailyHours[day] || 0) + entry.hours;

      // Billable
      if (entry.billable) {
        billableHours += entry.hours;
      } else {
        nonBillableHours += entry.hours;
      }
    });

    const last14Days: { date: string; hours: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      last14Days.push({ date: key, hours: dailyHours[key] || 0 });
    }

    return {
      categoryHours: Object.entries(categoryHours)
        .map(([category, hours]) => ({ category, hours }))
        .sort((a, b) => b.hours - a.hours),
      memberBreakdown: Object.values(memberHours).sort((a, b) => b.hours - a.hours),
      last14Days,
      billableHours,
      nonBillableHours,
      totalHours: entries.reduce((sum, e) => sum + e.hours, 0),
    };
  }, [timeEntries]);

  // ==================== Render ====================

  return (
    <div className="space-y-6" role="region" aria-label="Projects">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
            <FolderKanban className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground">Project Tracking</h1>
            <p className="text-sm text-muted-foreground">Manage and monitor all your projects</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center border rounded-lg overflow-hidden">
            <Button
              variant="ghost"
              size="sm"
              className={`rounded-none h-9 px-3 ${viewMode === 'cards' ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300' : ''}`}
              onClick={() => setViewMode('cards')}
            >
              <LayoutGrid className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={`rounded-none h-9 px-3 ${viewMode === 'table' ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300' : ''}`}
              onClick={() => setViewMode('table')}
            >
              <List className="w-4 h-4" />
            </Button>
          </div>
          {canManageProjects && (
            <Button
              onClick={() => setCreateDialogOpen(true)}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              <Plus className="w-4 h-4 mr-2" />
              New Project
            </Button>
          )}
        </div>
      </div>

      {/* Stats Bar */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4 md:p-6">
                <div className="flex items-center gap-4">
                  <Skeleton className="h-10 w-10 rounded-xl" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-7 w-16" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0 }}
          >
            <Card className="bg-card border rounded-xl p-4 md:p-6 shadow-sm hover:shadow-md transition-shadow">
              <CardContent className="p-0">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                    <FolderKanban className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Projects</p>
                    <p className="text-2xl font-bold">
                      {stats?.totalProjects ?? projects.length}
                      <span className="text-sm font-normal text-muted-foreground ml-1">
                        ({stats?.activeProjects ?? 0} active)
                      </span>
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
          >
            <Card className="bg-card border rounded-xl p-4 md:p-6 shadow-sm hover:shadow-md transition-shadow">
              <CardContent className="p-0">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-xl bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center">
                    <Clock className="w-5 h-5 text-sky-600 dark:text-sky-400" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Hours</p>
                    <p className="text-2xl font-bold">
                      {formatHours(stats?.totalHours ?? 0)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ~{formatHours(stats?.dailyAverageHours ?? 0)} / day avg
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <Card className="bg-card border rounded-xl p-4 md:p-6 shadow-sm hover:shadow-md transition-shadow">
              <CardContent className="p-0">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-xl bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                    <Users className="w-5 h-5 text-violet-600 dark:text-violet-400" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Team Members</p>
                    <p className="text-2xl font-bold">
                      {stats?.uniqueMembers ?? 0}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
            <Card className={`bg-card border rounded-xl p-4 md:p-6 shadow-sm hover:shadow-md transition-shadow ${(stats?.overdueCount ?? 0) > 0 ? 'border-orange-300 dark:border-orange-800' : ''}`}>
              <CardContent className="p-0">
                <div className="flex items-center gap-4">
                  <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${(stats?.overdueCount ?? 0) > 0 ? 'bg-orange-100 dark:bg-orange-900/30' : 'bg-emerald-100 dark:bg-emerald-900/30'}`}>
                    <AlertTriangle className={`w-5 h-5 ${(stats?.overdueCount ?? 0) > 0 ? 'text-orange-600 dark:text-orange-400' : 'text-emerald-600 dark:text-emerald-400'}`} />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Overdue</p>
                    <p className={`text-2xl font-bold ${(stats?.overdueCount ?? 0) > 0 ? 'text-orange-600 dark:text-orange-400' : ''}`}>
                      {stats?.overdueCount ?? 0}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex flex-col md:flex-row gap-3 items-start md:items-center">
        <div className="relative flex-1 w-full md:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search projects..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="All Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="on_hold">On Hold</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Select value={priorityFilter} onValueChange={(v) => { setPriorityFilter(v); setPage(1); }}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="All Priority" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Priority</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(v) => { setSortBy(v); setPage(1); }}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="deadline">Deadline</SelectItem>
              <SelectItem value="hours_most">Hours (Most)</SelectItem>
              <SelectItem value="hours_least">Hours (Least)</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className={includeArchived ? 'border-rose-300 text-rose-600 dark:border-rose-800 dark:text-rose-400' : ''}
            onClick={() => { setIncludeArchived(!includeArchived); setPage(1); }}
            aria-pressed={includeArchived}
          >
            <Archive className={`w-4 h-4 mr-1 ${includeArchived ? 'text-rose-500' : ''}`} />
            Include Archived
          </Button>
          {canManageProjects && (
            <BulkImportDialog
              importType="projects"
              title="Import Projects"
              onImportComplete={() => queryClient.invalidateQueries({ queryKey: ['projects'] })}
            />
          )}
          {hasRolePermission(role, 'manager') && (
            <ExportDialog
              exportType="projects"
              title="Export Projects"
              availableColumns={[
                { key: 'name', label: 'Name', defaultEnabled: true },
                { key: 'status', label: 'Status', defaultEnabled: true },
                { key: 'priority', label: 'Priority', defaultEnabled: true },
                { key: 'startDate', label: 'Start Date', defaultEnabled: true },
                { key: 'deadline', label: 'Deadline', defaultEnabled: true },
                { key: 'members', label: 'Members', defaultEnabled: true },
                { key: 'totalHours', label: 'Total Hours', defaultEnabled: true },
                { key: 'estimatedHours', label: 'Est. Hours', defaultEnabled: false },
                { key: 'budgetType', label: 'Budget Type', defaultEnabled: false },
              ]}
            />
          )}
        </div>
      </div>

      {/* Content Area */}
      {isLoading ? (
        viewMode === 'cards' ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="overflow-hidden">
                <Skeleton className="h-1" />
                <CardContent className="p-4 md:p-6 space-y-3">
                  <Skeleton className="h-5 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-1/2" />
                  <div className="flex gap-2">
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <Skeleton className="h-5 w-16 rounded-full" />
                  </div>
                  <Skeleton className="h-2 w-full" />
                  <div className="flex gap-1">
                    {Array.from({ length: 4 }).map((_, j) => (
                      <Skeleton key={j} className="h-7 w-7 rounded-full" />
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            </CardContent>
          </Card>
        )
      ) : isError ? (
        <Card className="bg-card border rounded-xl">
          <CardContent className="p-10 text-center space-y-3">
            <AlertTriangle className="w-10 h-10 mx-auto text-rose-500" />
            <p className="font-semibold text-foreground">Unable to load projects</p>
            <p className="text-sm text-muted-foreground">There was a problem fetching your projects. Please try again.</p>
            <Button variant="outline" onClick={() => refetch()}>
              <RefreshCw className="w-4 h-4 mr-2" /> Retry
            </Button>
          </CardContent>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects found"
          description={
            search || statusFilter !== 'all' || priorityFilter !== 'all'
              ? 'No matching projects. Try adjusting your search or filter criteria.'
              : 'No projects have been created yet. Get started by adding your first project.'
          }
          action={
            !search && statusFilter === 'all' && priorityFilter === 'all' && canManageProjects
              ? { label: 'New Project', onClick: () => setCreateDialogOpen(true) }
              : undefined
          }
        />
      ) : viewMode === 'cards' ? (
        /* Cards View */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <AnimatePresence mode="popLayout">
            {projects.map((project, index) => {
              const pct = project.estimatedHours > 0
                ? Math.min(100, (project.totalHours / project.estimatedHours) * 100)
                : 0;
              const overdue = isOverdue(project.deadline);
              const members = project.members ?? [];

              return (
                <motion.div
                  key={project.id}
                  initial={{ opacity: 0, y: 16, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.97 }}
                  transition={{ delay: index * 0.03, duration: 0.25 }}
                >
                  <Card
                    className="bg-card border rounded-xl p-4 md:p-6 shadow-sm hover:shadow-md transition-shadow cursor-pointer overflow-hidden"
                    onClick={() => handleOpenDetail(project.id)}
                  >
                    {/* Color accent bar */}
                    <div className="absolute top-0 left-0 right-0 h-1 rounded-t-xl" style={{ backgroundColor: project.color }} />

                    {/* Project name & description */}
                    <div className="pt-2">
                      <h3 className="font-bold text-foreground truncate">{project.name}</h3>
                      {project.description && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                          {project.description}
                        </p>
                      )}
                    </div>

                    {/* Badges */}
                    <div className="flex items-center gap-2 mt-3">
                      {project.status === 'cancelled' && (
                        <Badge variant="outline" className="text-xs bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                          <Archive className="w-3 h-3 mr-1" /> Archived
                        </Badge>
                      )}
                      <Badge variant="outline" className={`text-xs ${getStatusColor(project.status)}`}>
                        {getStatusLabel(project.status)}
                      </Badge>
                      <Badge variant="outline" className={`text-xs ${getPriorityColor(project.priority)}`}>
                        {project.priority.charAt(0).toUpperCase() + project.priority.slice(1)}
                      </Badge>
                    </div>

                    {/* Progress */}
                    <div className="mt-4">
                      <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                        <span>Progress</span>
                        <span>{Math.round(pct)}%</span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <motion.div
                          className={`h-full rounded-full ${getProgressColor(pct)}`}
                          initial={{ width: 0 }}
                          animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.6, delay: index * 0.03 }}
                        />
                      </div>
                    </div>

                    {/* Team avatars */}
                    <div className="flex items-center justify-between mt-4">
                      <div className="flex -space-x-2">
                        {members.slice(0, 4).map((m, mi) => (
                          <Avatar key={m.id} className="h-7 w-7 border-2 border-background">
                            <AvatarFallback className={`text-[10px] ${getAvatarColor(mi)}`}>
                              {getInitials(m.employee.firstName, m.employee.lastName)}
                            </AvatarFallback>
                          </Avatar>
                        ))}
                        {(project.memberCount || 0) > 4 && (
                          <div className="h-7 w-7 rounded-full bg-muted border-2 border-background flex items-center justify-center">
                            <span className="text-[10px] font-medium text-muted-foreground">
                              +{(project.memberCount || 0) - 4}
                            </span>
                          </div>
                        )}
                        {(project.memberCount || 0) === 0 && (
                          <span className="text-xs text-muted-foreground">No members</span>
                        )}
                      </div>
                      {project.budgetType && (
                        <Badge variant="secondary" className="text-[10px]">
                          {project.budgetType === 'hourly' ? <Timer className="w-3 h-3 mr-1" /> :
                           project.budgetType === 'fixed' ? <CircleDollarSign className="w-3 h-3 mr-1" /> :
                           <Briefcase className="w-3 h-3 mr-1" />}
                          {project.budgetType.charAt(0).toUpperCase() + project.budgetType.slice(1)}
                        </Badge>
                      )}
                    </div>

                    {/* Hours & Deadline */}
                    <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground border-t pt-3">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        {formatHours(project.totalHours)} / {formatHours(project.estimatedHours)} est.
                      </span>
                      {project.deadline && (
                        <span className={`flex items-center gap-1 ${overdue ? 'text-rose-600 dark:text-rose-400 font-medium' : ''}`}>
                          <Calendar className="w-3.5 h-3.5" />
                          {getDaysLeft(project.deadline)}
                        </span>
                      )}
                    </div>
                  </Card>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      ) : (
        /* Table View */
        <Card className="bg-card border rounded-xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Priority</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Progress</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Team</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Hours</th>
                  <th className="text-left px-4 py-3 font-medium text-muted-foreground">Deadline</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => {
                  const pct = project.estimatedHours > 0
                    ? Math.min(100, (project.totalHours / project.estimatedHours) * 100)
                    : 0;
                  const overdue = isOverdue(project.deadline);

                  return (
                    <tr
                      key={project.id}
                      className="border-b hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10 transition-colors cursor-pointer"
                      onClick={() => handleOpenDetail(project.id)}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: project.color }} />
                          <span className="font-medium truncate max-w-[200px]">{project.name}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {project.status === 'cancelled' && (
                            <Badge variant="outline" className="text-xs bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300">
                              <Archive className="w-3 h-3 mr-1" /> Archived
                            </Badge>
                          )}
                          <Badge variant="outline" className={`text-xs ${getStatusColor(project.status)}`}>
                            {getStatusLabel(project.status)}
                          </Badge>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className={`text-xs ${getPriorityColor(project.priority)}`}>
                          {project.priority.charAt(0).toUpperCase() + project.priority.slice(1)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 min-w-[100px]">
                          <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${getProgressColor(pct)}`} style={{ width: `${pct}%` }} />
                          </div>
                          <span className="text-xs text-muted-foreground w-8 text-right">{Math.round(pct)}%</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-muted-foreground">
                          {project.memberCount || 0} member{(project.memberCount || 0) !== 1 ? 's' : ''}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs">
                          {formatHours(project.totalHours)} / {formatHours(project.estimatedHours)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {project.deadline ? (
                          <span className={`text-xs ${overdue ? 'text-rose-600 dark:text-rose-400 font-medium' : 'text-muted-foreground'}`}>
                            {getDaysLeft(project.deadline)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Pagination — server-driven: page count comes from the database */}
      {!isLoading && !isError && totalPages > 1 && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted-foreground">
              Showing <span className="font-medium text-foreground">{rangeFrom}</span>–
              <span className="font-medium text-foreground">{rangeTo}</span> of{' '}
              <span className="font-medium text-foreground">{totalItems}</span> projects
            </p>
            <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
              <SelectTrigger className="w-28 h-8 text-xs" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} / page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            {pageItems.map((item, i) =>
              item === 'ellipsis' ? (
                <span key={`e-${i}`} className="h-8 w-8 flex items-center justify-center text-muted-foreground">
                  <MoreHorizontal className="w-4 h-4" />
                </span>
              ) : (
                <Button
                  key={item}
                  variant={item === page ? 'default' : 'outline'}
                  size="icon"
                  className={`h-8 w-8 text-xs ${item === page ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}`}
                  onClick={() => setPage(item)}
                  aria-label={`Page ${item}`}
                  aria-current={item === page ? 'page' : undefined}
                >
                  {item}
                </Button>
              )
            )}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* ==================== Create Project Dialog ==================== */}
      <Dialog open={createDialogOpen} onOpenChange={(open) => { setCreateDialogOpen(open); if (!open) resetCreateForm(); }}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <Plus className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              New Project
            </DialogTitle>
            <DialogDescription>Create a new project to track progress and hours.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                placeholder="Project name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                placeholder="Brief description of the project..."
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                rows={3}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={formStatus} onValueChange={setFormStatus}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="on_hold">On Hold</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={formPriority} onValueChange={setFormPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Start Date</Label>
                <Input
                  type="date"
                  value={formStartDate}
                  onChange={(e) => setFormStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Deadline</Label>
                <Input
                  type="date"
                  value={formDeadline}
                  onChange={(e) => setFormDeadline(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Estimated Hours</Label>
                <Input
                  type="number"
                  placeholder="e.g. 200"
                  value={formEstimatedHours}
                  onChange={(e) => setFormEstimatedHours(e.target.value)}
                  min={0}
                />
              </div>
              <div className="space-y-2">
                <Label>Department</Label>
                <Select value={formDepartmentId || 'none'} onValueChange={(v) => setFormDepartmentId(v === 'none' ? '' : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="No department" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No department</SelectItem>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex gap-2">
                {presetColors.map((c) => (
                  <button
                    key={c}
                    className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${formColor === c ? 'border-foreground scale-110' : 'border-transparent'}`}
                    style={{ backgroundColor: c }}
                    onClick={() => setFormColor(c)}
                    aria-label={`Select color ${c}`}
                  />
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Budget Type</Label>
                <Select value={formBudgetType} onValueChange={setFormBudgetType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">Fixed</SelectItem>
                    <SelectItem value="hourly">Hourly</SelectItem>
                    <SelectItem value="retainer">Retainer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Hourly Rate ($)</Label>
                <Input
                  type="number"
                  placeholder="e.g. 150"
                  value={formHourlyRate}
                  onChange={(e) => setFormHourlyRate(e.target.value)}
                  min={0}
                  step={0.01}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setCreateDialogOpen(false); resetCreateForm(); }}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateProject}
              disabled={creating || !formName.trim()}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {creating ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating...</>
              ) : (
                <><Plus className="w-4 h-4 mr-2" /> Create Project</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ==================== Project Detail Dialog ==================== */}
      <Dialog open={detailDialogOpen} onOpenChange={(open) => {
        setDetailDialogOpen(open);
        if (!open) {
          setSelectedProjectId(null);
          setTeDateFrom('');
          setTeDateTo('');
          setTeCategoryFilter('all');
          setTeMemberFilter('all');
          setTePage(1);
        }
      }}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          {projectDetail ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3">
                  <div className="h-3 w-3 rounded-full" style={{ backgroundColor: projectDetail.color || '#10b981' }} />
                  {projectDetail.name}
                  <div className="ml-auto flex items-center gap-2">
                    {projectDetail.status === 'cancelled' && canManageProjects && (
                      <Button size="sm" variant="outline" className="border-emerald-300 text-emerald-600 dark:border-emerald-800 dark:text-emerald-400" onClick={() => restoreProjectMutation.mutate()}>
                        <RotateCcw className="w-4 h-4 mr-1" /> Restore
                      </Button>
                    )}
                    {projectDetail.status !== 'cancelled' && canManageProjects && (
                      <Button size="sm" variant="outline" onClick={() => setArchiveDialogOpen(true)}>
                        <Archive className="w-4 h-4 mr-1" /> Archive
                      </Button>
                    )}
                    {canManageProjects && (
                      <Button size="sm" variant="outline" onClick={openEditDialog}>
                        <Pencil className="w-4 h-4 mr-1" /> Edit
                      </Button>
                    )}
                    <PdfDownloadButton
                      endpoint="/api/reports/pdf/project"
                      body={{ projectId: projectDetail.id }}
                      filename={`project-report-${projectDetail.name.replace(/\s+/g, '-').toLowerCase()}-${format(new Date(), 'yyyy-MM-dd')}.pdf`}
                      label="Export PDF"
                      size="sm"
                    />
                  </div>
                </DialogTitle>
                <DialogDescription>
                  {projectDetail.description || 'No description'}
                </DialogDescription>
              </DialogHeader>

              <Tabs value={detailTab} onValueChange={setDetailTab} className="mt-2">
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="team">Team</TabsTrigger>
                  <TabsTrigger value="time">Time Log</TabsTrigger>
                  <TabsTrigger value="analytics">Analytics</TabsTrigger>
                  <TabsTrigger value="sentiment">Sentiment</TabsTrigger>
                </TabsList>

                {/* Overview Tab */}
                <TabsContent value="overview" className="space-y-6 mt-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Status</p>
                      <Badge variant="outline" className={getStatusColor(projectDetail.status)}>
                        {getStatusLabel(projectDetail.status)}
                      </Badge>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Priority</p>
                      <Badge variant="outline" className={getPriorityColor(projectDetail.priority)}>
                        {projectDetail.priority.charAt(0).toUpperCase() + projectDetail.priority.slice(1)}
                      </Badge>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Budget Type</p>
                      <span className="text-sm font-medium">
                        {projectDetail.budgetType ? projectDetail.budgetType.charAt(0).toUpperCase() + projectDetail.budgetType.slice(1) : '—'}
                      </span>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Hourly Rate</p>
                      <span className="text-sm font-medium">
                        {projectDetail.hourlyRate ? formatCurrency(projectDetail.hourlyRate) : '—'}
                      </span>
                    </div>
                  </div>

                  {/* Department & Organization */}
                  {(projectDetail.department?.name || projectDetail.organization?.name) && (
                    <div className="flex flex-wrap items-center gap-3">
                      {projectDetail.department?.name && (
                        <Badge variant="secondary" className="text-xs">
                          <Building2 className="w-3.5 h-3.5 mr-1" /> {projectDetail.department.name}
                        </Badge>
                      )}
                      {projectDetail.organization?.name && (
                        <span className="text-xs text-muted-foreground">
                          {projectDetail.organization.name}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Timeline */}
                  <div className="space-y-2">
                    <p className="text-sm font-medium">Timeline</p>
                    <div className="flex items-center gap-3 text-sm">
                      <span className="text-muted-foreground">
                        {projectDetail.startDate ? new Date(projectDetail.startDate).toLocaleDateString() : 'Not set'}
                      </span>
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                      <span className={isOverdue(projectDetail.deadline) ? 'text-rose-600 dark:text-rose-400 font-medium' : 'text-muted-foreground'}>
                        {projectDetail.deadline ? new Date(projectDetail.deadline).toLocaleDateString() : 'No deadline'}
                      </span>
                      {projectDetail.deadline && (
                        <Badge variant="outline" className={`text-xs ${isOverdue(projectDetail.deadline) ? 'border-rose-300 text-rose-600 dark:border-rose-800 dark:text-rose-400' : ''}`}>
                          {getDaysLeft(projectDetail.deadline)}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Progress */}
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium">Progress</p>
                      <span className="text-sm text-muted-foreground">
                        {formatHours(projectDetail.totalHours || 0)} / {formatHours(projectDetail.estimatedHours)}
                      </span>
                    </div>
                    <div className="h-3 bg-muted rounded-full overflow-hidden">
                      <motion.div
                        className={`h-full rounded-full ${getProgressColor(
                          projectDetail.estimatedHours > 0
                            ? Math.min(100, ((projectDetail.totalHours || 0) / projectDetail.estimatedHours) * 100)
                            : 0
                        )}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${projectDetail.estimatedHours > 0 ? Math.min(100, ((projectDetail.totalHours || 0) / projectDetail.estimatedHours) * 100) : 0}%` }}
                        transition={{ duration: 0.5 }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground text-right">
                      {projectDetail.estimatedHours > 0
                        ? `${Math.round(((projectDetail.totalHours || 0) / projectDetail.estimatedHours) * 100)}% complete`
                        : 'No hours estimated'}
                    </p>
                  </div>

                  {/* Budget */}
                  {(projectDetail.hourlyRate || 0) > 0 && (
                    <div className="grid grid-cols-2 gap-3">
                      <Card className="bg-muted/30">
                        <CardContent className="p-4 text-center">
                          <p className="text-xs text-muted-foreground">Estimated Cost</p>
                          <p className="text-lg font-bold">
                            {formatCurrency((projectDetail.estimatedHours || 0) * (projectDetail.hourlyRate || 0))}
                          </p>
                        </CardContent>
                      </Card>
                      <Card className="bg-muted/30">
                        <CardContent className="p-4 text-center">
                          <p className="text-xs text-muted-foreground">Actual Cost</p>
                          <p className="text-lg font-bold">
                            {formatCurrency((projectDetail.totalHours || 0) * (projectDetail.hourlyRate || 0))}
                          </p>
                        </CardContent>
                      </Card>
                    </div>
                  )}
                </TabsContent>

                {/* Team Tab */}
                <TabsContent value="team" className="space-y-4 mt-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Project Members</p>
                    {canManageProjects && (
                      <Button size="sm" variant="outline" onClick={() => setAddMemberDialogOpen(true)}>
                        <UserPlus className="w-4 h-4 mr-1" /> Add Member
                      </Button>
                    )}
                  </div>

                  {(projectMembers?.data ?? []).length > 0 ? (
                    <div className="space-y-2">
                      {(projectMembers?.data ?? []).map((member: ProjectMember) => (
                        <div key={member.id} className="flex flex-wrap items-center gap-3 p-3 rounded-lg border hover:bg-muted/30 transition-colors">
                          <Avatar className="h-8 w-8">
                            <AvatarFallback className="text-xs bg-emerald-500">
                              {getInitials(member.employee.firstName, member.employee.lastName)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <p className="flex items-center gap-1.5 text-sm font-medium truncate">
                              <PresenceDot employeeId={member.employee.id} />
                              <span className="truncate">{member.employee.firstName} {member.employee.lastName}</span>
                            </p>
                            <p className="text-xs text-muted-foreground truncate">
                              {member.employee.email}
                              {member.employee.designation ? ` · ${member.employee.designation}` : ''}
                            </p>
                            {/* Admin-selected active tracking project — deliberately distinct from the presence "online" dot */}
                            {member.isActiveTracking ? (
                              <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400 mt-0.5">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
                                Active Tracking Project
                              </p>
                            ) : (
                              <p className="flex items-center gap-1.5 text-xs text-muted-foreground mt-0.5">
                                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50 inline-block" />
                                Assigned
                              </p>
                            )}
                          </div>
                          {/* Project-specific role (distinct from the employee's global designation) */}
                          <Select
                            value={member.role}
                            disabled={updatingRoleId !== null || !canManageProjects}
                            onValueChange={(v) => {
                              setUpdatingRoleId(member.id);
                              updateMemberRoleMutation.mutate({ memberId: member.id, role: v });
                            }}
                          >
                            <SelectTrigger className="w-32 h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="lead">Lead</SelectItem>
                              <SelectItem value="member">Member</SelectItem>
                              <SelectItem value="reviewer">Reviewer</SelectItem>
                              <SelectItem value="stakeholder">Stakeholder</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="text-right">
                            <p className="text-sm font-medium">{formatHours(member.totalHours || 0)}</p>
                            <p className="text-xs text-muted-foreground">{member.hoursPerWeek}h/wk target</p>
                          </div>
                          {canManageProjects && (
                            <div className="flex items-center gap-1">
                              {member.isActiveTracking ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 text-xs text-emerald-600 dark:text-emerald-400"
                                  aria-label={`Clear ${member.employee.firstName} ${member.employee.lastName}'s active tracking project`}
                                  onClick={() => setActiveProjectAction({ member, action: 'clear' })}
                                >
                                  Clear Active
                                </Button>
                              ) : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-8 text-xs"
                                  aria-label={`Set ${member.employee.firstName} ${member.employee.lastName}'s active tracking project`}
                                  onClick={() => setActiveProjectAction({ member, action: 'set' })}
                                >
                                  Set as Active
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-rose-600"
                                aria-label={`Remove ${member.employee.firstName} ${member.employee.lastName} from project`}
                                onClick={() => removeMemberMutation.mutate(member.id)}
                              >
                                <X className="w-4 h-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      icon={Users}
                      title="No members yet"
                      description="Add team members to start tracking their contributions."
                    />
                  )}
                </TabsContent>

                {/* Time Log Tab */}
                <TabsContent value="time" className="space-y-4 mt-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">Time Entries</p>
                    {canManageProjects && (
                      <Button size="sm" variant="outline" onClick={() => setAddTimeEntryDialogOpen(true)}>
                        <Plus className="w-4 h-4 mr-1" /> Add Entry
                      </Button>
                    )}
                  </div>

                  {/* Filters */}
                  <div className="flex flex-wrap gap-2">
                    <Input
                      type="date"
                      className="w-40"
                      value={teDateFrom}
                      onChange={(e) => { setTeDateFrom(e.target.value); setTePage(1); }}
                      placeholder="From"
                    />
                    <Input
                      type="date"
                      className="w-40"
                      value={teDateTo}
                      onChange={(e) => { setTeDateTo(e.target.value); setTePage(1); }}
                      placeholder="To"
                    />
                    <Select value={teCategoryFilter} onValueChange={(v) => { setTeCategoryFilter(v); setTePage(1); }}>
                      <SelectTrigger className="w-32">
                        <SelectValue placeholder="Category" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All</SelectItem>
                        <SelectItem value="development">Development</SelectItem>
                        <SelectItem value="design">Design</SelectItem>
                        <SelectItem value="meeting">Meeting</SelectItem>
                        <SelectItem value="research">Research</SelectItem>
                        <SelectItem value="testing">Testing</SelectItem>
                        <SelectItem value="review">Review</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <EmployeeCombobox
                      value={teMemberFilter === 'all' ? null : teMemberFilter}
                      onValueChange={(v) => { setTeMemberFilter((v as string) ?? 'all'); setTePage(1); }}
                      options={memberOptions}
                      placeholder="Member"
                      allowClear
                      clearLabel="All Members"
                      className="w-40"
                      ariaLabel="Filter by member"
                    />
                  </div>

                  {/* Time entries list */}
                  {timeEntries && ((timeEntries.data || timeEntries || []).length > 0) ? (
                    <div className="space-y-2">
                      {(timeEntries.data || timeEntries || []).map((entry: TimeEntry) => (
                        <div key={entry.id} className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/30 transition-colors text-sm">
                          <div className="w-16 text-muted-foreground">
                            {new Date(entry.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">
                              {entry.employee.firstName} {entry.employee.lastName}
                            </p>
                            {entry.description && (
                              <p className="text-xs text-muted-foreground truncate">{entry.description}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{formatHours(entry.hours)}</span>
                            {entry.category && (
                              <Badge variant="secondary" className="text-[10px]">
                                {entry.category.charAt(0).toUpperCase() + entry.category.slice(1)}
                              </Badge>
                            )}
                            {entry.source === 'ACTIVITY_AUTO' ? (
                              <Badge className="text-[10px] bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300 border-0">
                                <Activity className="w-3 h-3 mr-0.5" /> Activity Tracking
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[10px]">
                                Manual
                              </Badge>
                            )}
                            <Badge variant="outline" className={`text-[10px] ${entry.billable ? 'text-emerald-600 border-emerald-300 dark:border-emerald-700' : 'text-muted-foreground'}`}>
                              {entry.billable ? 'Billable' : 'Non-billable'}
                            </Badge>
                            {canManageProjects && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-sky-600"
                                  aria-label="Edit time entry"
                                  onClick={() => openEditEntryDialog(entry)}
                                >
                                  <Pencil className="w-3.5 h-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-muted-foreground hover:text-rose-600"
                                  aria-label="Delete time entry"
                                  onClick={() => { setEntryToDelete(entry); setDeleteEntryDialogOpen(true); }}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      icon={Timer}
                      title="No time entries"
                      description="Start logging time to track project progress."
                    />
                  )}

                  {/* Time entries pagination (server-driven) */}
                  {(timeEntries?.totalPages ?? 1) > 1 && (
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                      <p className="text-xs text-muted-foreground">
                        Showing {(tePage - 1) * TE_PAGE_SIZE + 1}–{Math.min(tePage * TE_PAGE_SIZE, timeEntries?.total ?? 0)} of {timeEntries?.total ?? 0} entries
                      </p>
                      <div className="flex items-center gap-1">
                        <Button variant="outline" size="icon" className="h-8 w-8" disabled={tePage <= 1} onClick={() => setTePage(tePage - 1)} aria-label="Previous page">
                          <ChevronLeft className="w-4 h-4" />
                        </Button>
                        <span className="text-xs text-muted-foreground px-2">
                          Page {tePage} of {timeEntries?.totalPages ?? 1}
                        </span>
                        <Button variant="outline" size="icon" className="h-8 w-8" disabled={tePage >= (timeEntries?.totalPages ?? 1)} onClick={() => setTePage(tePage + 1)} aria-label="Next page">
                          <ChevronRight className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </TabsContent>

                {/* Analytics Tab */}
                <TabsContent value="analytics" className="space-y-6 mt-4">
                  {analyticsData.totalHours === 0 ? (
                    <EmptyState
                      icon={BarChart3}
                      title="No data available"
                      description="Log time entries to see analytics."
                    />
                  ) : (
                    <>
                      {/* Category breakdown */}
                      <div className="space-y-3">
                        <p className="text-sm font-medium">Hours by Category</p>
                        <div className="space-y-2">
                          {analyticsData.categoryHours.map((cat) => {
                            const pct = analyticsData.totalHours > 0 ? (cat.hours / analyticsData.totalHours) * 100 : 0;
                            return (
                              <div key={cat.category} className="space-y-1">
                                <div className="flex items-center justify-between text-xs">
                                  <span className="text-muted-foreground">{cat.category.charAt(0).toUpperCase() + cat.category.slice(1)}</span>
                                  <span className="font-medium">{formatHours(cat.hours)} ({Math.round(pct)}%)</span>
                                </div>
                                <div className="h-2 bg-muted rounded-full overflow-hidden">
                                  <motion.div
                                    className="h-full rounded-full bg-emerald-500"
                                    initial={{ width: 0 }}
                                    animate={{ width: `${pct}%` }}
                                    transition={{ duration: 0.4 }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Daily hours chart */}
                      <div className="space-y-3">
                        <p className="text-sm font-medium">Daily Hours (Last 14 Days)</p>
                        <div className="flex items-end gap-1 h-24">
                          {analyticsData.last14Days.map((day) => {
                            const maxH = Math.max(...analyticsData.last14Days.map((d) => d.hours), 1);
                            const height = Math.max(2, (day.hours / maxH) * 100);
                            return (
                              <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
                                <span className="text-[9px] text-muted-foreground">
                                  {day.hours > 0 ? day.hours.toFixed(1) : ''}
                                </span>
                                <motion.div
                                  className="w-full rounded-t bg-emerald-500/80"
                                  initial={{ height: 0 }}
                                  animate={{ height: `${height}%` }}
                                  transition={{ duration: 0.3 }}
                                  title={`${day.date}: ${formatHours(day.hours)}`}
                                />
                                <span className="text-[9px] text-muted-foreground -rotate-45 origin-center">
                                  {new Date(day.date).toLocaleDateString('en-US', { day: 'numeric' })}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Member contribution */}
                      <div className="space-y-3">
                        <p className="text-sm font-medium">Member Contributions</p>
                        <div className="space-y-2">
                          {analyticsData.memberBreakdown.map((m, i) => {
                            const pct = analyticsData.totalHours > 0 ? (m.hours / analyticsData.totalHours) * 100 : 0;
                            return (
                              <div key={m.name} className="flex items-center gap-3">
                                <Avatar className="h-7 w-7">
                                  <AvatarFallback className={`text-[10px] ${getAvatarColor(i)}`}>
                                    {m.name.split(' ').map((n: string) => n[0]).join('')}
                                  </AvatarFallback>
                                </Avatar>
                                <div className="flex-1">
                                  <div className="flex items-center justify-between text-xs mb-1">
                                    <span className="font-medium">{m.name}</span>
                                    <span className="text-muted-foreground">{formatHours(m.hours)}</span>
                                  </div>
                                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                                    <motion.div
                                      className={`h-full rounded-full ${getAvatarColor(i)}`}
                                      initial={{ width: 0 }}
                                      animate={{ width: `${pct}%` }}
                                      transition={{ duration: 0.4, delay: i * 0.05 }}
                                    />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      {/* Manual vs automatically tracked (server-side aggregates —
                          exact over the whole project, unlike the page-local sums) */}
                      <div className="space-y-3">
                        <p className="text-sm font-medium">Manual vs Activity Tracking</p>
                        <div className="flex items-center gap-4">
                          <div className="flex-1">
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="flex items-center gap-1">
                                <div className="h-2.5 w-2.5 rounded-full bg-slate-400" />
                                Manual
                              </span>
                              <span className="font-medium">{formatHours(timeEntries?.aggregates?.manualHours ?? 0)}</span>
                            </div>
                            <div className="h-4 bg-muted rounded-full overflow-hidden">
                              <motion.div
                                className="h-full bg-slate-400 rounded-full"
                                initial={{ width: 0 }}
                                animate={{
                                  width: `${analyticsData.totalHours > 0 ? ((timeEntries?.aggregates?.manualHours ?? 0) / analyticsData.totalHours) * 100 : 0}%`,
                                }}
                                transition={{ duration: 0.4 }}
                              />
                            </div>
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="flex items-center gap-1">
                                <div className="h-2.5 w-2.5 rounded-full bg-sky-400" />
                                Activity Tracking
                              </span>
                              <span className="font-medium">{formatHours(timeEntries?.aggregates?.autoHours ?? 0)}</span>
                            </div>
                            <div className="h-4 bg-muted rounded-full overflow-hidden">
                              <motion.div
                                className="h-full bg-sky-400 rounded-full"
                                initial={{ width: 0 }}
                                animate={{
                                  width: `${analyticsData.totalHours > 0 ? ((timeEntries?.aggregates?.autoHours ?? 0) / analyticsData.totalHours) * 100 : 0}%`,
                                }}
                                transition={{ duration: 0.4, delay: 0.1 }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Billable vs Non-billable */}
                      <div className="space-y-3">
                        <p className="text-sm font-medium">Billable vs Non-Billable</p>
                        <div className="flex items-center gap-4">
                          <div className="flex-1">
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="flex items-center gap-1">
                                <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                                Billable
                              </span>
                              <span className="font-medium">{formatHours(analyticsData.billableHours)}</span>
                            </div>
                            <div className="h-4 bg-muted rounded-full overflow-hidden">
                              <motion.div
                                className="h-full bg-emerald-500 rounded-full"
                                initial={{ width: 0 }}
                                animate={{
                                  width: `${analyticsData.totalHours > 0 ? (analyticsData.billableHours / analyticsData.totalHours) * 100 : 0}%`,
                                }}
                                transition={{ duration: 0.4 }}
                              />
                            </div>
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="flex items-center gap-1">
                                <div className="h-2.5 w-2.5 rounded-full bg-rose-400" />
                                Non-Billable
                              </span>
                              <span className="font-medium">{formatHours(analyticsData.nonBillableHours)}</span>
                            </div>
                            <div className="h-4 bg-muted rounded-full overflow-hidden">
                              <motion.div
                                className="h-full bg-rose-400 rounded-full"
                                initial={{ width: 0 }}
                                animate={{
                                  width: `${analyticsData.totalHours > 0 ? (analyticsData.nonBillableHours / analyticsData.totalHours) * 100 : 0}%`,
                                }}
                                transition={{ duration: 0.4, delay: 0.1 }}
                              />
                            </div>
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </TabsContent>

                {/* Sentiment Tab — project-scoped sentiment (manager+ can analyze) */}
                <TabsContent value="sentiment" className="space-y-6 mt-4">
                  <ProjectSentimentTab projectId={selectedProjectId || projectDetail.id} />
                </TabsContent>
              </Tabs>
            </>
          ) : (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ==================== Edit Project Dialog ==================== */}
      <Dialog open={editDialogOpen} onOpenChange={(open) => { setEditDialogOpen(open); if (!open) setEditError(''); }}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center">
                <Pencil className="w-4 h-4 text-sky-600 dark:text-sky-400" />
              </div>
              Edit Project
            </DialogTitle>
            <DialogDescription>Update project details. Changes are saved to the database.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name *</Label>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                rows={3}
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={editForm.status} onValueChange={(v) => setEditForm({ ...editForm, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="on_hold">On Hold</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={editForm.priority} onValueChange={(v) => setEditForm({ ...editForm, priority: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Start Date</Label>
                <Input
                  type="date"
                  value={editForm.startDate}
                  onChange={(e) => setEditForm({ ...editForm, startDate: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Deadline</Label>
                <Input
                  type="date"
                  value={editForm.deadline}
                  onChange={(e) => setEditForm({ ...editForm, deadline: e.target.value })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Estimated Hours</Label>
                <Input
                  type="number"
                  min={0}
                  value={editForm.estimatedHours}
                  onChange={(e) => setEditForm({ ...editForm, estimatedHours: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Department</Label>
                <Select
                  value={editForm.departmentId || 'none'}
                  onValueChange={(v) => setEditForm({ ...editForm, departmentId: v === 'none' ? '' : v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No department</SelectItem>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex gap-2">
                {presetColors.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`h-8 w-8 rounded-full border-2 transition-transform hover:scale-110 ${editForm.color === c ? 'border-foreground scale-110' : 'border-transparent'}`}
                    style={{ backgroundColor: c }}
                    onClick={() => setEditForm({ ...editForm, color: c })}
                    aria-label={`Select color ${c}`}
                  />
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Budget Type</Label>
                <Select
                  value={editForm.budgetType || 'hourly'}
                  onValueChange={(v) => setEditForm({ ...editForm, budgetType: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">Fixed</SelectItem>
                    <SelectItem value="hourly">Hourly</SelectItem>
                    <SelectItem value="retainer">Retainer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Hourly Rate ($)</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={editForm.hourlyRate}
                  onChange={(e) => setEditForm({ ...editForm, hourlyRate: e.target.value })}
                />
              </div>
            </div>
            {editError && <p className="text-sm text-destructive">{editError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditDialogOpen(false); setEditError(''); }}>Cancel</Button>
            <Button
              onClick={handleSaveEdit}
              disabled={savingEdit || !editForm.name.trim()}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {savingEdit ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...</>
              ) : (
                <><Pencil className="w-4 h-4 mr-2" /> Save Changes</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ==================== Archive Project Confirmation ==================== */}
      <Dialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
                <Archive className="w-4 h-4 text-rose-600 dark:text-rose-400" />
              </div>
              Archive project?
            </DialogTitle>
            <DialogDescription>
              Archiving sets the project status to Cancelled. Members, time entries and all
              historical data are preserved and remain visible.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveDialogOpen(false)}>Cancel</Button>
            <Button
              className="bg-rose-600 hover:bg-rose-700"
              disabled={archiving}
              onClick={() => { setArchiving(true); archiveProjectMutation.mutate(); }}
            >
              {archiving ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Archiving...</>
              ) : (
                <><Archive className="w-4 h-4 mr-2" /> Archive Project</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ==================== Add Member Dialog ==================== */}
      <Dialog open={addMemberDialogOpen} onOpenChange={setAddMemberDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                <UserPlus className="w-4 h-4 text-violet-600 dark:text-violet-400" />
              </div>
              Add Team Member
            </DialogTitle>
            <DialogDescription>Add a team member to this project.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Employee</Label>
              <EmployeeCombobox
                value={memberEmployeeId || null}
                onValueChange={(v) => setMemberEmployeeId((v as string) ?? '')}
                placeholder="Select employee..."
                labelFormat="name-email"
                ariaLabel="Project member"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={memberRole} onValueChange={setMemberRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="lead">Lead</SelectItem>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="reviewer">Reviewer</SelectItem>
                    <SelectItem value="stakeholder">Stakeholder</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Hours/Week</Label>
                <Input
                  type="number"
                  value={memberHoursPerWeek}
                  onChange={(e) => setMemberHoursPerWeek(e.target.value)}
                  min={0}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddMemberDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={() => addMemberMutation.mutate({
                employeeId: memberEmployeeId,
                role: memberRole,
                hoursPerWeek: parseFloat(memberHoursPerWeek) || 40,
              })}
              disabled={!memberEmployeeId || addMemberMutation.isPending}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {addMemberMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Adding...</>
              ) : (
                <><UserPlus className="w-4 h-4 mr-2" /> Add Member</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ==================== Add Time Entry Dialog ==================== */}
      <Dialog open={addTimeEntryDialogOpen} onOpenChange={(open) => { setAddTimeEntryDialogOpen(open); if (!open) resetTEForm(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center">
                <Timer className="w-4 h-4 text-sky-600 dark:text-sky-400" />
              </div>
              Add Time Entry
            </DialogTitle>
            <DialogDescription>Log hours worked on this project.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Employee</Label>
              <EmployeeCombobox
                value={teEmployeeId || null}
                onValueChange={(v) => setTeEmployeeId((v as string) ?? '')}
                options={memberOptions}
                placeholder="Select employee..."
                labelFormat="name-email"
                ariaLabel="Time entry employee"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Date</Label>
                <Input type="date" value={teDate} onChange={(e) => setTeDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Hours</Label>
                <Input
                  type="number"
                  placeholder="e.g. 8"
                  value={teHours}
                  onChange={(e) => setTeHours(e.target.value)}
                  min={0}
                  step={0.25}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={teCategory} onValueChange={setTeCategory}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="development">Development</SelectItem>
                  <SelectItem value="design">Design</SelectItem>
                  <SelectItem value="meeting">Meeting</SelectItem>
                  <SelectItem value="research">Research</SelectItem>
                  <SelectItem value="testing">Testing</SelectItem>
                  <SelectItem value="review">Review</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                placeholder="What did you work on?"
                value={teDescription}
                onChange={(e) => setTeDescription(e.target.value)}
                rows={2}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="billable-toggle">Billable</Label>
              <Switch
                id="billable-toggle"
                checked={teBillable}
                onCheckedChange={setTeBillable}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddTimeEntryDialogOpen(false); resetTEForm(); }}>Cancel</Button>
            <Button
              onClick={() => {
                if (!teEmployeeId || !teHours || parseFloat(teHours) <= 0) {
                  toast.error('Please fill in all required fields');
                  return;
                }
                setAddingTE(true);
                addTimeEntryMutation.mutate({
                  employeeId: teEmployeeId,
                  date: teDate,
                  hours: parseFloat(teHours),
                  description: teDescription || null,
                  category: teCategory,
                  billable: teBillable,
                }, { onSettled: () => setAddingTE(false) });
              }}
              disabled={addingTE || !teEmployeeId || !teHours}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {addingTE ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Adding...</>
              ) : (
                <><Plus className="w-4 h-4 mr-2" /> Add Entry</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ==================== Edit Time Entry Dialog ==================== */}
      <Dialog open={editTimeEntryDialogOpen} onOpenChange={(open) => { setEditTimeEntryDialogOpen(open); if (!open) { setEditingEntry(null); setEditTEError(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-sky-100 dark:bg-sky-900/30 flex items-center justify-center">
                <Pencil className="w-4 h-4 text-sky-600 dark:text-sky-400" />
              </div>
              Edit Time Entry
            </DialogTitle>
            <DialogDescription>Update the logged hours for this project.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Employee</Label>
              <EmployeeCombobox
                value={editTE.employeeId || null}
                onValueChange={(v) => setEditTE({ ...editTE, employeeId: (v as string) ?? '' })}
                options={memberOptions}
                placeholder="Select employee..."
                labelFormat="name-email"
                ariaLabel="Time entry employee"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Date</Label>
                <Input type="date" value={editTE.date} onChange={(e) => setEditTE({ ...editTE, date: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Hours</Label>
                <Input
                  type="number"
                  placeholder="e.g. 8"
                  value={editTE.hours}
                  onChange={(e) => setEditTE({ ...editTE, hours: e.target.value })}
                  min={0}
                  step={0.25}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Category</Label>
              <Select value={editTE.category} onValueChange={(v) => setEditTE({ ...editTE, category: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="development">Development</SelectItem>
                  <SelectItem value="design">Design</SelectItem>
                  <SelectItem value="meeting">Meeting</SelectItem>
                  <SelectItem value="research">Research</SelectItem>
                  <SelectItem value="testing">Testing</SelectItem>
                  <SelectItem value="review">Review</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea
                placeholder="What did you work on?"
                value={editTE.description}
                onChange={(e) => setEditTE({ ...editTE, description: e.target.value })}
                rows={2}
              />
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-billable-toggle">Billable</Label>
              <Switch
                id="edit-billable-toggle"
                checked={editTE.billable}
                onCheckedChange={(v) => setEditTE({ ...editTE, billable: v })}
              />
            </div>
            {editTEError && <p className="text-sm text-destructive">{editTEError}</p>}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setEditTimeEntryDialogOpen(false); setEditingEntry(null); setEditTEError(''); }}
              disabled={savingTE}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSaveTimeEntryEdit}
              disabled={savingTE || !editTE.employeeId || !editTE.hours}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {savingTE ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...</>
              ) : (
                <><Pencil className="w-4 h-4 mr-2" /> Save Changes</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ==================== Delete Time Entry Confirmation ==================== */}
      <Dialog open={deleteEntryDialogOpen} onOpenChange={(open) => { setDeleteEntryDialogOpen(open); if (!open) setEntryToDelete(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
                <Trash2 className="w-4 h-4 text-rose-600 dark:text-rose-400" />
              </div>
              Delete time entry?
            </DialogTitle>
            <DialogDescription>
              {entryToDelete
                ? `This will permanently delete the ${formatHours(entryToDelete.hours)} entry logged by ${entryToDelete.employee.firstName} ${entryToDelete.employee.lastName} on ${new Date(entryToDelete.date).toLocaleDateString()}. Progress and analytics will recalculate.`
                : 'This will permanently delete this time entry.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteEntryDialogOpen(false)} disabled={deletingTE}>
              Cancel
            </Button>
            <Button
              className="bg-rose-600 hover:bg-rose-700"
              disabled={deletingTE}
              onClick={confirmDeleteEntry}
            >
              {deletingTE ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Deleting...</>
              ) : (
                <><Trash2 className="w-4 h-4 mr-2" /> Delete Entry</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ============ Active Tracking Project Confirmation (set/clear) ============ */}
      <Dialog open={activeProjectAction !== null} onOpenChange={(open) => { if (!open) { setActiveProjectAction(null); setSettingActiveProject(false); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                <Activity className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              {activeProjectAction?.action === 'set' ? 'Set active tracking project?' : 'Clear active tracking project?'}
            </DialogTitle>
            <DialogDescription>
              {activeProjectAction?.action === 'set' && activeProjectAction.member ? (
                <>Set <span className="font-medium text-foreground">{activeProjectAction.member.employee.firstName} {activeProjectAction.member.employee.lastName}</span>'s active tracking project to this project? New activity will be attributed to this project. Existing time entries will not be changed.</>
              ) : activeProjectAction ? (
                <>Clear <span className="font-medium text-foreground">{activeProjectAction.member.employee.firstName} {activeProjectAction.member.employee.lastName}</span>'s active tracking project? New activity will not be automatically assigned to a project until another active project is selected.</>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setActiveProjectAction(null); setSettingActiveProject(false); }}
              disabled={settingActiveProject}
            >
              Cancel
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-700"
              disabled={settingActiveProject || !activeProjectAction}
              onClick={() => {
                if (!activeProjectAction) return;
                setSettingActiveProject(true);
                setActiveProjectMutation.mutate({
                  employeeId: activeProjectAction.member.employeeId,
                  projectId: activeProjectAction.action === 'set' ? activeProjectAction.member.projectId : null,
                });
              }}
            >
              {settingActiveProject ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Saving...</>
              ) : activeProjectAction?.action === 'set' ? (
                <>Set Active Project</>
              ) : (
                <>Clear Active Project</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
