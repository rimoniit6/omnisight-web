'use client';

import { useState, useRef, useCallback } from 'react';
import { useAppStore, useAuthStore, type PageType } from '@/lib/store';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  LayoutDashboard,
  Users,
  Building2,
  Monitor,
  Activity,
  Camera,
  BarChart3,
  Sparkles,
  Bot,
  Bell,
  AlertTriangle,
  ClipboardList,
  Settings,
  FileText,
  User,
  MonitorSmartphone,
  Loader2,
  Pause,
  FileBarChart,
  ShieldAlert,
  ShieldCheck,
  Brain,
  FileCheck,
  UserCircle,
  FolderKanban,
  HeartPulse,
} from 'lucide-react';

const pages: Array<{ key: PageType; label: string; icon: React.ElementType }> = [
  { key: 'dashboard', label: 'Go to Dashboard', icon: LayoutDashboard },
  { key: 'employees', label: 'Go to Employees', icon: Users },
  { key: 'departments', label: 'Go to Departments', icon: Building2 },
  { key: 'devices', label: 'Go to Devices', icon: Monitor },
  { key: 'activities', label: 'Go to Activities', icon: Activity },
  { key: 'screenshots', label: 'Go to Screenshots', icon: Camera },
  { key: 'break-status', label: 'Go to Break Monitor', icon: Pause },
  { key: 'daily-report', label: 'Go to Daily Report', icon: FileBarChart },
  { key: 'security', label: 'Go to Agent Security', icon: ShieldAlert },
  { key: 'policies', label: 'Go to Policies', icon: ShieldCheck },
  { key: 'anomalies', label: 'Go to Anomaly Detection', icon: Brain },
  { key: 'consent', label: 'Go to Consent', icon: FileCheck },
  { key: 'self-portal', label: 'Go to Employee Portal', icon: UserCircle },
  { key: 'projects', label: 'Go to Projects', icon: FolderKanban },
  { key: 'sentiment', label: 'Go to Sentiment', icon: HeartPulse },
  { key: 'analytics', label: 'Go to Analytics', icon: BarChart3 },
  { key: 'insights', label: 'Go to AI Insights', icon: Sparkles },
  { key: 'ai-provider', label: 'Go to AI Provider', icon: Bot },
  { key: 'notifications', label: 'Go to Notifications', icon: Bell },
  { key: 'alerts', label: 'Go to Alerts', icon: AlertTriangle },
  { key: 'audit', label: 'Go to Audit Logs', icon: ClipboardList },
  { key: 'organization', label: 'Go to Organization', icon: Building2 },
  { key: 'settings', label: 'Go to Settings', icon: Settings },
  { key: 'reports', label: 'Go to Reports', icon: FileText },
];

interface SearchResult {
  id: string;
  name: string;
  subtitle: string;
  detail: string | null;
  type: 'employee' | 'department' | 'device';
}

interface SearchResults {
  employees: SearchResult[];
  departments: SearchResult[];
  devices: SearchResult[];
}

