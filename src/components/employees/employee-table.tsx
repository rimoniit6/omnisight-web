'use client';

import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { MoreHorizontal, Pencil, Archive, Eye, Download, ArrowUp, ArrowDown, ChevronsUpDown, Building2, Monitor } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { EmployeeStatusBadge } from './employee-status-badge';
import { PresenceDot } from '@/components/ui/presence-dot';
import { isHeartbeatFresh } from '@/lib/presence';
import type { EmployeeRow } from './employee-query';

const SKELETON_ROWS = 8;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

interface EmployeeTableProps {
  employees: EmployeeRow[];
  loading?: boolean;
  onEdit: (emp: EmployeeRow) => void;
  onArchive: (id: string) => void;
  onView: (id: string) => void;
  selectedIds: Set<string>;
  onSelectionChange: (ids: Set<string>) => void;
  onBulkArchive: () => void;
  onBulkExport: () => void;
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  onSortChange: (sortBy: string, sortOrder: 'asc' | 'desc') => void;
  onStatusChange?: (id: string, newStatus: string) => void;
}

type SortableField = 'name' | 'email' | 'department.name' | 'designation' | 'status' | 'createdAt';

const SORT_COLUMNS: Array<{ field: SortableField; label: string; className?: string }> = [
  { field: 'name', label: 'Employee' },
  { field: 'email', label: 'Email', className: 'hidden md:table-cell' },
  { field: 'department.name', label: 'Department', className: 'hidden lg:table-cell' },
  { field: 'designation', label: 'Designation', className: 'hidden xl:table-cell' },
  { field: 'status', label: 'Status' },
];

