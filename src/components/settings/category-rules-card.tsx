'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import { ListChecks, Plus, Trash2, Pencil, Save, X, FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types (mirror of the API surface) ──────────────────────────────────────
const MATCH_TYPES = [
  { value: 'executable', label: 'Executable (process name)' },
  { value: 'application', label: 'Application (window title)' },
  { value: 'domain', label: 'Domain (website)' },
] as const;

const CATEGORIES = [
  { value: 'productive', label: 'Productive' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'unproductive', label: 'Unproductive' },
] as const;

interface CategoryRuleRow {
  id: string;
  name: string;
  matchType: string;
  pattern: string;
  category: string;
  priority: number;
  enabled: boolean;
}

interface RuleForm {
  name: string;
  matchType: string;
  pattern: string;
  category: string;
  priority: string;
  enabled: boolean;
}

const EMPTY_FORM: RuleForm = {
  name: '',
  matchType: 'executable',
  pattern: '',
  category: 'productive',
  priority: '100',
  enabled: true,
};

const CATEGORY_BADGE: Record<string, string> = {
  productive: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800',
  neutral: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  unproductive: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800',
};

function matchTypeLabel(v: string): string {
  return MATCH_TYPES.find((m) => m.value === v)?.label ?? v;
}

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return json.error || 'Request failed';
}

