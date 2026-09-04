'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCurrentUser } from '@/hooks/use-current-user';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ShieldCheck, Plus, Pencil, Trash2, Loader2 } from 'lucide-react';

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
  features: string[];
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

export default function AdminPackagesPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useCurrentUser();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<PackageRow | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  const query = useQuery({
    queryKey: ['super-admin-packages'],
    queryFn: async () => {
      const res = await fetch('/api/super-admin/packages?includeInactive=true', { credentials: 'same-origin' });
      if (res.status === 403) throw new Error('super_admin');
      if (!res.ok) throw new Error('Failed to load packages');
      return res.json() as Promise<{ data: PackageRow[] }>;
    },
    enabled: !!user,
    staleTime: 30 * 1000,
  });

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background p-8">
        <Skeleton className="h-10 w-56 mb-6" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (!user) return null;
  if (user.role !== 'super_admin') {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <div className="text-center max-w-sm">
          <ShieldCheck className="mx-auto h-10 w-10 text-destructive" />
          <h1 className="mt-4 text-2xl font-bold">Super Admin Only</h1>
          <p className="mt-2 text-muted-foreground">Package management requires super admin access.</p>
        </div>
      </div>
    );
  }

  const packages = query.data?.data ?? [];

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
      features: (pkg.features ?? []).join(', '),
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
      queryClient.invalidateQueries({ queryKey: ['super-admin-packages'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(pkg: PackageRow) {
    setActionId(pkg.id);
    try {
      const res = await fetch(`/api/super-admin/packages/${pkg.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ isActive: !pkg.isActive }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to update package');
        return;
      }
      toast.success(pkg.isActive ? 'Package deactivated' : 'Package activated');
      queryClient.invalidateQueries({ queryKey: ['super-admin-packages'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setActionId(null);
    }
  }

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
      queryClient.invalidateQueries({ queryKey: ['super-admin-packages'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setActionId(null);
    }
  }

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Packages</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Database-driven package catalog. Pricing and checkout read this catalog — nothing is hardcoded.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-2" />
          Create Package
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All packages ({packages.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <Skeleton className="h-48 w-full rounded-xl" />
          ) : query.isError ? (
            <p className="text-sm text-destructive">Failed to load packages.</p>
          ) : packages.length === 0 ? (
            <p className="text-sm text-muted-foreground">No packages yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Monthly</TableHead>
                    <TableHead>Devices</TableHead>
                    <TableHead>Retention</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-center">Subs</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {packages.map((pkg) => (
                    <TableRow key={pkg.id} className={!pkg.isActive ? 'opacity-60' : ''}>
                      <TableCell>
                        <p className="font-medium text-sm">{pkg.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {pkg.currency}
                          {pkg.isSelfHosted ? ' · self-hosted' : ''}
                        </p>
                      </TableCell>
                      <TableCell className="text-sm">{pkg.priceMonthly}</TableCell>
                      <TableCell className="text-sm">
                        {pkg.maxDevices === 0 || pkg.maxDevices === -1 ? 'Unlimited' : pkg.maxDevices}
                      </TableCell>
                      <TableCell className="text-sm">
                        {pkg.retentionDays === 0 ? 'Unlimited' : `${pkg.retentionDays}d`}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{pkg.isActive ? 'Active' : 'Inactive'}</Badge>
                      </TableCell>
                      <TableCell className="text-center text-sm">{pkg.subscriptionCount}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(pkg)} disabled={actionId === pkg.id}>
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => toggleActive(pkg)} disabled={actionId === pkg.id}>
                            {actionId === pkg.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : pkg.isActive ? 'Deactivate' : 'Activate'}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => handleDelete(pkg)} disabled={actionId === pkg.id}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
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
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : editing ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
