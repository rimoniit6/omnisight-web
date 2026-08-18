'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EmployeeOption {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  designation: string | null;
  avatar: string | null;
  departmentName: string | null;
}

type EmployeeStatus = 'active' | 'inactive' | 'all';

type LabelFormat = 'name' | 'name-id' | 'name-dept' | 'name-designation' | 'name-email';

export interface EmployeeComboboxProps {
  value: string | string[] | null | undefined;
  onValueChange: (value: string | string[] | null) => void;
  /** Multi-select mode (chips + checkboxes). */
  multiple?: boolean;
  /** Static option list — enables client-side filtering (small lists only). */
  options?: EmployeeOption[];
  /** Server-side status filter (ignored when `options` is provided). */
  status?: EmployeeStatus;
  placeholder?: string;
  disabled?: boolean;
  /** Show a clear (×) button inside the trigger. */
  allowClear?: boolean;
  /** Placeholder shown by the clear button (e.g. "All Employees" filters). */
  clearLabel?: string;
  className?: string;
  size?: 'sm' | 'default';
  labelFormat?: LabelFormat;
  /** Called with the full option on selection change (single mode only). */
  onSelect?: (option: EmployeeOption | null) => void;
  ariaLabel?: string;
}

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 250;

function formatName(emp: EmployeeOption) {
  return `${emp.firstName} ${emp.lastName}`;
}

function formatLabel(emp: EmployeeOption, format: LabelFormat) {
  switch (format) {
    case 'name-id':
      return `${formatName(emp)} (${emp.employeeId})`;
    case 'name-dept':
      return `${formatName(emp)}${emp.departmentName ? ` (${emp.departmentName})` : ''}`;
    case 'name-designation':
      return `${formatName(emp)}${emp.designation ? ` · ${emp.designation}` : ''}`;
    case 'name-email':
      return `${formatName(emp)} — ${emp.email ?? ''}`;
    default:
      return formatName(emp);
  }
}

function initials(emp: EmployeeOption) {
  return `${emp.firstName[0] ?? ''}${emp.lastName[0] ?? ''}`.toUpperCase();
}

function matchesQuery(emp: EmployeeOption, q: string) {
  const needle = q.toLowerCase();
  if (!needle) return true;
  return (
    emp.firstName.toLowerCase().includes(needle) ||
    emp.lastName.toLowerCase().includes(needle) ||
    emp.email?.toLowerCase().includes(needle) ||
    emp.employeeId.toLowerCase().includes(needle)
  );
}

