'use client';

import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { EmployeeTable } from './employee-table';
import { EmployeeDialog } from './employee-dialog';
import { EmployeeDetailDrawer } from './employee-detail-drawer';
import { EmployeeStatistics } from './employee-statistics';
import { EmployeeFilters } from './employee-filters';
import { EmployeePagination } from './employee-pagination';
import { EmployeeEmptyState } from './employee-empty-state';
import { useEmployeesUrlState } from './use-employees-url-state';
import { buildEmployeesQuery, hasActiveFilters, type EmployeeRow, type EmployeesApiResponse } from './employee-query';
import { Button } from '@/components/ui/button';
import { Plus, Users, UserCheck, UserX, ChevronDown, ChevronUp, BarChart3, RefreshCw, AlertTriangle } from 'lucide-react';
import { ExportDialog } from '@/components/export/export-dialog';
import { BulkImportDialog } from '@/components/import/bulk-import-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { exportToCSV } from '@/lib/csv-export';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { QuickStats, type QuickStat } from '@/components/ui/quick-stats';
import { useAppStore, useAuthStore } from '@/lib/store';
import { motion, AnimatePresence } from 'framer-motion';

export function EmployeesPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editEmployee, setEditEmployee] = useState<EmployeeRow | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [statsExpanded, setStatsExpanded] = useState(true);
  const queryClient = useQueryClient();
  const departmentFilter = useAppStore((s) => s.departmentFilter);
  const setDepartmentFilter = useAppStore((s) => s.setDepartmentFilter);
  const storeSelectedEmployeeId = useAppStore((s) => s.selectedEmployeeId);
  const setStoreSelectedEmployeeId = useAppStore((s) => s.setSelectedEmployeeId);
  const currentUser = useAuthStore((s) => s.user);
  const isGlobalAdmin = currentUser?.role === 'super_admin';

  const {
    filters, sort, page, pageSize,
    patchFilters, clearFilters, setSortBy, setSortOrder, setPage, setPageSize,
  } = useEmployeesUrlState();

  // Listen for Cmd+N from global hotkeys
  useEffect(() => {
    const handleAddEmployeeEvent = () => {
      setEditEmployee(null);
      setDialogOpen(true);
    };
    document.addEventListener('worklens:add-employee', handleAddEmployeeEvent);
    return () => document.removeEventListener('worklens:add-employee', handleAddEmployeeEvent);
  }, []);

  // Listen for edit-employee event from employee details page
  useEffect(() => {
    const handleEditEmployeeEvent = async (e: Event) => {
      const empId = (e as CustomEvent).detail;
      if (!empId) return;
      // Navigate to employees page first
      const store = useAppStore.getState();
      store.setCurrentPage('employees');
      // Fetch the employee to pre-fill the edit dialog
      try {
        const res = await fetch(`/api/employees/${empId}`);
        if (res.ok) {
          const emp = await res.json();
          setEditEmployee(emp.data);
          setDialogOpen(true);
        }
      } catch { /* ignore */ }
    };
    document.addEventListener('worklens:edit-employee', handleEditEmployeeEvent);
    return () => document.removeEventListener('worklens:edit-employee', handleEditEmployeeEvent);
  }, []);

  // Clear the store-backed drawer selection when leaving the page, so
  // navigating away and back doesn't unexpectedly reopen the detail drawer.
  useEffect(() => {
    return () => {
      useAppStore.getState().setSelectedEmployeeId(null);
    };
  }, []);

  // Legacy store-backed department filter (set from dashboard/departments/
  // command palette) — it may hold a department id OR a name depending on the
  // source, so resolve it against the fetched list before querying. Shares the
  // cache with the department dropdown (same ['departments'] key).
  const { data: departments } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['departments'],
    queryFn: async () => {
      const res = await fetch('/api/departments');
      if (!res.ok) return [];
      const json = await res.json();
      return json.data || [];
    },
  });

  const params = buildEmployeesQuery(filters, sort, page, pageSize);
  const queryParams = new URLSearchParams(params);
  const storeDept = departmentFilter?.trim();
  if (storeDept) {
    const matched = (departments || []).find((d) => d.id === storeDept);
    if (matched) {
      queryParams.set('departmentId', matched.id);
    } else {
      queryParams.set('department', storeDept);
    }
  }
  const queryString = queryParams.toString();

  const { data, isLoading, isError, isFetching, refetch } = useQuery<EmployeesApiResponse>({
    queryKey: ['employees', queryString],
    queryFn: async () => {
      const res = await fetch(`/api/employees?${queryString}`);
      if (!res.ok) {
        let message = `Request failed (${res.status})`;
        try {
          const json = await res.json();
          if (json?.error) message = json.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      return res.json();
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  // Clamp the page when filters shrink the result set below the current page.
  useEffect(() => {
    if (data && data.pagination.totalPages > 0 && page > data.pagination.totalPages) {
      setPage(data.pagination.totalPages);
    }
  }, [data, page, setPage]);

  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [archiveDialogId, setArchiveDialogId] = useState<string | null>(null);

  const handleArchive = async (id: string) => {
    setArchiveDialogId(null);
    setArchivingId(id);
    try {
      const res = await fetch(`/api/employees/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        let msg = `Failed to archive employee (${res.status})`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
        throw new Error(msg);
      }
      toast.success('Employee archived');
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      queryClient.invalidateQueries({ queryKey: ['employee-statistics'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to archive employee');
    } finally {
      setArchivingId(null);
    }
  };

  const handleView = (id: string) => {
    // Navigate to the full employee details page. The breadcrumb label is the
    // employee's human-readable name (fallback: email) — never the raw id.
    const store = useAppStore.getState();
    store.setCurrentPage('employee-details');
    store.setPageContext(id);
    const row = employees.find((e) => e.id === id);
    store.setPageContextLabel(row ? `${row.firstName} ${row.lastName}`.trim() || row.email : '');
  };

  const handleSortChange = useCallback((newSortBy: string, newSortOrder: 'asc' | 'desc') => {
    setSortBy(newSortBy);
    setSortOrder(newSortOrder);
  }, [setSortBy, setSortOrder]);

  const handleStatusChange = useCallback((_id: string, _newStatus: string) => {
    // Invalidate queries to refresh the list with updated status
    queryClient.invalidateQueries({ queryKey: ['employees'] });
    queryClient.invalidateQueries({ queryKey: ['employee-statistics'] });
  }, [queryClient]);

  const [bulkArchiving, setBulkArchiving] = useState(false);

  const handleBulkArchive = useCallback(async () => {
    if (bulkArchiving) return; // prevent double-submit
    setBulkArchiving(true);
    try {
      const res = await fetch('/api/employees/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds), action: 'archive' }),
      });
      if (!res.ok) {
        let msg = `Failed to archive employees (${res.status})`;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* keep default */ }
        throw new Error(msg);
      }
      const json = await res.json();
      const failed = json.failed || 0;
      if (failed > 0) {
        toast.warning(`${json.archived} archived, ${failed} failed`);
      } else {
        toast.success(`${json.archived} employee(s) archived`);
      }
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      queryClient.invalidateQueries({ queryKey: ['employee-statistics'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to archive employees');
    } finally {
      setBulkArchiving(false);
    }
  }, [selectedIds, queryClient, bulkArchiving]);

  const handleBulkExport = useCallback(() => {
    const employees = data?.data || [];
    const selected = employees.filter((e) => selectedIds.has(e.id));
    const exportData = selected.map((e) => ({
      'Employee ID': e.employeeId,
      'First Name': e.firstName,
      'Last Name': e.lastName,
      'Email': e.email,
      'Phone': e.phone || '',
      'Designation': e.designation || '',
      'Department': e.department?.name || '',
      'Status': e.status,
    }));
    exportToCSV(exportData, `employees-export-${new Date().toISOString().slice(0, 10)}`);
  }, [data, selectedIds]);

  const employees = data?.data || [];
  const archiveTargetName = employees.find((e) => e.id === archiveDialogId);
  const total = data?.total || 0;
  const activeCount = data?.activeCount ?? 0;
  const inactiveCount = data?.inactiveCount ?? 0;

  const employeeStats: QuickStat[] = [
    { label: 'Total Employees', value: total, icon: Users, color: 'emerald' },
    { label: 'Active', value: activeCount, icon: UserCheck, color: 'emerald' },
    { label: 'Inactive', value: inactiveCount, icon: UserX, color: 'rose' },
  ];

  const hasFilterCriteria = hasActiveFilters(filters) || Boolean(storeDept);

  const handleClearAllFilters = useCallback(() => {
    clearFilters();
    setDepartmentFilter('');
  }, [clearFilters, setDepartmentFilter]);

  return (
    <div className="space-y-5" role="region" aria-label="Employees">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Employees</h2>
          <p className="text-sm text-muted-foreground mt-0.5 truncate">
            Manage and monitor employees{total > 0 ? ` — ${total} employee${total === 1 ? '' : 's'}, ${activeCount} active` : ''}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <BulkImportDialog
            importType="employees"
            title="Import Employees"
            onImportComplete={() => queryClient.invalidateQueries({ queryKey: ['employees'] })}
          />
          <ExportDialog
            exportType="employees"
            title="Export Employees"
            availableColumns={[
              { key: 'name', label: 'Name', defaultEnabled: true },
              { key: 'email', label: 'Email', defaultEnabled: true },
              { key: 'employeeId', label: 'Employee ID', defaultEnabled: true },
              { key: 'designation', label: 'Designation', defaultEnabled: true },
              { key: 'department', label: 'Department', defaultEnabled: true },
              { key: 'status', label: 'Status', defaultEnabled: true },
              { key: 'phone', label: 'Phone', defaultEnabled: false },
              { key: 'joinDate', label: 'Join Date', defaultEnabled: false },
            ]}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() => { setEditEmployee(null); setDialogOpen(true); }}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                <Plus className="w-4 h-4 mr-2" /> Add Employee
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <span className="flex items-center gap-1.5">
                Add new employee
                <kbd className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded bg-muted border border-border text-[9px] font-mono font-semibold text-muted-foreground/70">
                  ⌘N
                </kbd>
              </span>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Quick Stats */}
      <QuickStats stats={employeeStats} />

      {/* Statistics Panel - Collapsible */}
      <div className="space-y-0">
        <button
          onClick={() => setStatsExpanded(!statsExpanded)}
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors py-1 group"
        >
          <BarChart3 className="w-4 h-4" />
          <span>Employee Analytics</span>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={statsExpanded ? 'up' : 'down'}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.15 }}
            >
              {statsExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </motion.span>
          </AnimatePresence>
        </button>
        <AnimatePresence initial={false}>
          {statsExpanded && (
            <motion.div
              key="stats-panel"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
              className="overflow-hidden"
            >
              <div className="pt-2">
                <EmployeeStatistics />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Department filter indicator (store-backed, legacy sources) */}
      {storeDept && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filtering by department:</span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-muted border border-border text-foreground text-xs font-medium">
            {storeDept}
            <button
              onClick={() => setDepartmentFilter('')}
              className="ml-0.5 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Clear department filter"
            >
              ✕
            </button>
          </span>
        </div>
      )}

      {/* Filters */}
      <EmployeeFilters
        filters={filters}
        onChange={patchFilters}
        onClear={handleClearAllFilters}
        showOrganization={isGlobalAdmin}
      />

      {/* Error state */}
      {isError && !isLoading && (
        <div className="border rounded-lg flex flex-col items-center justify-center py-12 px-4 text-center bg-muted/20">
          <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center mb-4">
            <AlertTriangle className="w-7 h-7 text-destructive" />
          </div>
          <h3 className="text-sm font-semibold text-foreground mb-1">Unable to load employees</h3>
          <p className="text-sm text-muted-foreground max-w-sm mb-4">
            Something went wrong while loading employee data.
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Retry
          </Button>
        </div>
      )}

      {/* Empty state */}
      {!isError && !isLoading && employees.length === 0 && !isFetching && (
        <EmployeeEmptyState
          hasFilters={hasFilterCriteria}
          onClearFilters={handleClearAllFilters}
          onAddEmployee={() => { setEditEmployee(null); setDialogOpen(true); }}
        />
      )}

      {/* Table (skeleton rows while loading) */}
      {!isError && (isLoading || employees.length > 0 || isFetching) && (
        <>
          <EmployeeTable
            employees={employees}
            loading={isLoading}
            onEdit={(emp) => { setEditEmployee(emp); setDialogOpen(true); }}
            onArchive={setArchiveDialogId}
            onView={handleView}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            onBulkArchive={handleBulkArchive}
            onBulkExport={handleBulkExport}
            sortBy={sort.sortBy}
            sortOrder={sort.sortOrder}
            onSortChange={handleSortChange}
            onStatusChange={handleStatusChange}
          />
          {data && (
            <EmployeePagination
              page={page}
              pageSize={pageSize}
              total={data.pagination.total}
              totalPages={data.pagination.totalPages}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          )}
        </>
      )}

      {/* Dialog */}
      <EmployeeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        employee={editEmployee}
        onSaved={() => queryClient.invalidateQueries({ queryKey: ['employees'] })}
      />

      {/* Detail Drawer — store-backed: selectedEmployeeId in the store IS the
          open state. Command palette / notifications set it to open; closing
          the drawer clears it. No sync effect required. */}
      <EmployeeDetailDrawer
        employeeId={storeSelectedEmployeeId}
        open={storeSelectedEmployeeId !== null}
        onOpenChange={(open) => { if (!open) setStoreSelectedEmployeeId(null); }}
      />

      <ConfirmDialog
        open={archiveDialogId !== null}
        onOpenChange={(open) => { if (!open) setArchiveDialogId(null); }}
        title="Archive Employee"
        description={`Are you sure you want to archive ${archiveTargetName ? `${archiveTargetName.firstName} ${archiveTargetName.lastName}` : 'this employee'}? They will be deactivated and removed from active listings.`}
        confirmLabel="Archive"
        onConfirm={() => { if (archiveDialogId) handleArchive(archiveDialogId); }}
        disabled={archivingId !== null}
      />

    </div>
  );
}
