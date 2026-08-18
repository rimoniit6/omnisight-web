'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { PAGE_SIZE_OPTIONS } from './employee-query';

/** Page numbers with ellipsis for large result sets. */
function getPageItems(current: number, totalPages: number): (number | 'ellipsis')[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  const items: (number | 'ellipsis')[] = [1];
  if (current > 3) items.push('ellipsis');
  for (let i = Math.max(2, current - 1); i <= Math.min(totalPages - 1, current + 1); i++) {
    items.push(i);
  }
  if (current < totalPages - 2) items.push('ellipsis');
  items.push(totalPages);
  return items;
}

interface EmployeePaginationProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export function EmployeePagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
}: EmployeePaginationProps) {
  if (totalPages <= 1 && total === 0) return null;

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const items = getPageItems(page, totalPages);

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        <p className="text-xs text-muted-foreground whitespace-nowrap">
          Showing {from}–{to} of {total} employees
        </p>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => onPageSizeChange(Number(v))}
        >
          <SelectTrigger className="w-24 h-8 text-xs" aria-label="Rows per page">
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
          onClick={() => onPageChange(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        {items.map((item, i) =>
          item === 'ellipsis' ? (
            <span key={`e-${i}`} className="px-1.5 text-xs text-muted-foreground">
              …
            </span>
          ) : (
            <Button
              key={item}
              variant={item === page ? 'default' : 'outline'}
              size="icon"
              className={cn('h-8 w-8 text-xs', item === page && 'bg-primary text-primary-foreground')}
              onClick={() => onPageChange(item)}
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
          onClick={() => onPageChange(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