export function CategoryRulesCard() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null); // null = closed
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<CategoryRuleRow | null>(null);
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [dryRun, setDryRun] = useState<Array<{ input: string; category: string | null; source: string }> | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['category-rules'],
    queryFn: async () => {
      const res = await fetch('/api/category-rules');
      if (!res.ok) throw new Error('Failed to load category rules');
      const json = (await res.json()) as { data: CategoryRuleRow[] };
      return json.data;
    },
  });
  const rules = data ?? [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['category-rules'] });

  const openCreate = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setCreating(true);
  };

  const openEdit = (r: CategoryRuleRow) => {
    setCreating(false);
    setEditingId(r.id);
    setForm({
      name: r.name,
      matchType: r.matchType,
      pattern: r.pattern,
      category: r.category,
      priority: String(r.priority),
      enabled: r.enabled,
    });
  };

  const close = () => {
    setCreating(false);
    setEditingId(null);
    setDryRun(null);
  };

  const save = async () => {
    if (!form.name.trim() || !form.pattern.trim()) {
      toast.error('Name and pattern are required');
      return;
    }
    const priority = Number(form.priority);
    if (!Number.isInteger(priority) || priority < -1000 || priority > 1000) {
      toast.error('Priority must be an integer between -1000 and 1000');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        matchType: form.matchType,
        pattern: form.pattern.trim(),
        category: form.category,
        priority,
        enabled: form.enabled,
      };
      const url = creating
        ? '/api/category-rules'
        : `/api/category-rules/${editingId}`;
      const res = await fetch(url, {
        method: creating ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success(creating ? 'Rule created' : 'Rule updated');
      close();
      void invalidate();
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (r: CategoryRuleRow, next: boolean) => {
    try {
      const res = await fetch(`/api/category-rules/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: r.name,
          matchType: r.matchType,
          pattern: r.pattern,
          category: r.category,
          priority: r.priority,
          enabled: next,
        }),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success(next ? 'Rule enabled' : 'Rule disabled');
      void invalidate();
    } catch {
      toast.error('Failed to update rule');
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      const res = await fetch(`/api/category-rules/${deleting.id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      toast.success('Rule deleted');
      setDeleting(null);
      void invalidate();
    } catch {
      toast.error('Failed to delete rule');
    }
  };

  // Dry-run: preview the CURRENT form (or a sample of saved rules) against a
  // few sample rows WITHOUT persisting — the "test before you enable" gate.
  const runDryRun = async () => {
    setDryRun(null);
    try {
      const samples = [
        { type: 'application', applicationName: 'chrome.exe', title: null },
        { type: 'application', applicationName: 'Code.exe', title: null },
        { type: 'application', applicationName: 'Steam.exe', title: null },
        { type: 'website', url: 'github.com' },
        { type: 'website', url: 'youtube.com' },
        { type: 'website', url: 'example.com' },
      ];
      // If an editor is open, evaluate the candidate form too — otherwise
      // evaluate the currently-saved rules.
      const body: Record<string, unknown> = { samples };
      if (creating || editingId) {
        body.rules = [
          {
            name: form.name || 'draft',
            matchType: form.matchType,
            pattern: form.pattern || '____',
            category: form.category,
            priority: Number(form.priority) || 100,
            enabled: form.enabled,
          },
        ];
      }
      const res = await fetch('/api/category-rules/dry-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        toast.error(await readError(res));
        return;
      }
      const json = (await res.json()) as {
        data: Array<{ type: string; applicationName: string | null; url: string | null; category: string | null; source: string }>;
      };
      setDryRun(
        json.data.map((d) => ({
          input: d.type === 'website' ? String(d.url) : String(d.applicationName),
          category: d.category,
          source: d.source,
        }))
      );
    } catch {
      toast.error('Failed to evaluate dry-run');
    }
  };

  const editorOpen = creating || editingId !== null;

  return (
    <Card className='falcon-card falcon-card-hover'>
      <CardHeader className='pb-3'>
        <div className='flex items-center gap-3'>
          <div className='w-1 h-8 rounded-full bg-violet-500' />
          <div className='flex items-center gap-2'>
            <div className='h-8 w-8 rounded-lg bg-violet-50 dark:bg-violet-900/40 flex items-center justify-center'>
              <ListChecks className='w-4 h-4 text-violet-600 dark:text-violet-300' />
            </div>
            <div>
              <CardTitle className='text-sm font-semibold'>Productivity Category Rules</CardTitle>
              <p className='text-xs text-muted-foreground mt-0.5'>
                Server-authoritative classification — applied when &quot;Server Classification&quot; is enabled above
              </p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-3'>
        <div className='flex items-center justify-between'>
          <p className='text-xs text-muted-foreground'>
            Rules match in priority order (lower number wins first). Unmatched activity falls back to the
            built-in default heuristic — enabling rules never changes apps you have not explicitly configured.
          </p>
          <Button size='sm' variant='outline' onClick={openCreate}>
            <Plus className='w-4 h-4 mr-1' /> Add Rule
          </Button>
        </div>

        {editorOpen && (
          <div className='border rounded-lg p-4 space-y-3 bg-muted/20'>
            <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
              <div className='space-y-1.5'>
                <Label htmlFor='cr-name'>Rule name</Label>
                <Input id='cr-name' value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder='e.g. Block gaming sites' />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='cr-match'>Target type</Label>
                <Select value={form.matchType} onValueChange={(v) => setForm({ ...form, matchType: v })}>
                  <SelectTrigger id='cr-match'><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {MATCH_TYPES.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='cr-pattern'>Pattern (case-insensitive substring)</Label>
                <Input id='cr-pattern' value={form.pattern} onChange={(e) => setForm({ ...form, pattern: e.target.value })} placeholder={form.matchType === 'domain' ? 'youtube.com' : 'steam.exe'} />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='cr-cat'>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                  <SelectTrigger id='cr-cat'><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='cr-priority'>Priority (lower = higher)</Label>
                <Input id='cr-priority' type='number' value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
              </div>
              <div className='flex items-end gap-2 pb-1'>
                <div className='flex items-center gap-2'>
                  <Switch checked={form.enabled} onCheckedChange={(v) => setForm({ ...form, enabled: v })} />
                  <span className='text-sm'>{form.enabled ? 'Enabled' : 'Disabled'}</span>
                </div>
              </div>
            </div>
            <div className='flex items-center gap-2'>
              <Button size='sm' onClick={save} disabled={saving}>
                <Save className='w-4 h-4 mr-1' /> {saving ? 'Saving…' : creating ? 'Create Rule' : 'Save Changes'}
              </Button>
              <Button size='sm' variant='outline' onClick={runDryRun}>
                <FlaskConical className='w-4 h-4 mr-1' /> Test Match (dry-run)
              </Button>
              <Button size='sm' variant='ghost' onClick={close}>
                <X className='w-4 h-4 mr-1' /> Cancel
              </Button>
            </div>
          </div>
        )}

        {dryRun && (
          <div className='border rounded-lg p-3 text-xs space-y-1 bg-violet-50/50 dark:bg-violet-900/20'>
            <div className='font-medium text-violet-700 dark:text-violet-300 flex items-center gap-1'>
              <FlaskConical className='w-3.5 h-3.5' /> Dry-run preview (nothing saved)
            </div>
            {dryRun.map((d, i) => (
              <div key={i} className='flex items-center justify-between'>
                <span className='font-mono truncate max-w-[55%]'>{d.input}</span>
                <span>
                  <Badge variant='outline' className={cn('ml-2', d.category ? CATEGORY_BADGE[d.category] : '')}>
                    {d.category ?? 'unchanged'}
                  </Badge>
                  <span className='text-muted-foreground ml-2'>{d.source === 'rule' ? 'rule' : d.source === 'default-heuristic' ? 'default' : ''}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        {isLoading ? (
          <div className='space-y-2'>{Array.from({ length: 3 }).map((_, i) => <div key={i} className='h-9 bg-muted/30 rounded animate-pulse' />)}</div>
        ) : rules.length === 0 ? (
          <div className='text-center py-6 text-sm text-muted-foreground border rounded-lg'>
            No rules yet. Add a rule to override the default heuristic for specific apps or sites.
          </div>
        ) : (
          <div className='border rounded-lg divide-y'>
            {rules.map((r) => (
              <div key={r.id} className='flex items-center gap-3 px-3 py-2.5 text-sm'>
                <div className='min-w-0 flex-1'>
                  <div className='font-medium truncate'>{r.name}</div>
                  <div className='text-xs text-muted-foreground truncate'>
                    {matchTypeLabel(r.matchType)} · <span className='font-mono'>{r.pattern}</span>
                  </div>
                </div>
                <Badge variant='outline' className={cn('shrink-0', CATEGORY_BADGE[r.category] ?? '')}>
                  {r.category}
                </Badge>
                <span className='text-xs text-muted-foreground shrink-0 w-8 text-right'>P{r.priority}</span>
                <div className='flex items-center gap-1 shrink-0'>
                  <Switch checked={r.enabled} onCheckedChange={(v) => toggleEnabled(r, v)} />
                </div>
                <div className='flex items-center gap-0.5 shrink-0'>
                  <Button size='icon' variant='ghost' className='h-7 w-7' onClick={() => openEdit(r)} aria-label={`Edit ${r.name}`}>
                    <Pencil className='w-3.5 h-3.5' />
                  </Button>
                  <Button size='icon' variant='ghost' className='h-7 w-7 text-red-500 hover:text-red-600' onClick={() => setDeleting(r)} aria-label={`Delete ${r.name}`}>
                    <Trash2 className='w-3.5 h-3.5' />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <AlertDialog open={deleting !== null} onOpenChange={(v) => { if (!v) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete rule?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleting?.name}&quot; will stop affecting classification. Existing activity is never
              rewritten or deleted — this only changes future classification.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className='bg-red-600 hover:bg-red-700 text-white'>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
