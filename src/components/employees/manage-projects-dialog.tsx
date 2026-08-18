'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Check, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface ProjectOption {
  id: string;
  name: string;
  status: string;
  priority: string;
  color: string | null;
  startDate: string | null;
  deadline: string | null;
  departmentName: string | null;
}

interface ManageProjectsDialogProps {
  employeeId: string;
  employeeName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save; caller should invalidate queries. */
  onSaved: () => void;
}

const PAGE_SIZE = 20;
const DEBOUNCE_MS = 250;
const projectStatusClass: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  on_hold: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  completed: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  cancelled: 'bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400',
};

export function ManageProjectsDialog({ employeeId, employeeName, open, onOpenChange, onSaved }: ManageProjectsDialogProps) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<ProjectOption[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const requestSeq = React.useRef(0);

  // Current ACTIVE assignments — used to seed the selected state.
  const { data: memberships } = useQuery<{ data: Array<{ projectId: string; leftAt: string | null; project: ProjectOption }> }>({
    queryKey: ['employee-projects', employeeId],
    queryFn: async () => {
      const res = await fetch(`/api/employees/${employeeId}/projects`);
      if (!res.ok) return { data: [] };
      return res.json();
    },
  });

  // Seed the selection from the employee's current active assignments.
  // The dialog is remounted per employee (callers pass a key), so the render-
  // phase guarded-setState pattern is a safe mount-time seed: it fires once
  // when data is available (immediately when cached, else when it arrives),
  // and never again — user toggles can't be clobbered.
  const activeIds = React.useMemo(
    () => (memberships?.data ?? []).filter((m) => !m.leftAt).map((m) => m.projectId),
    [memberships]
  );
  const activeKey = activeIds.join(',');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [consumedKey, setConsumedKey] = React.useState<string | null>(null);
  if (activeKey !== consumedKey) {
    if (activeKey !== '') setSelected(activeIds);
    setConsumedKey(activeKey);
  }

  // Hydrate selected projects that aren't in the current result set.
  const visibleIds = React.useMemo(() => new Set(results.map((p) => p.id)), [results]);
  const missingIds = React.useMemo(
    () => selected.filter((id) => !visibleIds.has(id)),
    [selected, visibleIds]
  );
  React.useEffect(() => {
    if (missingIds.length === 0) return;
    const seq = ++requestSeq.current;
    fetch(`/api/projects/search?ids=${missingIds.join(',')}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((json) => {
        if (seq !== requestSeq.current) return;
        setResults((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...(json.data ?? []).filter((p: ProjectOption) => !seen.has(p.id))];
        });
      })
      .catch(() => {});
  }, [missingIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // Server-side search with debounce.
  React.useEffect(() => {
    if (!open) return;
    const seq = ++requestSeq.current;
    const handler = setTimeout(async () => {
      setLoading(true);
      setError(false);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: '0' });
        if (query.trim()) params.set('q', query.trim());
        const res = await fetch(`/api/projects/search?${params}`);
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
  }, [open, query]);

  const loadMore = async () => {
    if (loading) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(results.length),
      });
      if (query.trim()) params.set('q', query.trim());
      const res = await fetch(`/api/projects/search?${params}`);
      if (!res.ok) throw new Error();
      const json = await res.json();
      if (seq !== requestSeq.current) return;
      setResults((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...(json.data ?? []).filter((p: ProjectOption) => !seen.has(p.id))];
      });
      setTotal(json.total ?? 0);
    } catch {
      if (seq !== requestSeq.current) return;
      setError(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/employees/${employeeId}/projects`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectIds: selected }),
      });
      if (!res.ok) {
        let message = 'Failed to update project assignments';
        try {
          const json = await res.json();
          if (json?.error) message = json.error;
        } catch { /* keep default */ }
        throw new Error(message);
      }
      toast.success('Project assignments updated');
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update project assignments');
    } finally {
      setSaving(false);
    }
  };

  const hasMore = results.length < total;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Manage Projects — {employeeName}</DialogTitle>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects by name..."
            className="pl-8"
          />
        </div>

        {/* Project list */}
        <div className="flex-1 overflow-y-auto min-h-[220px] max-h-[380px] border rounded-md">
          {loading && results.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Searching projects...
            </div>
          )}
          {!loading && error && (
            <div className="py-10 text-center text-sm text-destructive">Failed to load projects</div>
          )}
          {!loading && !error && results.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <p className="font-medium">No projects found</p>
              <p className="mt-0.5 text-xs">Try a different project name.</p>
            </div>
          )}
          {!error && results.length > 0 && (
            <div className="divide-y">
              {results.map((p) => {
                const isSelected = selected.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggle(p.id)}
                    className={cn(
                      'w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors',
                      isSelected ? 'bg-primary/5' : 'hover:bg-muted/30'
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded border',
                        isSelected
                          ? 'bg-primary border-primary text-primary-foreground'
                          : 'border-muted-foreground/30'
                      )}
                    >
                      {isSelected && <Check className="size-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: p.color || '#10b981' }}
                        />
                        <span className="truncate text-sm font-medium">{p.name}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {p.departmentName ? `${p.departmentName} · ` : ''}Assigned {selected.includes(p.id) ? '✓' : '—'}
                      </span>
                    </span>
                    <Badge variant="secondary" className={cn('text-[10px] capitalize shrink-0', projectStatusClass[p.status])}>
                      {p.status.replace('_', ' ')}
                    </Badge>
                  </button>
                );
              })}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  className="w-full py-2.5 text-center text-xs text-muted-foreground hover:bg-muted/30 transition-colors"
                >
                  {loading ? <Loader2 className="size-3.5 animate-spin inline" /> : `Showing ${results.length} of ${total} — Load more`}
                </button>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 pt-2">
          <span className="text-xs text-muted-foreground">
            {selected.length} project{selected.length !== 1 ? 's' : ''} assigned
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700">
              {saving ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
