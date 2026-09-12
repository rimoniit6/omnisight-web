'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Pencil, Plus, Trash2, Calculator } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ─── Unified Packages & Pricing ──────────────────────────────────────────────
// Single Control Center surface with three tabs:
//   • Plans — plan catalog CRUD (name, devices, retention, self-hosted flag)
//   • Pricing — per (plan × deployment mode × period) base price + device terms
//   • Offers — discount/fixed/free-trial offers with validity + scoping
// V1 pricing rows (PlanPricing) are the commercial source of truth.
// The legacy Plan.priceMonthly fallback is deprecated; unconfigured plans
// show "Contact us" on the landing page.

// ── Plan types ───────────────────────────────────────────────────────────────
interface PlanRow {
  id: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number | null;
  currency: string;
  maxDevices: number;
  retentionDays: number;
  isActive: boolean;
  subscriptionCount: number;
}

// NOTE: the `isSelfHosted` plan flag was removed with the LicenseKey /
// self-hosted architecture. Plans are V1 MANAGED / CUSTOMER_DB plans only.
const EMPTY_PLAN_FORM = {
  name: '',
  description: '',
  currency: 'BDT',
  maxDevices: '5',
  retentionDays: '90',
  features: '',
};

// ── Pricing types ────────────────────────────────────────────────────────────
interface PricingRow {
  id: string;
  planId: string;
  plan: { id: string; name: string; isActive: boolean };
  deploymentMode: 'MANAGED' | 'CUSTOMER_DB';
  billingPeriod: 'MONTHLY' | 'YEARLY';
  basePrice: number;
  currency: string;
  includedDevices: number;
  additionalDevicePrice: number;
  isActive: boolean;
}

const EMPTY_PRICING_FORM = {
  planId: '',
  deploymentMode: 'MANAGED',
  billingPeriod: 'MONTHLY',
  basePrice: '0',
  currency: 'BDT',
  includedDevices: '5',
  additionalDevicePrice: '0',
};

// ── Offer types ──────────────────────────────────────────────────────────────
interface OfferRow {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  discountType: 'PERCENTAGE' | 'FIXED';
  discountValue: number;
  isFree: boolean;
  freeTrialDays: number | null;
  currency: string;
  startsAt: string | null;
  endsAt: string | null;
  planId: string | null;
  plan?: { id: string; name: string } | null;
  deploymentMode: string | null;
  billingPeriod: string | null;
}

const EMPTY_OFFER_FORM = {
  name: '',
  description: '',
  discountType: 'PERCENTAGE',
  discountValue: '10',
  isFree: false,
  freeTrialDays: '',
  currency: 'BDT',
  startsAt: '',
  endsAt: '',
  planId: 'ALL',
  deploymentMode: 'ALL',
  billingPeriod: 'ALL',
};

// ═════════════════════════════════════════════════════════════════════════════
// Component
// ═════════════════════════════════════════════════════════════════════════════
type Tab = 'plans' | 'pricing' | 'offers';