export function CommandPalette() {
  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    setCurrentPage,
    setDepartmentFilter,
    setSearchQuery,
    setSelectedEmployeeId,
  } = useAppStore();

  const [internalQuery, setInternalQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset transient search state. Centralizing this in event handlers
  // (instead of an effect watching commandPaletteOpen) avoids
  // setState-in-effect and guarantees a clean palette on every open.
  const resetPalette = useCallback(() => {
    setInternalQuery('');
    setSearchResults(null);
    setIsSearching(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (abortRef.current) abortRef.current.abort();
  }, []);

  const closePalette = useCallback(() => {
    resetPalette();
    setCommandPaletteOpen(false);
  }, [resetPalette, setCommandPaletteOpen]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) resetPalette();
    setCommandPaletteOpen(open);
  }, [resetPalette, setCommandPaletteOpen]);

  const performSearch = useCallback(async (q: string) => {
    // Org-less super_admin has no tenant to search — the API would return
    // empty arrays and the palette would misleadingly say "No results found".
    // Skip the request; the UI shows the org-selection hint instead.
    const st = useAuthStore.getState();
    if (st.user?.role === 'super_admin' && !st.organization) return;

    // Cancel previous request
    if (abortRef.current) abortRef.current.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    setIsSearching(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        const json = await res.json();
        setSearchResults(json);
      }
    } catch {
      if (!controller.signal.aborted) {
        setSearchResults(null);
      }
    } finally {
      if (!controller.signal.aborted) {
        setIsSearching(false);
      }
    }
  }, []);

  const handleValueChange = useCallback(
    (value: string) => {
      setInternalQuery(value);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      if (!value.trim()) {
        setSearchResults(null);
        setIsSearching(false);
        if (abortRef.current) abortRef.current.abort();
        return;
      }

      debounceRef.current = setTimeout(() => {
        performSearch(value.trim());
      }, 300);
    },
    [performSearch]
  );

  const handleSelect = (key: PageType) => {
    setCurrentPage(key);
    closePalette();
  };

  const handleEmployeeSelect = (employee: SearchResult) => {
    setSearchQuery('');
    setSelectedEmployeeId(employee.id);
    setCurrentPage('employees');
    closePalette();
  };

  const handleDepartmentSelect = (department: SearchResult) => {
    setDepartmentFilter(department.name);
    setCurrentPage('employees');
    closePalette();
  };

  const handleDeviceSelect = () => {
    setCurrentPage('devices');
    closePalette();
  };

  const authUser = useAuthStore((s) => s.user);
  const authOrganization = useAuthStore((s) => s.organization);
  // A global super_admin without an active organization has no tenant data to
  // search (every org-scoped API returns empty). Guide them to the switcher
  // instead of the misleading "No results found".
  const orgLessSuperAdmin = authUser?.role === 'super_admin' && !authOrganization;

  const hasSearchResults =
    searchResults &&
    (searchResults.employees.length > 0 ||
      searchResults.departments.length > 0 ||
      searchResults.devices.length > 0);

  const isSearchActive = internalQuery.trim().length > 0;

  return (
    <CommandDialog
      open={commandPaletteOpen}
      onOpenChange={handleOpenChange}
    >
      <CommandInput
        placeholder='Search employees, departments, devices, or pages...'
        value={internalQuery}
        onValueChange={handleValueChange}
      />
      <CommandList>
        {isSearching && (
          <div className='flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground'>
            <Loader2 className='h-4 w-4 animate-spin' />
            <span>Searching...</span>
          </div>
        )}

        {!isSearching && isSearchActive && !hasSearchResults && !orgLessSuperAdmin && (
          <CommandEmpty>No results found for &quot;{internalQuery}&quot;</CommandEmpty>
        )}

        {!isSearching && isSearchActive && orgLessSuperAdmin && (
          <div className="py-6 px-4 text-center">
            <Building2 className="mx-auto h-6 w-6 text-muted-foreground/50 mb-2" />
            <p className="text-sm font-medium text-foreground">No organization selected</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-[280px] mx-auto leading-relaxed">
              Search works inside one organization. Pick one from the
              organization switcher in the top bar (next to your name), then
              search again.
            </p>
          </div>
        )}

        {!isSearching && isSearchActive && hasSearchResults && (
          <>
            {searchResults!.employees.length > 0 && (
              <CommandGroup heading='Employees'>
                {searchResults!.employees.map((emp) => (
                  <CommandItem
                    key={`emp-${emp.id}`}
                    onSelect={() => handleEmployeeSelect(emp)}
                  >
                    <User className='mr-2 h-4 w-4 text-muted-foreground' />
                    <div className='flex flex-col flex-1 min-w-0'>
                      <span className='truncate'>{emp.name}</span>
                      <span className='text-xs text-muted-foreground truncate'>
                        {emp.subtitle}
                      </span>
                    </div>
                    {emp.detail && (
                      <span className='ml-auto text-xs text-muted-foreground shrink-0 hidden sm:inline'>
                        {emp.detail}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {searchResults!.departments.length > 0 && (
              <CommandGroup heading='Departments'>
                {searchResults!.departments.map((dept) => (
                  <CommandItem
                    key={`dept-${dept.id}`}
                    onSelect={() => handleDepartmentSelect(dept)}
                  >
                    <Building2 className='mr-2 h-4 w-4 text-muted-foreground' />
                    <div className='flex flex-col flex-1 min-w-0'>
                      <span className='truncate'>{dept.name}</span>
                      <span className='text-xs text-muted-foreground truncate'>
                        {dept.subtitle}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {searchResults!.devices.length > 0 && (
              <CommandGroup heading='Devices'>
                {searchResults!.devices.map((device) => (
                  <CommandItem
                    key={`dev-${device.id}`}
                    onSelect={handleDeviceSelect}
                  >
                    <MonitorSmartphone className='mr-2 h-4 w-4 text-muted-foreground' />
                    <div className='flex flex-col flex-1 min-w-0'>
                      <span className='truncate'>{device.name}</span>
                      <span className='text-xs text-muted-foreground truncate'>
                        {device.subtitle}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}

        {!isSearchActive && (
          <>
            <CommandGroup heading='Pages'>
              {pages.map((p) => (
                <CommandItem
                  key={p.key}
                  onSelect={() => handleSelect(p.key)}
                >
                  <p.icon className='mr-2 h-4 w-4' />
                  <span>{p.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {/* Search hint */}
        <div className='border-t px-2 py-1.5 text-xs text-muted-foreground'>
          <span>Type to search across employees, departments, and devices</span>
        </div>
      </CommandList>
    </CommandDialog>
  );
}
