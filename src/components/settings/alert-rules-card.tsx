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
import { BellRing, Plus, Trash2, Pencil, Save, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types (mirror of the API surface + condition registry) ────────────────
const CONDITION_TYPES = [
  { value: 'device_offline', label: 'Device Offline', paramKey: 'thresholdMinutes', paramLabel: 'Stale after (minutes)', paramMin: 5, paramMax: 1440, paramDefault: 15 },
  { value: 'excessive_idle', label: 'Excessive Idle Time', paramKey: 'thresholdMinutes', paramLabel: 'Idle minutes today', paramMin: 5, paramMax: 1440, paramDefault: 120 },
  { value: 'excessive_unproductive', label: 'Excessive Unproductive Time', paramKey: 'thresholdMinutes', paramLabel: 'Unproductive minutes today', paramMin: 5, paramMax: 1440, paramDefault: 120 },
  { value: 'outside_hours_activity', label: 'Off-Hours Activity', paramKey: 'thresholdCount', paramLabel: 'Events outside work hours', paramMin: 1, paramMax: 1000, paramDefault: 5 },
] as const;

const SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;

const SEVERITY_BADGE: Record<string, string> = {
  info: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  warning: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800',
  error: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-800',
  critical: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800',
};

interface AlertRuleRow {
  id: string;
  name: string;
  conditionType: string;
  params: Record<string, number>;
  severity: string;
  cooldownMinutes: number;
  enabled: boolean;
  firingCount: number;
  lastFiredAt: string | null;
}

interface RuleForm {
  name: string;
  conditionType: string;
  threshold: string;
  severity: string;
  cooldownMinutes: string;
  enabled: boolean;
}

function conditionMeta(value: string) {
  return CONDITION_TYPES.find((c) => c.value === value) ?? CONDITION_TYPES[0];
}

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return json.error || 'Request failed';
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

export function AlertRulesCard() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null); // null = closed
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AlertRuleRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<RuleForm>({
    name: '',
    conditionType: 'device_offline',
    threshold: '15',
    severity: 'warning',
    cooldownMinutes: '60',
    enabled: true,
  });

  const { data, isLoading } = useQuery({
    queryKey: ['alert-rules'],
    queryFn: async () => {
      const res = await fetch('/api/alert-rules');
      if (!res.ok) throw new Error('Failed to load alert rules');
      const json = (await res.json()) as { data: AlertRuleRow[] };
      return json.data;
    },
  });
  const rules = data ?? [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['alert-rules'] });

  const syncFormFromCondition = (conditionType: string) => {
    const meta = conditionMeta(conditionType);
    setForm((f) => ({ ...f, conditionType, threshold: String(meta.paramDefault) }));
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({
      name: '',
      conditionType: 'device_offline',
      threshold: String(conditionMeta('device_offline').paramDefault),
      severity: 'warning',
      cooldownMinutes: '60',
      enabled: true,
    });
    setCreating(true);
  };

  const openEdit = (r: AlertRuleRow) => {
    setCreating(false);
    setEditingId(r.id);
    const meta = conditionMeta(r.conditionType);
    setForm({
      name: r.name,
      conditionType: r.conditionType,
      threshold: String(r.params[meta.paramKey] ?? meta.paramDefault),
      severity: r.severity,
      cooldownMinutes: String(r.cooldownMinutes),
      enabled: r.enabled,
    });
  };

  const close = () => {
    setCreating(false);
    setEditingId(null);
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error('Rule name is required');
      return;
    }
    const meta = conditionMeta(form.conditionType);
    const threshold = Number(form.threshold);
    if (!Number.isInteger(threshold) || threshold < meta.paramMin || threshold > meta.paramMax) {
      toast.error(`${meta.paramLabel} must be an integer between ${meta.paramMin} and ${meta.paramMax}`);
      return;
    }
    const cooldownMinutes = Number(form.cooldownMinutes);
    if (!Number.isInteger(cooldownMinutes) || cooldownMinutes < 5 || cooldownMinutes > 10080) {
      toast.error('Cooldown must be between 5 minutes and 7 days');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        conditionType: form.conditionType,
        params: { [meta.paramKey]: threshold },
        severity: form.severity,
        cooldownMinutes,
        enabled: form.enabled,
      };
      const url = creating ? '/api/alert-rules' : `/api/alert-rules/${editingId}`;
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

  const toggleEnabled = async (r: AlertRuleRow, next: boolean) => {
    try {
      const res = await fetch(`/api/alert-rules/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: r.name,
          conditionType: r.conditionType,
          params: r.params,
          severity: r.severity,
          cooldownMinutes: r.cooldownMinutes,
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
      const res = await fetch(`/api/alert-rules/${deleting.id}`, { method: 'DELETE' });
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

  const editorOpen = creating || editingId !== null;

  return (
    <Card className='falcon-card falcon-card-hover'>
      <CardHeader className='pb-3'>
        <div className='flex items-center gap-3'>
          <div className='w-1 h-8 rounded-full bg-rose-500' />
          <div className='flex items-center gap-2'>
            <div className='h-8 w-8 rounded-lg bg-rose-50 dark:bg-rose-900/40 flex items-center justify-center'>
              <BellRing className='w-4 h-4 text-rose-600 dark:text-rose-300' />
            </div>
            <div>
              <CardTitle className='text-sm font-semibold'>Alert Rules</CardTitle>
              <p className='text-xs text-muted-foreground mt-0.5'>
                Server-side detection rules — evaluated only when &quot;Alert Rules&quot; is enabled above
              </p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-3'>
        <div className='flex items-center justify-between'>
          <p className='text-xs text-muted-foreground'>
            Each rule is one structured condition over real telemetry (device heartbeat, activity). A firing creates an
            alert + notification, then waits out the cooldown before the same entity can fire again — no alert storms.
          </p>
          <Button size='sm' variant='outline' onClick={openCreate}>
            <Plus className='w-4 h-4 mr-1' /> Add Rule
          </Button>
        </div>

        {editorOpen && (
          <div className='border rounded-lg p-4 space-y-3 bg-muted/20'>
            <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
              <div className='space-y-1.5'>
                <Label htmlFor='ar-name'>Rule name</Label>
                <Input id='ar-name' value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder='e.g. Flag overnight usage' />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='ar-condition'>Condition</Label>
                <Select value={form.conditionType} onValueChange={syncFormFromCondition}>
                  <SelectTrigger id='ar-condition'><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CONDITION_TYPES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='ar-threshold'>{conditionMeta(form.conditionType).paramLabel}</Label>
                <Input id='ar-threshold' type='number' value={form.threshold} onChange={(e) => setForm({ ...form, threshold: e.target.value })} />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='ar-severity'>Severity</Label>
                <Select value={form.severity} onValueChange={(v) => setForm({ ...form, severity: v })}>
                  <SelectTrigger id='ar-severity'><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='ar-cooldown'>Cooldown (minutes between firings per entity)</Label>
                <Input id='ar-cooldown' type='number' value={form.cooldownMinutes} onChange={(e) => setForm({ ...form, cooldownMinutes: e.target.value })} />
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
              <Button size='sm' variant='ghost' onClick={close}>
                <X className='w-4 h-4 mr-1' /> Cancel
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className='space-y-2'>{Array.from({ length: 3 }).map((_, i) => <div key={i} className='h-9 bg-muted/30 rounded animate-pulse' />)}</div>
        ) : rules.length === 0 ? (
          <div className='text-center py-6 text-sm text-muted-foreground border rounded-lg'>
            No alert rules yet. Rules only fire after the master switch above is enabled.
          </div>
        ) : (
          <div className='border rounded-lg divide-y'>
            {rules.map((r) => {
              const meta = conditionMeta(r.conditionType);
              return (
                <div key={r.id} className='flex items-center gap-3 px-3 py-2.5 text-sm'>
                  <div className='min-w-0 flex-1'>
                    <div className='font-medium truncate'>{r.name}</div>
                    <div className='text-xs text-muted-foreground truncate'>
                      {meta.label} · threshold {r.params[meta.paramKey] ?? '—'} · fired {r.firingCount}x · last {fmtDate(r.lastFiredAt)}
                    </div>
                  </div>
                  <Badge variant='outline' className={cn('shrink-0', SEVERITY_BADGE[r.severity] ?? '')}>
                    {r.severity}
                  </Badge>
                  <span className='text-xs text-muted-foreground shrink-0'>
                    {r.cooldownMinutes}m
                  </span>
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
              );
            })}
          </div>
        )}
      </CardContent>

      <AlertDialog open={deleting !== null} onOpenChange={(v) => { if (!v) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete rule?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{deleting?.name}&quot; will stop firing new alerts. Existing alerts and notifications are never
              deleted — only the rule and its cooldown state are removed.
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
