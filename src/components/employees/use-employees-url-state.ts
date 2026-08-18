'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_FILTERS,
  buildEmployeesQuery,
  parseEmployeesQuery,
  type DateRangeFilter,
  type EmployeeListFilters,
  type EmployeeSort,
} from './employee-query';

/**
 * URL-synchronized employees list state.
 *
 * Filters, sorting and pagination live in the URL query string so that
 * browser refresh preserves the view, back/forward restores previous states
 * and copied URLs reproduce the exact employee list.
 *
 * Push strategy: every committed change pushes a history entry; typing in the
 * search box is debounced so history isn't spammed per keystroke. Changes
 * that come from popstate are never re-pushed (the URL already reflects them).
 */
export function useEmployeesUrlState() {
  // Lazy initial state restores filters/sort/pagination from the URL on
  // mount (browser refresh / direct link) without a setState-in-effect.
  const initial = typeof window === 'undefined'
    ? null
    : parseEmployeesQuery(new URLSearchParams(window.location.search));
  const [filters, setFilters] = useState<EmployeeListFilters>(initial?.filters ?? DEFAULT_FILTERS);
  const [sort, setSort] = useState<EmployeeSort>(initial?.sort ?? { sortBy: '', sortOrder: 'asc' });
  const [page, setPage] = useState(initial?.page ?? 1);
  const [pageSize, setPageSize] = useState(initial?.pageSize ?? 20);

  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyParsed = useCallback((parsed: NonNullable<ReturnType<typeof parseEmployeesQuery>>) => {
    setFilters(parsed.filters);
    setSort(parsed.sort);
    setPage(parsed.page);
    setPageSize(parsed.pageSize);
  }, []);

  // Back/forward navigation.
  useEffect(() => {
    const onPopState = () => {
      const parsed = parseEmployeesQuery(new URLSearchParams(window.location.search));
      if (parsed) {
        applyParsed(parsed);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyParsed]);

  // Push state into the URL whenever the view changes. The search box is
  // debounced; everything else pushes immediately (the URL is already equal
  // for popstate restores, so those are no-ops).
  useEffect(() => {
    const url = new URL(window.location.href);
    url.search = buildEmployeesQuery(filters, sort, page, pageSize);
    const candidate = url.href;
    if (candidate === window.location.href) return;

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      window.history.pushState({}, '', candidate);
    }, 300);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [filters, sort, page, pageSize]);

  // ── Mutators (each resets pagination to page 1, per spec) ────────────────

  const patchFilters = useCallback((patch: Partial<EmployeeListFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
    setPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    setPage(1);
  }, []);

  const setSearch = useCallback((search: string) => {
    setFilters((prev) => ({ ...prev, search }));
    setPage(1);
  }, []);

  const setStatus = useCallback((status: EmployeeListFilters['status']) => patchFilters({ status }), [patchFilters]);
  const setOrganizationId = useCallback((organizationId: string) => patchFilters({ organizationId }), [patchFilters]);
  const setDepartmentId = useCallback((departmentId: string) => patchFilters({ departmentId }), [patchFilters]);
  const setRole = useCallback((role: EmployeeListFilters['role']) => patchFilters({ role }), [patchFilters]);
  const setDeviceStatus = useCallback(
    (deviceStatus: EmployeeListFilters['deviceStatus']) => patchFilters({ deviceStatus }),
    [patchFilters]
  );
  const setDateRange = useCallback((dateRange: DateRangeFilter) => {
    setFilters((prev) => ({
      ...prev,
      dateRange,
      createdFrom: dateRange === 'custom' ? prev.createdFrom : '',
      createdTo: dateRange === 'custom' ? prev.createdTo : '',
    }));
    setPage(1);
  }, []);

  const setCreatedFrom = useCallback((createdFrom: string) => {
    setFilters((prev) => ({ ...prev, createdFrom }));
    setPage(1);
  }, []);
  const setCreatedTo = useCallback((createdTo: string) => {
    setFilters((prev) => ({ ...prev, createdTo }));
    setPage(1);
  }, []);

  const setSortBy = useCallback((sortBy: string) => {
    setSort((prev) => ({
      sortBy,
      sortOrder: prev.sortBy === sortBy ? (prev.sortOrder === 'asc' ? 'desc' : 'asc') : 'asc',
    }));
    setPage(1);
  }, []);
  const setSortOrder = useCallback((sortOrder: 'asc' | 'desc') => {
    setSort((prev) => ({ ...prev, sortOrder }));
    setPage(1);
  }, []);

  const changePageSize = useCallback((size: number) => {
    setPageSize(size);
    setPage(1);
  }, []);

  return {
    filters,
    sort,
    page,
    pageSize,
    patchFilters,
    clearFilters,
    setSearch,
    setStatus,
    setOrganizationId,
    setDepartmentId,
    setRole,
    setDeviceStatus,
    setDateRange,
    setCreatedFrom,
    setCreatedTo,
    setSortBy,
    setSortOrder,
    setPage,
    setPageSize: changePageSize,
  };
}
