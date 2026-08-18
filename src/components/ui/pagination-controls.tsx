'use client';

import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  pageSize?: number;
}

function getPageNumbers(current: number, total: number): Array<number | 'ellipsis'> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: Array<number | 'ellipsis'> = [];
  pages.push(1);

  if (current > 3) {
    pages.push('ellipsis');
  }

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (current < total - 2) {
    pages.push('ellipsis');
  }

  if (total > 1) {
    pages.push(total);
  }

  return pages;
}

export function PaginationControls({ currentPage, totalPages, totalItems, onPageChange, pageSize = 10 }: PaginationControlsProps) {
  if (totalPages <= 1) return null;

  const from = (currentPage - 1) * pageSize + 1;
  const to = Math.min(currentPage * pageSize, totalItems);
  const pages = getPageNumbers(currentPage, totalPages);

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
      <p className="text-sm text-muted-foreground">
        Showing <span className="font-medium text-foreground">{from}</span> to{' '}
        <span className="font-medium text-foreground">{to}</span> of{' '}
        <span className="font-medium text-foreground">{totalItems}</span> results
      </p>
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
        >
          <ChevronLeft className="w-4 h-4" />
        </Button>
        {pages.map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`ellipsis-${i}`} className="h-8 w-8 flex items-center justify-center text-muted-foreground">
              <MoreHorizontal className="w-4 h-4" />
            </span>
          ) : (
            <Button
              key={p}
              variant={currentPage === p ? 'default' : 'outline'}
              size="icon"
              className={cn(
                'h-8 w-8 text-xs',
                currentPage === p && 'bg-emerald-600 hover:bg-emerald-700 text-white'
              )}
              onClick={() => onPageChange(p)}
            >
              {p}
            </Button>
          )
        )}
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(currentPage + 1)}
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
