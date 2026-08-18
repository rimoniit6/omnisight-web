'use client';

import { useQuery } from '@tanstack/react-query';
import { Search, FilterX } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { hasActiveFilters, type EmployeeListFilters } from './employee-query';

interface EmployeeFiltersProps {
  filters: EmployeeListFilters;
  onChange: (patch: Partial<EmployeeListFilters>) => void;
  onClear: () => void;
  /** Show the organization dropdown (global super_admin only). */
  showOrganization?: boolean;
}

export function EmployeeFilters({ filters, onChange, onClear, showOrganization }: EmployeeFiltersProps) {
  const { data: departments } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => {
      const res = await fetch('/api/departments');
      if (!res.ok) throw new Error('Failed to load departments');
      const json = await res.json();
      return json.data as Array<{ id: string; name: string }>;
    },
  });

  const { data: organizations } = useQuery({
    queryKey: ['organizations'],
    enabled: !!showOrganization,
    queryFn: async () => {
      const res = await fetch('/api/organizations');
      if (!res.ok) throw new Error('Failed to load organizations');
      const json = await res.json();
      return json.data as Array<{ id: string; name: string; status: string }>;
    },
  });

  const active = hasActiveFilters(filters);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, or employee ID..."
            className="pl-9"
            value={filters.search}
            onChange={(e) => onChange({ search: e.target.value })}
            aria-label="Search employees"
          />
        </div>
        {active && (
          <Button variant="ghost" size="sm" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={onClear}>
            <FilterX className="w-3.5 h-3.5 mr-1.5" />
            Clear Filters
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Select value={filters.status} onValueChange={(v) => onChange({ status: v as EmployeeListFilters['status'] })}>
          <SelectTrigger className="w-32 h-9 text-xs" aria-label="Filter by status">
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>

        {showOrganization && (
          <Select
            value={filters.organizationId}
            onValueChange={(v) => onChange({ organizationId: v })}
          >
            <SelectTrigger className="w-44 h-9 text-xs" aria-label="Filter by organization">
              <SelectValue placeholder="All Organizations" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All Organizations</SelectItem>
              {(organizations || []).map((org) => (
                <SelectItem key={org.id} value={org.id}>
                  {org.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select
          value={filters.departmentId}
          onValueChange={(v) => onChange({ departmentId: v })}
        >
          <SelectTrigger className="w-44 h-9 text-xs" aria-label="Filter by department">
            <SelectValue placeholder="All Departments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All Departments</SelectItem>
            {(departments || []).map((dept) => (
              <SelectItem key={dept.id} value={dept.id}>
                {dept.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={filters.role} onValueChange={(v) => onChange({ role: v as EmployeeListFilters['role'] })}>
          <SelectTrigger className="w-32 h-9 text-xs" aria-label="Filter by role">
            <SelectValue placeholder="All Roles" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All Roles</SelectItem>
            <SelectItem value="manager">Manager</SelectItem>
            <SelectItem value="employee">Employee</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.deviceStatus}
          onValueChange={(v) => onChange({ deviceStatus: v as EmployeeListFilters['deviceStatus'] })}
        >
          <SelectTrigger className="w-36 h-9 text-xs" aria-label="Filter by device status">
            <SelectValue placeholder="All Devices" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">All Devices</SelectItem>
            <SelectItem value="online">Online</SelectItem>
            <SelectItem value="offline">Offline</SelectItem>
            <SelectItem value="no_device">No Device</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={filters.dateRange}
          onValueChange={(v) => onChange({ dateRange: v as EmployeeListFilters['dateRange'] })}
        >
          <SelectTrigger className="w-36 h-9 text-xs" aria-label="Filter by created date">
            <SelectValue placeholder="All Time" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Time</SelectItem>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="7d">Last 7 Days</SelectItem>
            <SelectItem value="30d">Last 30 Days</SelectItem>
            <SelectItem value="custom">Custom Range</SelectItem>
          </SelectContent>
        </Select>

        {filters.dateRange === 'custom' && (
          <div className="flex items-center gap-1.5">
            <Input
              type="date"
              className="h-9 w-36 text-xs"
              value={filters.createdFrom}
              max={filters.createdTo || undefined}
              onChange={(e) => onChange({ createdFrom: e.target.value })}
              aria-label="Created from"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="date"
              className="h-9 w-36 text-xs"
              value={filters.createdTo}
              min={filters.createdFrom || undefined}
              onChange={(e) => onChange({ createdTo: e.target.value })}
              aria-label="Created to"
            />
          </div>
        )}
      </div>
    </div>
  );
}