export function EmployeeTable({
  employees,
  loading,
  onEdit,
  onArchive,
  onView,
  selectedIds,
  onSelectionChange,
  onBulkArchive,
  onBulkExport,
  sortBy,
  sortOrder,
  onSortChange,
  onStatusChange,
}: EmployeeTableProps) {
  const allSelected = employees.length > 0 && employees.every((e) => selectedIds.has(e.id));
  const tableRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  const toggleAll = () => {
    if (allSelected) {
      onSelectionChange(new Set());
    } else {
      onSelectionChange(new Set(employees.map((e) => e.id)));
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    onSelectionChange(next);
  };

  const handleSort = (field: SortableField) => {
    if (sortBy === field) {
      onSortChange(field, sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      onSortChange(field, 'asc');
    }
  };

  const handleStatusChange = async (emp: EmployeeRow, newStatus: string) => {
    try {
      const res = await fetch(`/api/employees/${emp.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) throw new Error('Failed to update status');
      toast.success(`${emp.firstName} ${emp.lastName} set to ${newStatus}`);
      onStatusChange?.(emp.id, newStatus);
    } catch {
      toast.error('Failed to update status');
    }
  };

  const renderSortIcon = (field: SortableField) => {
    if (sortBy !== field) {
      return <ChevronsUpDown className="w-3.5 h-3.5 text-muted-foreground/50" />;
    }
    return sortOrder === 'asc'
      ? <ArrowUp className="w-3.5 h-3.5 text-primary" />
      : <ArrowDown className="w-3.5 h-3.5 text-primary" />;
  };

  const sortButtonClass = 'inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors';

  const renderActionsMenu = (emp: EmployeeRow) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Actions for ${emp.firstName} ${emp.lastName}`}
        >
          <MoreHorizontal className="w-4 h-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onView(emp.id)}>
          <Eye className="mr-2 h-4 w-4" /> View
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onEdit(emp)}>
          <Pencil className="mr-2 h-4 w-4" /> Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive" onClick={() => onArchive(emp.id)}>
          <Archive className="mr-2 h-4 w-4" /> Archive
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const renderDevice = (emp: EmployeeRow) => {
    // Live presence: the green dot is decided by heartbeat freshness, never
    // the sticky Device.status column.
    const onlineDevice = emp.devices.find((d) =>
      isHeartbeatFresh(d.lastHeartbeat ? new Date(d.lastHeartbeat) : null)
    );
    if (onlineDevice) {
      return (
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
          <span className="text-xs text-muted-foreground truncate max-w-32">{onlineDevice.name}</span>
        </div>
      );
    }
    if (emp.devices.length > 0) {
      return (
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-danger shrink-0" />
          <span className="text-xs text-muted-foreground truncate max-w-32">{emp.devices[0].name}</span>
        </div>
      );
    }
    return <span className="text-xs text-muted-foreground">—</span>;
  };

  // ─── Loading skeletons ────────────────────────────────────────────────────
  const renderSkeletonRows = () =>
    Array.from({ length: SKELETON_ROWS }, (_, i) => (
      <tr key={`sk-${i}`} className="border-b">
        <td className="px-3 md:px-4 py-2.5">
          <Skeleton className="h-4 w-4" />
        </td>
        <td className="px-3 md:px-4 py-2.5">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="space-y-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
        </td>
        <td className="px-3 md:px-4 py-2.5 hidden md:table-cell">
          <Skeleton className="h-3.5 w-40" />
        </td>
        <td className="px-3 md:px-4 py-2.5 hidden lg:table-cell">
          <Skeleton className="h-3.5 w-28" />
        </td>
        <td className="px-3 md:px-4 py-2.5 hidden xl:table-cell">
          <Skeleton className="h-3.5 w-24" />
        </td>
        <td className="px-3 md:px-4 py-2.5">
          <Skeleton className="h-5 w-16 rounded-full" />
        </td>
        <td className="px-3 md:px-4 py-2.5 hidden sm:table-cell">
          <Skeleton className="h-3.5 w-16" />
        </td>
        <td className="px-3 md:px-4 py-2.5 hidden lg:table-cell">
          <Skeleton className="h-3.5 w-20" />
        </td>
        <td className="px-3 md:px-4 py-2.5 text-right">
          <Skeleton className="h-8 w-8 ml-auto" />
        </td>
      </tr>
    ));

  // ─── Mobile: responsive card list ───
  const renderMobileCards = () => (
    <div className="space-y-3">
      {loading
        ? Array.from({ length: 5 }, (_, i) => (
            <Card key={`sk-${i}`}>
              <CardContent className="p-3.5 flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-full shrink-0" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-40" />
                  <Skeleton className="h-3 w-56" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </CardContent>
            </Card>
          ))
        : employees.map((emp) => {
            const isSelected = selectedIds.has(emp.id);
            return (
              <Card
                key={emp.id}
                className={cn(
                  'border transition-colors cursor-pointer',
                  isSelected ? 'bg-primary/[0.04] border-primary/30' : 'hover:bg-muted/40',
                )}
                onClick={() => onView(emp.id)}
              >
                <CardContent className="p-3.5">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleOne(emp.id)}
                      aria-label={`Select ${emp.firstName} ${emp.lastName}`}
                      className="mt-1.5"
                      onClick={(e) => e.stopPropagation()}
                    />
                    <Avatar
                      className="h-10 w-10 shrink-0 hover:ring-2 hover:ring-primary/30 transition-all"
                      onClick={(e) => { e.stopPropagation(); onView(emp.id); }}
                    >
                      {emp.avatar && <AvatarImage src={emp.avatar} alt={`${emp.firstName} ${emp.lastName}`} />}
                      <AvatarFallback className="text-[10px] bg-muted text-foreground font-semibold">
                        {emp.firstName[0]}{emp.lastName[0]}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <PresenceDot employeeId={emp.id} />
                          <p className="font-medium text-sm truncate">{emp.firstName} {emp.lastName}</p>
                        </span>
                        <EmployeeStatusBadge
                          status={emp.status}
                          disabled={!onStatusChange}
                          onStatusChange={(newStatus) => handleStatusChange(emp, newStatus)}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{emp.email}</p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <Building2 className="w-3 h-3 shrink-0" />
                          <span className="truncate">{emp.department?.name || '—'}</span>
                        </span>
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <Monitor className="w-3 h-3 shrink-0" />
                          <span className="truncate">{emp.designation || '—'}</span>
                        </span>
                        <span className="whitespace-nowrap">Joined {formatDate(emp.joinDate || emp.createdAt)}</span>
                      </div>
                      <div className="mt-2">{renderDevice(emp)}</div>
                    </div>
                    <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                      {renderActionsMenu(emp)}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
    </div>
  );

  // ─── Desktop: table ───
  const renderTable = () => (
    <div className="border rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b">
              <th className="text-left px-3 md:px-4 py-2.5 font-medium text-muted-foreground w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all employees"
                  disabled={loading || employees.length === 0}
                />
              </th>
              {SORT_COLUMNS.map((col) => (
                <th
                  key={col.field}
                  className={cn('text-left px-3 md:px-4 py-2.5 font-medium text-muted-foreground', col.className)}
                >
                  <button className={sortButtonClass} onClick={() => handleSort(col.field)}>
                    {col.label}
                    {renderSortIcon(col.field)}
                  </button>
                </th>
              ))}
              <th className="text-left px-3 md:px-4 py-2.5 font-medium text-muted-foreground hidden sm:table-cell">Device</th>
              <th className="text-left px-3 md:px-4 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">
                <button className={sortButtonClass} onClick={() => handleSort('createdAt')}>
                  Created
                  {renderSortIcon('createdAt')}
                </button>
              </th>
              <th className="text-right px-3 md:px-4 py-2.5 font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading
              ? renderSkeletonRows()
              : employees.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-muted-foreground">
                      No employees found
                    </td>
                  </tr>
                )}
            {!loading &&
              employees.map((emp) => {
                const isSelected = selectedIds.has(emp.id);
                return (
                  <tr
                    key={emp.id}
                    className={cn(
                      'transition-colors cursor-pointer',
                      isSelected ? 'bg-primary/[0.04]' : 'hover:bg-muted/40',
                    )}
                    onClick={() => onView(emp.id)}
                  >
                    <td className="px-3 md:px-4 py-2.5">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => toggleOne(emp.id)}
                        aria-label={`Select ${emp.firstName} ${emp.lastName}`}
                      />
                    </td>
                    <td className="px-3 md:px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8 hover:ring-2 hover:ring-primary/30 transition-all cursor-pointer" onClick={(e) => { e.stopPropagation(); onView(emp.id); }}>
                          {emp.avatar && <AvatarImage src={emp.avatar} alt={`${emp.firstName} ${emp.lastName}`} />}
                          <AvatarFallback className="text-[10px] bg-muted text-foreground font-semibold">
                            {emp.firstName[0]}{emp.lastName[0]}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <span className="flex items-center gap-2">
                            <PresenceDot employeeId={emp.id} />
                            <p className="font-medium truncate">{emp.firstName} {emp.lastName}</p>
                          </span>
                          <p className="text-xs text-muted-foreground truncate">{emp.employeeId}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 md:px-4 py-2.5 hidden md:table-cell">
                      <span className="text-sm text-muted-foreground truncate block max-w-40">{emp.email}</span>
                    </td>
                    <td className="px-3 md:px-4 py-2.5 hidden lg:table-cell">
                      <span className="text-sm">{emp.department?.name || '—'}</span>
                    </td>
                    <td className="px-3 md:px-4 py-2.5 hidden xl:table-cell">
                      <span className="text-sm text-muted-foreground">{emp.designation || '—'}</span>
                    </td>
                    <td className="px-3 md:px-4 py-2.5">
                      <EmployeeStatusBadge
                        status={emp.status}
                        disabled={!onStatusChange}
                        onStatusChange={(newStatus) => handleStatusChange(emp, newStatus)}
                      />
                    </td>
                    <td className="px-3 md:px-4 py-2.5 hidden sm:table-cell">
                      {renderDevice(emp)}
                    </td>
                    <td className="px-3 md:px-4 py-2.5 hidden lg:table-cell">
                      <span className="text-xs text-muted-foreground">{formatDate(emp.createdAt)}</span>
                    </td>
                    <td className="px-3 md:px-4 py-2.5 text-right">
                      {renderActionsMenu(emp)}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="relative" ref={tableRef} role="grid" aria-label="Employees table">
      {isMobile ? renderMobileCards() : renderTable()}

      {/* Floating bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-card border shadow-md rounded-full px-4 py-2 animate-in slide-in-from-bottom-4 duration-200">
          <span className="text-sm font-medium text-foreground">
            {selectedIds.size} selected
          </span>
          <div className="w-px h-5 bg-border" />
          <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={onBulkExport}>
            <Download className="w-3.5 h-3.5" /> Export
          </Button>
          <Button size="sm" variant="ghost" className="h-8 gap-1.5 text-destructive hover:text-destructive" onClick={onBulkArchive}>
            <Archive className="w-3.5 h-3.5" /> Archive
          </Button>
        </div>
      )}
    </div>
  );
}
