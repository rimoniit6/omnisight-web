'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

const statusColors: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; class: string }> = {
  active: { variant: 'outline', class: 'bg-success/10 text-success border-success/25 hover:bg-success/15 hover:text-success' },
  inactive: { variant: 'outline', class: 'bg-warning/10 text-warning border-warning/25 hover:bg-warning/15 hover:text-warning' },
  archived: { variant: 'secondary', class: 'bg-muted text-muted-foreground hover:bg-muted/80' },
};

const statusOptions = [
  { value: 'active', label: 'Active', dotClass: 'bg-success' },
  { value: 'inactive', label: 'Inactive', dotClass: 'bg-warning' },
  { value: 'archived', label: 'Archive', dotClass: 'bg-muted-foreground/60' },
];

interface EmployeeStatusBadgeProps {
  status: string;
  /** When set, the badge becomes an inline dropdown to change the status. */
  onStatusChange?: (newStatus: string) => void;
  disabled?: boolean;
}

export function EmployeeStatusBadge({ status, onStatusChange, disabled }: EmployeeStatusBadgeProps) {
  const [open, setOpen] = useState(false);
  const sc = statusColors[status] || statusColors.active;

  const handleSelect = (value: string) => {
    setOpen(false);
    if (status !== value) onStatusChange?.(value);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Badge
          className={cn(
            sc.class,
            onStatusChange && 'cursor-pointer select-none',
            'gap-1.5 font-medium capitalize',
            disabled && 'opacity-50 pointer-events-none'
          )}
          variant={sc.variant}
          onClick={(e) => e.stopPropagation()}
        >
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full',
              status === 'active' ? 'bg-success' : status === 'inactive' ? 'bg-warning' : 'bg-muted-foreground/60'
            )}
          />
          {status}
        </Badge>
      </DropdownMenuTrigger>
      {onStatusChange && (
        <DropdownMenuContent align="start" className="w-36">
          {statusOptions.map((opt) => (
            <DropdownMenuItem
              key={opt.value}
              className={cn('gap-2 capitalize', status === opt.value && 'font-medium')}
              onClick={(e) => {
                e.stopPropagation();
                handleSelect(opt.value);
              }}
              disabled={disabled}
            >
              <span className={cn('w-2 h-2 rounded-full', opt.dotClass)} />
              {opt.label}
              {status === opt.value && <span className="ml-auto text-primary text-xs">✓</span>}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}
