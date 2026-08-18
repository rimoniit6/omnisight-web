// Shared types + query-string helpers for the Employees list feature.

export type EmployeeStatus = 'active' | 'inactive' | 'archived';
export type RoleFilter = '' | 'manager' | 'employee';
export type DeviceStatusFilter = '' | 'online' | 'offline' | 'no_device';
export type DateRangeFilter = 'all' | 'today' | '7d' | '30d' | 'custom';

export interface EmployeeListFilters {
  search: string;
  status: EmployeeStatus | '';
  organizationId: string;
  departmentId: string;
  role: RoleFilter;
  deviceStatus: DeviceStatusFilter;
  dateRange: DateRangeFilter;
  createdFrom: string; // YYYY-MM-DD (custom range)
  createdTo: string; // YYYY-MM-DD (custom range)
}

export interface EmployeeSort {
  sortBy: string;
  sortOrder: 'asc' | 'desc';
}

export const DEFAULT_FILTERS: EmployeeListFilters = {
  search: '',
  status: '',
  organizationId: '',
  departmentId: '',
  role: '',
  deviceStatus: '',
  dateRange: 'all',
  createdFrom: '',
  createdTo: '',
};

export interface EmployeeRow {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  avatar: string | null;
  designation: string | null;
  status: string;
  departmentId: string | null;
  joinDate: string | null;
  createdAt: string;
  department: { id: string; name: string } | null;
  devices: Array<{ id: string; name: string; status: string; lastHeartbeat: string | null }>;
}

export interface EmployeesApiResponse {
  data: EmployeeRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  activeCount: number;
  inactiveCount: number;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

/** Number of days back for the quick date-range options. */
export function dateRangeStart(dateRange: DateRangeFilter): string | null {
  const today = new Date();
  let from: Date | null = null;
  if (dateRange === 'today') {
    from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  } else if (dateRange === '7d') {
    from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
  } else if (dateRange === '30d') {
    from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
  }
  return from ? from.toISOString().slice(0, 10) : null;
}

/** Build the query string sent to /api/employees (and mirrored to the URL). */
export function buildEmployeesQuery(
  filters: EmployeeListFilters,
  sort: EmployeeSort,
  page: number,
  pageSize: number
): string {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  if (filters.search.trim()) params.set('search', filters.search.trim());
  if (filters.status) params.set('status', filters.status);
  if (filters.organizationId) params.set('organizationId', filters.organizationId);
  if (filters.departmentId) params.set('departmentId', filters.departmentId);
  if (filters.role) params.set('role', filters.role);
  if (filters.deviceStatus) params.set('deviceStatus', filters.deviceStatus);
  if (filters.dateRange === 'custom') {
    if (filters.createdFrom) params.set('createdFrom', filters.createdFrom);
    if (filters.createdTo) params.set('createdTo', filters.createdTo);
  } else {
    const from = dateRangeStart(filters.dateRange);
    if (from) params.set('createdFrom', from);
  }
  if (sort.sortBy) {
    params.set('sortBy', sort.sortBy);
    params.set('sortOrder', sort.sortOrder);
  }
  return params.toString();
}

/** Parse filters/sort/pagination back out of URL search params. */
export function parseEmployeesQuery(
  searchParams: URLSearchParams
): { filters: EmployeeListFilters; sort: EmployeeSort; page: number; pageSize: number } | null {
  const filters: EmployeeListFilters = { ...DEFAULT_FILTERS };

  filters.search = (searchParams.get('search') || '').slice(0, 100);
  const status = (searchParams.get('status') || '').toLowerCase();
  filters.status = ['active', 'inactive', 'archived'].includes(status)
    ? (status as EmployeeStatus)
    : '';
  filters.organizationId = searchParams.get('organizationId') || '';
  filters.departmentId = searchParams.get('departmentId') || '';
  const role = (searchParams.get('role') || '').toLowerCase();
  filters.role = ['manager', 'employee'].includes(role) ? (role as RoleFilter) : '';
  const deviceStatus = (searchParams.get('deviceStatus') || '').toLowerCase().replace('-', '_');
  filters.deviceStatus = ['online', 'offline', 'no_device'].includes(deviceStatus)
    ? (deviceStatus as DeviceStatusFilter)
    : '';

  const createdFrom = (searchParams.get('createdFrom') || '').slice(0, 10);
  const createdTo = (searchParams.get('createdTo') || '').slice(0, 10);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  filters.createdFrom = DATE_RE.test(createdFrom) ? createdFrom : '';
  filters.createdTo = DATE_RE.test(createdTo) ? createdTo : '';
  if (filters.createdFrom || filters.createdTo) {
    filters.dateRange = 'custom';
  }

  const sort: EmployeeSort = {
    sortBy: searchParams.get('sortBy') || '',
    sortOrder: searchParams.get('sortOrder') === 'desc' ? 'desc' : 'asc',
  };

  const page = parseInt(searchParams.get('page') || '1', 10);
  const pageSize = parseInt(searchParams.get('pageSize') || '20', 10);

  return {
    filters,
    sort,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
    pageSize: PAGE_SIZE_OPTIONS.includes(pageSize as (typeof PAGE_SIZE_OPTIONS)[number])
      ? (pageSize as (typeof PAGE_SIZE_OPTIONS)[number])
      : 20,
  };
}

/** True when any filter is active (used to decide empty-state copy / clear button). */
export function hasActiveFilters(filters: EmployeeListFilters): boolean {
  return Boolean(
    filters.search.trim() ||
      filters.status ||
      filters.organizationId ||
      filters.departmentId ||
      filters.role ||
      filters.deviceStatus ||
      filters.createdFrom ||
      filters.createdTo ||
      filters.dateRange !== 'all'
  );
}
