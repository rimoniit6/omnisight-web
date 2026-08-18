'use client';

import { Users, FilterX } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

interface EmployeeEmptyStateProps {
  /** True when filters/search produced no results (vs. no employees at all). */
  hasFilters: boolean;
  onClearFilters?: () => void;
  onAddEmployee?: () => void;
}

export function EmployeeEmptyState({ hasFilters, onClearFilters, onAddEmployee }: EmployeeEmptyStateProps) {
  if (hasFilters) {
    return (
      <EmptyState
        icon={FilterX}
        title="No matching employees"
        description="Try changing or clearing your filters."
        action={
          onClearFilters
            ? { label: 'Clear Filters', onClick: onClearFilters }
            : undefined
        }
      />
    );
  }
  return (
    <EmptyState
      icon={Users}
      title="No employees found"
      description="There are currently no employees in your organization."
      action={onAddEmployee ? { label: 'Add Employee', onClick: onAddEmployee } : undefined}
    />
  );
}