export function SuperAdminPackagesPricingPage() {
  const [tab, setTab] = useState<Tab>('plans');
  const queryClient = useQueryClient();

  // ── Plan state ───────────────────────────────────────────────────────────
  const [planIncludeInactive, setPlanIncludeInactive] = useState(true);
  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [planEditing, setPlanEditing] = useState<PlanRow | null>(null);
  const [planForm, setPlanForm] = useState({ ...EMPTY_PLAN_FORM });
  const [planSaving, setPlanSaving] = useState(false);
  const [planActionId, setPlanActionId] = useState<string | null>(null);

  // ── Pricing state ────────────────────────────────────────────────────────
  const [pricingDialog, setPricingDialog] = useState(false);
  const [pricingEditing, setPricingEditing] = useState<PricingRow | null>(null);
  const [pricingForm, setPricingForm] = useState({ ...EMPTY_PRICING_FORM });
  const [savingPricing, setSavingPricing] = useState(false);
  const [pricingActionId, setPricingActionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  // ── Offer state ──────────────────────────────────────────────────────────
  const [offerDialog, setOfferDialog] = useState(false);
  const [offerEditing, setOfferEditing] = useState<OfferRow | null>(null);
  const [offerForm, setOfferForm] = useState({ ...EMPTY_OFFER_FORM });
  const [savingOffer, setSavingOffer] = useState(false);
  const [offerActionId, setOfferActionId] = useState<string | null>(null);

  // ── Queries ──────────────────────────────────────────────────────────────
  const plansQ = useQuery<{ plans: PlanRow[] }>({
    queryKey: ['pricing-plans'],
    queryFn: async () => {
      const res = await fetch('/api/plans', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('plans');
      return res.json();
    },
  });

  const packagesQ = useQuery<{ data: PlanRow[] }>({
    queryKey: ['sa-packages', planIncludeInactive],
    queryFn: async () => {
      const res = await fetch(`/api/super-admin/packages?includeInactive=${planIncludeInactive}&pageSize=200`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`packages ${res.status}`);
      return res.json();
    },
  });

  const pricingQ = useQuery<{ data: PricingRow[] }>({
    queryKey: ['sa-pricing'],
    queryFn: async () => {
      const res = await fetch('/api/super-admin/pricing', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('pricing');
      return res.json();
    },
  });

  const offersQ = useQuery<{ data: OfferRow[] }>({
    queryKey: ['sa-offers'],
    queryFn: async () => {
      const res = await fetch('/api/super-admin/offers', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('offers');
      return res.json();
    },
  });

  const invalidatePricing = () => {
    queryClient.invalidateQueries({ queryKey: ['sa-pricing'] });
    queryClient.invalidateQueries({ queryKey: ['sa-offers'] });
    queryClient.invalidateQueries({ queryKey: ['pricing-plans'] });
    queryClient.invalidateQueries({ queryKey: ['sa-packages'] });
  };

  // ═════════════════════════════════════════════════════════════════════════
  // PLANS TAB
  // ═════════════════════════════════════════════════════════════════════════
  function openPlanCreate() {
    setPlanEditing(null);
    setPlanForm({ ...EMPTY_PLAN_FORM });
    setPlanDialogOpen(true);
  }

  function openPlanEdit(pkg: PlanRow) {
    setPlanEditing(pkg);
    setPlanForm({
      name: pkg.name,
      description: pkg.description ?? '',
      currency: pkg.currency,
      maxDevices: String(pkg.maxDevices),
      retentionDays: String(pkg.retentionDays),
      features: '',
    });
    setPlanDialogOpen(true);
  }

  async function handlePlanSave() {
    setPlanSaving(true);
    try {
      const payload = {
        name: planForm.name.trim(),
        description: planForm.description.trim() || null,
        currency: planForm.currency.trim() || 'BDT',
        maxDevices: Number(planForm.maxDevices),
        retentionDays: Number(planForm.retentionDays),
        features: planForm.features.split(',').map((f) => f.trim()).filter(Boolean),
      };
      const res = await fetch(
        planEditing ? `/api/super-admin/packages/${planEditing.id}` : '/api/super-admin/packages',
        {
          method: planEditing ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload),
        },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to save plan');
        return;
      }
      toast.success(planEditing ? 'Plan updated' : 'Plan created');
      setPlanDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: ['sa-packages'] });
      queryClient.invalidateQueries({ queryKey: ['pricing-plans'] });
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setPlanSaving(false);
    }
  }

  const togglePlanActive = async (p: PlanRow) => {
    setPlanActionId(p.id);
    try {
      const res = await fetch(`/api/super-admin/packages/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ isActive: !p.isActive }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to update plan');
        return;
      }
      invalidatePricing();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setPlanActionId(null);
    }
  };

  async function handlePlanDelete(pkg: PlanRow) {
    if (!window.confirm(`Delete plan "${pkg.name}"? Only unreferenced plans can be deleted.`)) return;
    setPlanActionId(pkg.id);
    try {
      const res = await fetch(`/api/super-admin/packages/${pkg.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to delete plan');
        return;
      }
      toast.success('Plan deleted');
      invalidatePricing();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setPlanActionId(null);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PRICING TAB
  // ═════════════════════════════════════════════════════════════════════════
  async function savePricing() {
    setSavingPricing(true);
    try {
      const payload = {
        planId: pricingForm.planId,
        deploymentMode: pricingForm.deploymentMode,
        billingPeriod: pricingForm.billingPeriod,
        basePrice: Number(pricingForm.basePrice),
        currency: pricingForm.currency,
        includedDevices: Number(pricingForm.includedDevices),
        additionalDevicePrice: Number(pricingForm.additionalDevicePrice),
      };
      const url = pricingEditing
        ? `/api/super-admin/pricing/${pricingEditing.id}`
        : '/api/super-admin/pricing';
      const method = pricingEditing ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to save pricing');
        return;
      }
      toast.success(pricingEditing ? 'Pricing updated' : 'Pricing saved');
      setPricingDialog(false);
      setPricingEditing(null);
      invalidatePricing();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSavingPricing(false);
    }
  }

  async function togglePricingActive(row: PricingRow) {
    try {
      const res = await fetch(`/api/super-admin/pricing/${row.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ isActive: !row.isActive }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        toast.error(json.error ?? 'Failed to update pricing');
        return;
      }
      invalidatePricing();
    } catch {
      toast.error('Network error');
    }
  }

  function openPricingEdit(row: PricingRow) {
    setPricingEditing(row);
    setPricingForm({
      planId: row.planId,
      deploymentMode: row.deploymentMode,
      billingPeriod: row.billingPeriod,
      basePrice: String(row.basePrice),
      currency: row.currency,
      includedDevices: String(row.includedDevices),
      additionalDevicePrice: String(row.additionalDevicePrice),
    });
    setPreview(null);
    setPricingDialog(true);
  }

  async function handlePricingDelete(row: PricingRow) {
    if (!window.confirm(`Delete pricing for "${row.plan.name}" (${row.deploymentMode} ${row.billingPeriod})? This cannot be undone.`)) return;
    setPricingActionId(row.id);
    try {
      const res = await fetch(`/api/super-admin/pricing/${row.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to delete pricing');
        return;
      }
      toast.success('Pricing deleted');
      invalidatePricing();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setPricingActionId(null);
    }
  }

  async function runPreview() {
    if (!pricingForm.planId) {
      toast.error('Select a plan first');
      return;
    }
    try {
      const res = await fetch('/api/pricing/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          planId: pricingForm.planId,
          deploymentMode: pricingForm.deploymentMode,
          billingPeriod: pricingForm.billingPeriod,
          deviceQuantity: Number(pricingForm.includedDevices) + 3,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPreview(`Error: ${json.error ?? 'failed'}`);
        return;
      }
      const b = json.breakdown;
      setPreview(
        `${b.currency} ${b.finalPrice.toLocaleString()} / ${b.billingPeriod === 'YEARLY' ? 'yr' : 'mo'} — ${b.pricingSource === 'PRICING_CONFIG' ? 'saved config' : 'legacy plan fallback'}, ${b.includedDevices} included + ${b.additionalDevicePrice}/extra`
      );
    } catch {
      setPreview('Preview failed');
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // OFFERS TAB
  // ═════════════════════════════════════════════════════════════════════════
  async function saveOffer() {
    setSavingOffer(true);
    try {
      const payload = {
        name: offerForm.name,
        description: offerForm.description || null,
        discountType: offerForm.discountType,
        discountValue: Number(offerForm.discountValue),
        isFree: offerForm.isFree,
        freeTrialDays: offerForm.freeTrialDays ? Number(offerForm.freeTrialDays) : null,
        currency: offerForm.currency,
        startsAt: offerForm.startsAt || null,
        endsAt: offerForm.endsAt || null,
        planId: offerForm.planId === 'ALL' ? null : offerForm.planId,
        deploymentMode: offerForm.deploymentMode === 'ALL' ? null : offerForm.deploymentMode,
        billingPeriod: offerForm.billingPeriod === 'ALL' ? null : offerForm.billingPeriod,
      };
      const url = offerEditing
        ? `/api/super-admin/offers/${offerEditing.id}`
        : '/api/super-admin/offers';
      const method = offerEditing ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to save offer');
        return;
      }
      toast.success(offerEditing ? 'Offer updated' : 'Offer created');
      setOfferDialog(false);
      setOfferEditing(null);
      setOfferForm({ ...EMPTY_OFFER_FORM });
      invalidatePricing();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSavingOffer(false);
    }
  }

  async function toggleOffer(offer: OfferRow) {
    try {
      const res = await fetch(`/api/super-admin/offers/${offer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ isActive: !offer.isActive }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        toast.error(json.error ?? 'Failed to update offer');
        return;
      }
      invalidatePricing();
    } catch {
      toast.error('Network error');
    }
  }

  function openOfferEdit(offer: OfferRow) {
    setOfferEditing(offer);
    setOfferForm({
      name: offer.name,
      description: offer.description ?? '',
      discountType: offer.discountType,
      discountValue: String(offer.discountValue),
      isFree: offer.isFree,
      freeTrialDays: offer.freeTrialDays != null ? String(offer.freeTrialDays) : '',
      currency: offer.currency,
      startsAt: offer.startsAt ? offer.startsAt.slice(0, 10) : '',
      endsAt: offer.endsAt ? offer.endsAt.slice(0, 10) : '',
      planId: offer.planId ?? 'ALL',
      deploymentMode: offer.deploymentMode ?? 'ALL',
      billingPeriod: offer.billingPeriod ?? 'ALL',
    });
    setOfferDialog(true);
  }

  async function handleOfferDelete(offer: OfferRow) {
    if (!window.confirm(`Delete offer "${offer.name}"? This cannot be undone.`)) return;
    setOfferActionId(offer.id);
    try {
      const res = await fetch(`/api/super-admin/offers/${offer.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to delete offer');
        return;
      }
      toast.success('Offer deleted');
      invalidatePricing();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setOfferActionId(null);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════════════════════════
  const tabs: { key: Tab; label: string }[] = [
    { key: 'plans', label: 'Plans' },
    { key: 'pricing', label: 'Pricing' },
    { key: 'offers', label: 'Offers' },
  ];

  return (
    <PageTransition>
      <PageHeader
        eyebrow="Control Center"
        title="Packages & Pricing"
        description="Plan catalog, pricing configuration, and promotional offers. V1 pricing rows (per plan, per deployment mode, per billing period) are the commercial source of truth."
      />

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div className="mb-4 flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`tech-font rounded-full border px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] transition-colors ${tab === t.key ? 'border-cyan-300/60 bg-cyan-300/10 text-cyan-200' : 'border-border text-foreground/60 hover:bg-muted'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* PLANS TAB                                                         */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'plans' && (
        <>
          <div className="mb-4 flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-[12.5px] text-foreground/55">
              <input
                type="checkbox"
                checked={planIncludeInactive}
                onChange={(e) => setPlanIncludeInactive(e.target.checked)}
                className="h-3.5 w-3.5 accent-cyan-300"
              />
              Include inactive
            </label>
            <Button size="sm" onClick={openPlanCreate}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Create Plan
            </Button>
          </div>

          {packagesQ.isLoading && <LoadingBlock label="Loading plans…" />}
          {packagesQ.isError && <ErrorState onRetry={() => packagesQ.refetch()} />}
          {packagesQ.data && (
            <DataTable
              headers={['Plan', 'Devices', 'Retention', 'Subs', 'Status', '']}
              loading={packagesQ.isLoading}
              empty={<EmptyState title="No plans found." />}
            >
              {packagesQ.data.data.map((p) => (
                <tr key={p.id} className="transition-colors hover:bg-muted/40">
                  <td className="px-3.5 py-3">
                    <p className="font-medium text-foreground">{p.name}</p>
                    <p className="text-[11px] text-foreground/40">
                      {p.description || '—'}
                    </p>
                  </td>
                  <td className="px-3.5 py-3 text-foreground/70">{p.maxDevices < 0 ? 'Unlimited' : p.maxDevices}</td>
                  <td className="px-3.5 py-3 text-foreground/70">{p.retentionDays === 0 ? 'Unlimited' : `${p.retentionDays}d`}</td>
                  <td className="px-3.5 py-3 text-foreground/70">{p.subscriptionCount}</td>
                  <td className="px-3.5 py-3">
                    {p.isActive ? <StatusPill label="Active" tone="ok" /> : <StatusPill label="Inactive" tone="neutral" />}
                  </td>
                  <td className="px-3.5 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openPlanEdit(p)}
                        disabled={planActionId === p.id}
                        className="rounded p-1.5 text-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={`Edit ${p.name}`}
                        title="Edit plan"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => togglePlanActive(p)}
                        disabled={planActionId === p.id}
                        className="tech-font rounded-full border border-border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-foreground/60 transition-colors hover:bg-muted disabled:opacity-50"
                      >
                        {planActionId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : p.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                      <button
                        onClick={() => handlePlanDelete(p)}
                        disabled={planActionId === p.id}
                        className="rounded p-1.5 text-rose-500/70 transition-colors hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-50"
                        aria-label={`Delete ${p.name}`}
                        title="Delete (only unreferenced plans)"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}

          {/* Plan Create / Edit dialog */}
          <Dialog open={planDialogOpen} onOpenChange={setPlanDialogOpen}>
            <DialogContent className="sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>{planEditing ? 'Edit Plan' : 'Create Plan'}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 py-2 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label>Name *</Label>
                  <Input value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })} placeholder="Pro" />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Description</Label>
                  <Input value={planForm.description} onChange={(e) => setPlanForm({ ...planForm, description: e.target.value })} placeholder="For growing teams" />
                </div>
                <div className="space-y-2">
                  <Label>Max devices (0/-1 = unlimited)</Label>
                  <Input type="number" step="1" value={planForm.maxDevices} onChange={(e) => setPlanForm({ ...planForm, maxDevices: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Retention days (0 = unlimited)</Label>
                  <Input type="number" step="1" min="0" value={planForm.retentionDays} onChange={(e) => setPlanForm({ ...planForm, retentionDays: e.target.value })} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Features (comma-separated)</Label>
                  <Input value={planForm.features} onChange={(e) => setPlanForm({ ...planForm, features: e.target.value })} placeholder="screenshots, ai, live_monitoring" />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPlanDialogOpen(false)} disabled={planSaving}>
                  Cancel
                </Button>
                <Button onClick={handlePlanSave} disabled={planSaving || !planForm.name.trim()}>
                  {planSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : planEditing ? 'Save' : 'Create'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* PRICING TAB                                                       */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'pricing' && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-[12.5px] text-foreground/55">
              Both deployment modes use device-based entitlement: included devices + per-device charge for extras.
            </p>
            <Button size="sm" onClick={() => { setPricingEditing(null); setPricingForm({ ...EMPTY_PRICING_FORM }); setPreview(null); setPricingDialog(true); }}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Configure Price
            </Button>
          </div>

          {pricingQ.isLoading && <LoadingBlock label="Loading pricing…" />}
          {pricingQ.isError && <ErrorState onRetry={() => pricingQ.refetch()} />}
          {pricingQ.data && (
            <DataTable
              headers={['Plan', 'Mode', 'Period', 'Base Price', 'Devices', 'Status', '']}
              empty={<EmptyState title="No pricing configured yet." />}
            >
              {pricingQ.data.data.map((row) => (
                <tr key={row.id} className="transition-colors hover:bg-muted/40">
                  <td className="px-3.5 py-3 font-medium text-foreground">{row.plan.name}</td>
                  <td className="px-3.5 py-3">
                    <StatusPill label={row.deploymentMode === 'MANAGED' ? 'Managed' : 'Customer DB'} tone={row.deploymentMode === 'MANAGED' ? 'info' : 'neutral'} />
                  </td>
                  <td className="px-3.5 py-3 text-foreground/70">{row.billingPeriod}</td>
                  <td className="px-3.5 py-3 text-foreground/70">{row.currency} {row.basePrice.toLocaleString()}</td>
                  <td className="px-3.5 py-3 text-foreground/70">
                    {`${row.includedDevices} + ${row.currency} ${row.additionalDevicePrice}/extra`}
                  </td>
                  <td className="px-3.5 py-3">
                    {row.isActive ? <StatusPill label="Active" tone="ok" /> : <StatusPill label="Inactive" tone="neutral" />}
                  </td>
                  <td className="px-3.5 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openPricingEdit(row)}
                        className="rounded p-1.5 text-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
                        title="Edit pricing"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => togglePricingActive(row)}
                        disabled={pricingActionId === row.id}
                        className="tech-font rounded-full border border-border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-foreground/60 transition-colors hover:bg-muted disabled:opacity-50"
                      >
                        {pricingActionId === row.id ? <Loader2 className="h-3 w-3 animate-spin" /> : row.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                      <button
                        onClick={() => handlePricingDelete(row)}
                        disabled={pricingActionId === row.id}
                        className="rounded p-1.5 text-rose-500/70 transition-colors hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-50"
                        title="Delete pricing"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════════ */}
      {/* OFFERS TAB                                                        */}
      {/* ═══════════════════════════════════════════════════════════════════ */}
      {tab === 'offers' && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-[12.5px] text-foreground/55">
              At most one offer applies per selection — the largest effective discount wins deterministically. Final prices never go negative.
            </p>
            <Button size="sm" onClick={() => { setOfferEditing(null); setOfferForm({ ...EMPTY_OFFER_FORM }); setOfferDialog(true); }}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Create Offer
            </Button>
          </div>

          {offersQ.isLoading && <LoadingBlock label="Loading offers…" />}
          {offersQ.isError && <ErrorState onRetry={() => offersQ.refetch()} />}
          {offersQ.data && (
            <DataTable
              headers={['Offer', 'Discount', 'Scope', 'Validity', 'Status', '']}
              empty={<EmptyState title="No offers configured." />}
            >
              {offersQ.data.data.map((offer) => (
                <tr key={offer.id} className="transition-colors hover:bg-muted/40">
                  <td className="px-3.5 py-3">
                    <p className="font-medium text-foreground">{offer.name}</p>
                    <p className="text-[11px] text-foreground/40">{offer.description || '—'}</p>
                  </td>
                  <td className="px-3.5 py-3 text-foreground/70">
                    {offer.isFree ? 'FREE' : offer.discountType === 'PERCENTAGE' ? `${offer.discountValue}%` : `${offer.currency} ${offer.discountValue.toLocaleString()}`}
                  </td>
                  <td className="px-3.5 py-3 text-[11.5px] text-foreground/60">
                    {[offer.plan?.name ?? 'All plans', offer.deploymentMode ?? 'All modes', offer.billingPeriod ?? 'Both periods'].join(' · ')}
                  </td>
                  <td className="px-3.5 py-3 text-[11.5px] text-foreground/60">
                    {offer.startsAt ? new Date(offer.startsAt).toLocaleDateString() : '—'} → {offer.endsAt ? new Date(offer.endsAt).toLocaleDateString() : '∞'}
                  </td>
                  <td className="px-3.5 py-3">
                    {offer.isActive ? <StatusPill label="Active" tone="ok" /> : <StatusPill label="Inactive" tone="neutral" />}
                  </td>
                  <td className="px-3.5 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => openOfferEdit(offer)}
                        className="rounded p-1.5 text-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
                        title="Edit offer"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => toggleOffer(offer)}
                        disabled={offerActionId === offer.id}
                        className="tech-font rounded-full border border-border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-foreground/60 transition-colors hover:bg-muted disabled:opacity-50"
                      >
                        {offerActionId === offer.id ? <Loader2 className="h-3 w-3 animate-spin" /> : offer.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                      <button
                        onClick={() => handleOfferDelete(offer)}
                        disabled={offerActionId === offer.id}
                        className="rounded p-1.5 text-rose-500/70 transition-colors hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-50"
                        title="Delete offer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </>
      )}

      {/* ── Pricing dialog ─────────────────────────────────────────────── */}
      <Dialog open={pricingDialog} onOpenChange={setPricingDialog}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{pricingEditing ? 'Edit Price' : 'Configure Price'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label>Plan *</Label>
              <Select value={pricingForm.planId || undefined} onValueChange={(v) => setPricingForm({ ...pricingForm, planId: v })}>
                <SelectTrigger><SelectValue placeholder="Select a plan" /></SelectTrigger>
                <SelectContent>
                  {(plansQ.data?.plans ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Deployment Mode *</Label>
              <Select value={pricingForm.deploymentMode} onValueChange={(v) => setPricingForm({ ...pricingForm, deploymentMode: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MANAGED">OmniSight Managed</SelectItem>
                  <SelectItem value="CUSTOMER_DB">Customer Database</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Billing Period *</Label>
              <Select value={pricingForm.billingPeriod} onValueChange={(v) => setPricingForm({ ...pricingForm, billingPeriod: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MONTHLY">Monthly</SelectItem>
                  <SelectItem value="YEARLY">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Base Price *</Label>
              <Input type="number" min="0" value={pricingForm.basePrice} onChange={(e) => setPricingForm({ ...pricingForm, basePrice: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Currency</Label>
              <Input value={pricingForm.currency} onChange={(e) => setPricingForm({ ...pricingForm, currency: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Included Devices *</Label>
              <Input type="number" min="0" step="1" value={pricingForm.includedDevices} onChange={(e) => setPricingForm({ ...pricingForm, includedDevices: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Additional Device Price</Label>
              <Input type="number" min="0" value={pricingForm.additionalDevicePrice} onChange={(e) => setPricingForm({ ...pricingForm, additionalDevicePrice: e.target.value })} />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              Devices beyond the included count are charged at the additional-device price. This applies to both OmniSight Managed and Customer Database deployments.
            </p>
            <div className="sm:col-span-2 rounded-lg border border-dashed border-border bg-muted/30 p-3">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Calculator className="h-3.5 w-3.5" /> Live preview (server resolver)
                </span>
                <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={runPreview}>
                  Preview +3 devices
                </Button>
              </div>
              {preview && <p className="mt-2 text-xs text-foreground">{preview}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPricingDialog(false)} disabled={savingPricing}>Cancel</Button>
            <Button onClick={savePricing} disabled={savingPricing || !pricingForm.planId}>
              {savingPricing ? <Loader2 className="h-4 w-4 animate-spin" /> : pricingEditing ? 'Update Price' : 'Save Price'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Offer dialog ───────────────────────────────────────────────── */}
      <Dialog open={offerDialog} onOpenChange={setOfferDialog}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{offerEditing ? 'Edit Offer' : 'Create Offer'}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label>Name *</Label>
              <Input value={offerForm.name} onChange={(e) => setOfferForm({ ...offerForm, name: e.target.value })} placeholder="Launch discount" />
            </div>
            <div className="space-y-2">
              <Label>Discount Type *</Label>
              <Select value={offerForm.discountType} onValueChange={(v) => setOfferForm({ ...offerForm, discountType: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PERCENTAGE">Percentage (%)</SelectItem>
                  <SelectItem value="FIXED">Fixed amount</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Discount Value *</Label>
              <Input type="number" min="0" value={offerForm.discountValue} onChange={(e) => setOfferForm({ ...offerForm, discountValue: e.target.value })} disabled={offerForm.isFree} />
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={offerForm.isFree} onChange={(e) => setOfferForm({ ...offerForm, isFree: e.target.checked })} />
              Free offer / free trial (final price 0)
            </label>
            <div className="space-y-2">
              <Label>Free trial days (optional)</Label>
              <Input type="number" min="0" step="1" value={offerForm.freeTrialDays} onChange={(e) => setOfferForm({ ...offerForm, freeTrialDays: e.target.value })} disabled={!offerForm.isFree} />
            </div>
            <div className="space-y-2 sm:col-span-2 grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Starts at</Label>
                <Input type="date" value={offerForm.startsAt} onChange={(e) => setOfferForm({ ...offerForm, startsAt: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Ends at</Label>
                <Input type="date" value={offerForm.endsAt} onChange={(e) => setOfferForm({ ...offerForm, endsAt: e.target.value })} />
              </div>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label>Plan scope</Label>
              <Select value={offerForm.planId} onValueChange={(v) => setOfferForm({ ...offerForm, planId: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All plans</SelectItem>
                  {(plansQ.data?.plans ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Deployment scope</Label>
              <Select value={offerForm.deploymentMode} onValueChange={(v) => setOfferForm({ ...offerForm, deploymentMode: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All modes</SelectItem>
                  <SelectItem value="MANAGED">OmniSight Managed</SelectItem>
                  <SelectItem value="CUSTOMER_DB">Customer Database</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Period scope</Label>
              <Select value={offerForm.billingPeriod} onValueChange={(v) => setOfferForm({ ...offerForm, billingPeriod: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">Both periods</SelectItem>
                  <SelectItem value="MONTHLY">Monthly</SelectItem>
                  <SelectItem value="YEARLY">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOfferDialog(false)} disabled={savingOffer}>Cancel</Button>
            <Button onClick={saveOffer} disabled={savingOffer || !offerForm.name.trim()}>
              {savingOffer ? <Loader2 className="h-4 w-4 animate-spin" /> : offerEditing ? 'Update Offer' : 'Create Offer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}

// Re-export Purchase Requests from the same file (unchanged)
export { SuperAdminPurchaseRequestsPage } from './sa-pricing-pages';