function dedupe(list: EmployeeOption[]) {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

// ─── Component ──────────────────────────────────────────────────────────────

export function EmployeeCombobox({
  value,
  onValueChange,
  multiple = false,
  options,
  status = 'all',
  placeholder = 'Select employee...',
  disabled,
  allowClear = false,
  clearLabel,
  className,
  size = 'default',
  labelFormat = 'name',
  onSelect,
  ariaLabel,
}: EmployeeComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<EmployeeOption[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);
  const requestSeq = React.useRef(0);

  const isServer = !options;
  const selectedIds = React.useMemo(
    () => (Array.isArray(value) ? value : value ? [value] : []),
    [value]
  );

  const selectedOptions = React.useMemo(
    () => dedupe([...results, ...(options ?? [])]).filter((e) => selectedIds.includes(e.id)),
    [results, options, selectedIds]
  );

  // Hydrate the selected employee(s) when they aren't in the current result
  // set (e.g. editing a record whose owner is outside the first page).
  const missingIds = React.useMemo(
    () => selectedIds.filter((id) => !selectedOptions.some((e) => e.id === id)),
    [selectedIds, selectedOptions]
  );
  React.useEffect(() => {
    if (!isServer || missingIds.length === 0 || disabled) return;
    const seq = ++requestSeq.current;
    const params = new URLSearchParams({ ids: missingIds.join(',') });
    if (status !== 'all') params.set('status', status);
    fetch(`/api/employees/search?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((json) => {
        if (seq !== requestSeq.current) return;
        setResults((prev) => dedupe([...prev, ...(json.data ?? [])]));
      })
      .catch(() => {});
  }, [isServer, missingIds.join(','), status, disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Server-side search with debounce (client-side filter in options mode).
  React.useEffect(() => {
    if (!open || !isServer) return;
    const seq = ++requestSeq.current;
    const handler = setTimeout(async () => {
      setLoading(true);
      setError(false);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: '0' });
        if (query.trim()) params.set('q', query.trim());
        if (status !== 'all') params.set('status', status);
        const res = await fetch(`/api/employees/search?${params}`);
        if (!res.ok) throw new Error();
        const json = await res.json();
        if (seq !== requestSeq.current) return;
        setResults(json.data ?? []);
        setTotal(json.total ?? 0);
      } catch {
        if (seq !== requestSeq.current) return;
        setError(true);
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }, query ? DEBOUNCE_MS : 0);
    return () => clearTimeout(handler);
  }, [open, query, isServer, status]);

  // Reset the query when the popover closes so reopening shows the initial
  // list again.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  };

  const loadMore = async () => {
    if (!isServer || loading) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(results.length),
      });
      if (query.trim()) params.set('q', query.trim());
      if (status !== 'all') params.set('status', status);
      const res = await fetch(`/api/employees/search?${params}`);
      if (!res.ok) throw new Error();
      const json = await res.json();
      if (seq !== requestSeq.current) return;
      setResults((prev) => dedupe([...prev, ...(json.data ?? [])]));
      setTotal(json.total ?? 0);
    } catch {
      if (seq !== requestSeq.current) return;
      setError(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  const visible = React.useMemo(() => {
    if (options) return options.filter((e) => matchesQuery(e, query));
    return results;
  }, [options, query, results]);

  const hasMore = isServer && visible.length < total;

  const selectId = (id: string) => {
    if (multiple) {
      const next = selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id];
      onValueChange(next);
    } else {
      const next = selectedIds.includes(id) ? null : id;
      onValueChange(next);
      if (onSelect) onSelect(visible.find((e) => e.id === id) ?? null);
      setOpen(false);
    }
  };

  const clearSelection = () => {
    onValueChange(multiple ? [] : null);
    if (onSelect) onSelect(null);
  };

  // The clear control must NOT live inside the trigger: a <button> cannot
  // contain interactive content (invalid HTML → hydration error). It is
  // rendered as an overlaid sibling outside the PopoverTrigger (see below).
  const showClear = allowClear && selectedOptions.length > 0 && !disabled;

  const trigger = (
    <button
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => setOpen((o) => !o)}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-md border bg-transparent text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        size === 'sm' ? 'h-8 px-2.5 text-xs' : 'h-9 px-3',
        !selectedOptions.length && 'text-muted-foreground'
      )}
    >
      {selectedOptions.length > 0 ? (
        multiple ? (
          <span className="flex flex-wrap items-center gap-1 min-w-0">
            {selectedOptions.map((emp) => (
              <Badge
                key={emp.id}
                variant="secondary"
                className="gap-1 font-normal max-w-full"
              >
                {/* Display-only chip: a <button> here would nest inside the
                    trigger <button> (invalid HTML → hydration error). Remove a
                    selection by toggling it in the dropdown list instead. */}
                <span className="truncate">{formatName(emp)}</span>
              </Badge>
            ))}
          </span>
        ) : (
          <span className="truncate">{formatLabel(selectedOptions[0], labelFormat)}</span>
        )
      ) : (
        <span className="truncate">{placeholder}</span>
      )}
      {showClear ? (
        // Reserve the right-hand slot so the overlaid clear button never
        // overlaps the label or the chevron area.
        <span aria-hidden="true" className={cn('shrink-0', size === 'sm' ? 'size-3.5' : 'size-4')} />
      ) : (
        <ChevronsUpDown className={cn('shrink-0 opacity-50', size === 'sm' ? 'size-3.5' : 'size-4')} />
      )}
    </button>
  );

  return (
    <div className={cn('relative w-full', className)}>
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            placeholder="Search employee..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Searching employees...
              </div>
            )}
            {!loading && error && (
              <div className="py-6 text-center text-sm text-destructive">
                Failed to load employees
              </div>
            )}
            {!loading && !error && visible.length === 0 && (
              <div className="py-6 text-center text-sm text-muted-foreground">
                <p className="font-medium">No employees found</p>
                <p className="mt-0.5 text-xs">Try a different name, email, or employee ID.</p>
              </div>
            )}
            {!loading && !error && visible.length > 0 && (
              <CommandGroup>
                {visible.map((emp) => {
                  const isSelected = selectedIds.includes(emp.id);
                  return (
                    <CommandItem
                      key={emp.id}
                      value={emp.id}
                      onSelect={() => selectId(emp.id)}
                      className="flex items-center gap-2 py-2"
                    >
                      <span
                        className={cn(
                          'flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold',
                          isSelected
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground'
                        )}
                      >
                        {initials(emp)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{formatName(emp)}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {emp.email ?? emp.employeeId}
                          {emp.departmentName ? ` · ${emp.departmentName}` : ''}
                        </span>
                      </span>
                      {isSelected && <Check className="size-4 shrink-0 text-primary" />}
                    </CommandItem>
                  );
                })}
                {hasMore && (
                  <CommandItem
                    value="__load_more__"
                    onSelect={() => void loadMore()}
                    className="justify-center py-2 text-xs text-muted-foreground"
                  >
                    {loading ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      `Showing ${visible.length} results — Load more`
                    )}
                  </CommandItem>
                )}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
    {showClear && (
      <button
        type="button"
        tabIndex={-1}
        aria-label={clearLabel ?? 'Clear selection'}
        // Sibling of the trigger (never a descendant), so it can never open or
        // toggle the Popover. stopPropagation is kept for parity: it also keeps
        // Radix pointerdown-outside handling from closing an already-open
        // Popover while clearing.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          clearSelection();
        }}
        className={cn(
          'absolute top-1/2 -translate-y-1/2 shrink-0 rounded-sm text-muted-foreground opacity-60 hover:opacity-100 hover:text-foreground',
          size === 'sm' ? 'right-2.5' : 'right-3'
        )}
      >
        <X className={size === 'sm' ? 'size-3.5' : 'size-4'} />
      </button>
    )}
    </div>
  );
}
