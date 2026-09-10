'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { DataTable, EmptyState, ErrorState, LoadingBlock, PageHeader, PageTransition, StatusPill } from './ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// ─── Packages — reusable catalog (the ONE canonical Packages surface) ───────
// Subscriptions / manual payments / licenses are NOT standalone menus: they
// are managed from each Organization (Organizations → Organization). Package
// CRUD reuses the existing super-admin package APIs — no second route, no
// duplicated API logic.
interface PackageRow {
  id: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number | null;
  currency: string;
  maxDevices: number;
  retentionDays: number;
  isSelfHosted: boolean;
  isActive: boolean;
  subscriptionCount: number;
  licenseKeyCount: number;
}

const EMPTY_FORM = {
  name: '',
  description: '',
  priceMonthly: '0',
  priceYearly: '',
  currency: 'BDT',
  maxDevices: '5',
  retentionDays: '90',
  isSelfHosted: false,
  features: '',
};

export function SuperAdminPackagesPage() {
  const [includeInactive, setIncludeInactive] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PackageRow | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery<{ data: PackageRow[] }>({
    queryKey: ['sa-packages', includeInactive],
    queryFn: async () => {
      const res = await fetch(`/api/super-admin/packages?includeInactive=${includeInactive}&pageSize=200`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`packages ${res.status}`);
      return res.json();
    },
  });

  function openCreate() {
    setEditing(null);
    setForm({ ...EMPTY_FORM });
    setDialogOpen(true);
  }

  function openEdit(pkg: PackageRow) {
    setEditing(pkg);
    setForm({
      name: pkg.name,
      description: pkg.description ?? '',
      priceMonthly: String(pkg.priceMonthly),
      priceYearly: pkg.priceYearly == null ? '' : String(pkg.priceYearly),
      currency: pkg.currency,
      maxDevices: String(pkg.maxDevices),
      retentionDays: String(pkg.retentionDays),
      isSelfHosted: pkg.isSelfHosted,
      features: '',
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        priceMonthly: Number(form.priceMonthly),
        priceYearly: form.priceYearly === '' ? null : Number(form.priceYearly),
        currency: form.currency.trim() || 'BDT',
        maxDevices: Number(form.maxDevices),
        retentionDays: Number(form.retentionDays),
        isSelfHosted: form.isSelfHosted,
        features: form.features.split(',').map((f) => f.trim()).filter(Boolean),
      };
      const res = await fetch(
        editing ? `/api/super-admin/packages/${editing.id}` : '/api/super-admin/packages',
        {
          method: editing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to save package');
        return;
      }
      toast.success(editing ? 'Package updated' : 'Package created');
      setDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['sa-packages'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const toggleActive = async (p: PackageRow) => {
    setActionId(p.id);
    try {
      const res = await fetch(`/api/super-admin/packages/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ isActive: !p.isActive }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to update package');
        return;
      }
      queryClient.invalidateQueries({ queryKey: ['sa-packages'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setActionId(null);
    }
  };

  async function handleDelete(pkg: PackageRow) {
    if (!window.confirm(`Delete package "${pkg.name}"? Only unreferenced packages can be deleted.`)) return;
    setActionId(pkg.id);
    try {
      const res = await fetch(`/api/super-admin/packages/${pkg.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to delete package');
        return;
      }
      toast.success('Package deleted');
      queryClient.invalidateQueries({ queryKey: ['sa-packages'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setActionId(null);
    }
  }

  return (
    <PageTransition>
      <PageHeader
        eyebrow="Control Center"
        title="Packages"
        description="Reusable package catalog for the manual-sales model. Features shown are enforced by the backend package configuration. Package assignment happens per Organization during provisioning."
      />
      <div className="mb-4 flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[12.5px] text-foreground/55">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="h-3.5 w-3.5 accent-cyan-300"
          />
          Include inactive
        </label>
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Create Package
        </Button>
      </div>

      {isLoading && <LoadingBlock label="Loading packages…" />}
      {isError && <ErrorState onRetry={() => refetch()} />}
      {data && (
        <DataTable
          headers={['Package', 'Price', 'Devices', 'Retention', 'Subs', 'Licenses', 'Status', '']}
          loading={isLoading}
          empty={<EmptyState title="No packages found." />}
        >
          {data.data.map((p) => (
            <tr key={p.id} className="transition-colors hover:bg-muted/40">
              <td className="px-3.5 py-3">
                <p className="font-medium text-foreground">{p.name}</p>
                <p className="text-[11px] text-foreground/40">
                  {[p.description || '—', p.isSelfHosted ? 'self-hosted' : null].filter(Boolean).join(' · ')}
                </p>
              </td>
              <td className="px-3.5 py-3 text-foreground/70">
                {p.priceMonthly === 0 ? 'Free' : `${p.currency} ${p.priceMonthly.toLocaleString()}/mo`}
              </td>
              <td className="px-3.5 py-3 text-foreground/70">{p.maxDevices < 0 ? 'Unlimited' : p.maxDevices}</td>
              <td className="px-3.5 py-3 text-foreground/70">{p.retentionDays === 0 ? 'Unlimited' : `${p.retentionDays}d`}</td>
              <td className="px-3.5 py-3 text-foreground/70">{p.subscriptionCount}</td>
              <td className="px-3.5 py-3 text-foreground/70">{p.licenseKeyCount}</td>
              <td className="px-3.5 py-3">
                {p.isActive ? <StatusPill label="Active" tone="ok" /> : <StatusPill label="Inactive" tone="neutral" />}
              </td>
              <td className="px-3.5 py-3">
                <div className="flex items-center justify-end gap-1">
                  <button
                    onClick={() => openEdit(p)}
                    disabled={actionId === p.id}
                    className="rounded p-1.5 text-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={`Edit ${p.name}`}
                    title="Edit package"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => toggleActive(p)}
                    disabled={actionId === p.id}
                    className="tech-font rounded-full border border-border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-foreground/60 transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    {actionId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : p.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                  <button
                    onClick={() => handleDelete(p)}
                    disabled={actionId === p.id}
                    className="rounded p-1.5 text-rose-500/70 transition-colors hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-50"
                    aria-label={`Delete ${p.name}`}
                    title="Delete (only unreferenced packages)"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
      )}

      {/* Create / Edit dialog — reuses the same API contract as the legacy
          standalone page (which was removed as an orphan duplicate). */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Package' : 'Create Package'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label>Name *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Pro" />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Description</Label>
              <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="For growing teams" />
            </div>
            <div className="space-y-2">
              <Label>Monthly price</Label>
              <Input type="number" min="0" value={form.priceMonthly} onChange={(e) => setForm({ ...form, priceMonthly: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Yearly price (optional)</Label>
              <Input type="number" min="0" value={form.priceYearly} onChange={(e) => setForm({ ...form, priceYearly: e.target.value })} placeholder="Blank = none" />
            </div>
            <div className="space-y-2">
              <Label>Currency</Label>
              <Input value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Max devices (0/-1 = unlimited)</Label>
              <Input type="number" step="1" value={form.maxDevices} onChange={(e) => setForm({ ...form, maxDevices: e.target.value })} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Retention days (0 = unlimited)</Label>
              <Input type="number" step="1" min="0" value={form.retentionDays} onChange={(e) => setForm({ ...form, retentionDays: e.target.value })} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Features (comma-separated)</Label>
              <Input value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} placeholder="screenshots, ai, live_monitoring" />
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={form.isSelfHosted}
                onChange={(e) => setForm({ ...form, isSelfHosted: e.target.checked })}
              />
              Self-hosted plan (license-issuable)
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !form.name.trim()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
