'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Calculator } from 'lucide-react';
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

// ─── Super Admin Commercial Configuration (V1) ─────────────────────────────
// One Control Center page with two tabs:
//   • Pricing — per (plan × deployment mode × period) base price + Managed
//     device entitlement terms. CUSTOMER_DB rows show "Unlimited devices"
//     and never expose per-device fields.
//   • Offers — discount/fixed/free-trial offers with validity + scoping.
// All values are database-driven; nothing is hardcoded. The Managed price
// preview in the dialog runs the SAME server resolver (/api/pricing/preview)
// that the landing page and purchase flow use — no duplicated formula.

interface PlanRow {
  id: string;
  name: string;
  isActive: boolean;
}

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

const EMPTY_PRICING = { planId: '', deploymentMode: 'MANAGED', billingPeriod: 'MONTHLY', basePrice: '0', currency: 'BDT', includedDevices: '5', additionalDevicePrice: '0' };
const EMPTY_OFFER = { name: '', description: '', discountType: 'PERCENTAGE', discountValue: '10', isFree: false, freeTrialDays: '', currency: 'BDT', startsAt: '', endsAt: '', planId: 'ALL', deploymentMode: 'ALL', billingPeriod: 'ALL' };

export function SuperAdminPricingPage() {
  const [tab, setTab] = useState<'pricing' | 'offers'>('pricing');
  const [pricingDialog, setPricingDialog] = useState(false);
  const [pricingForm, setPricingForm] = useState({ ...EMPTY_PRICING });
  const [savingPricing, setSavingPricing] = useState(false);
  const [offerDialog, setOfferDialog] = useState(false);
  const [offerForm, setOfferForm] = useState({ ...EMPTY_OFFER });
  const [savingOffer, setSavingOffer] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const plansQ = useQuery<{ plans: PlanRow[] }>({
    queryKey: ['pricing-plans'],
    queryFn: async () => {
      const res = await fetch('/api/plans', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('plans');
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

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['sa-pricing'] });
    queryClient.invalidateQueries({ queryKey: ['sa-offers'] });
  };

  // ── Pricing ──────────────────────────────────────────────────────────────
  async function savePricing() {
    setSavingPricing(true);
    try {
      const payload = {
        planId: pricingForm.planId,
        deploymentMode: pricingForm.deploymentMode,
        billingPeriod: pricingForm.billingPeriod,
        basePrice: Number(pricingForm.basePrice),
        currency: pricingForm.currency,
        includedDevices: pricingForm.deploymentMode === 'MANAGED' ? Number(pricingForm.includedDevices) : null,
        additionalDevicePrice: pricingForm.deploymentMode === 'MANAGED' ? Number(pricingForm.additionalDevicePrice) : 0,
      };
      const res = await fetch('/api/super-admin/pricing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to save pricing');
        return;
      }
      toast.success('Pricing saved');
      setPricingDialog(false);
      invalidate();
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
      invalidate();
    } catch {
      toast.error('Network error');
    }
  }

  // ── Offers ───────────────────────────────────────────────────────────────
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
      const res = await fetch('/api/super-admin/offers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to save offer');
        return;
      }
      toast.success('Offer created');
      setOfferDialog(false);
      setOfferForm({ ...EMPTY_OFFER });
      invalidate();
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
      invalidate();
    } catch {
      toast.error('Network error');
    }
  }

  // Live price preview — server-resolved, same resolver as everywhere else.
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
          deviceQuantity: pricingForm.deploymentMode === 'MANAGED' ? Number(pricingForm.includedDevices) + 3 : undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPreview(`Error: ${json.error ?? 'failed'}`);
        return;
      }
      const b = json.breakdown;
      // Preview uses the CURRENTLY SAVED pricing row (server-side truth) —
      // unsaved form edits are reflected after Save.
      setPreview(
        `${b.currency} ${b.finalPrice.toLocaleString()} / ${b.billingPeriod === 'YEARLY' ? 'yr' : 'mo'} — ${b.pricingSource === 'PRICING_CONFIG' ? 'saved config' : 'legacy plan fallback'}${b.unlimitedDevices ? ', unlimited devices' : `, ${b.includedDevices} included + ${b.additionalDevicePrice}/extra`}`
      );
    } catch {
      setPreview('Preview failed');
    }
  }

  return (
    <PageTransition>
      <PageHeader
        eyebrow="Control Center"
        title="Pricing & Offers"
        description="Commercial configuration for the V1 catalog: per-mode, per-period pricing and promotional offers. The landing page and purchase flow read these values live."
      />

      <div className="mb-4 flex gap-2">
        <button
          onClick={() => setTab('pricing')}
          className={`tech-font rounded-full border px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] transition-colors ${tab === 'pricing' ? 'border-cyan-300/60 bg-cyan-300/10 text-cyan-200' : 'border-border text-foreground/60 hover:bg-muted'}`}
        >
          Pricing
        </button>
        <button
          onClick={() => setTab('offers')}
          className={`tech-font rounded-full border px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.12em] transition-colors ${tab === 'offers' ? 'border-cyan-300/60 bg-cyan-300/10 text-cyan-200' : 'border-border text-foreground/60 hover:bg-muted'}`}
        >
          Offers
        </button>
      </div>

      {tab === 'pricing' && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-[12.5px] text-foreground/55">
              Customer Database pricing is always unlimited devices. Only Managed pricing carries device terms.
            </p>
            <Button size="sm" onClick={() => { setPricingForm({ ...EMPTY_PRICING }); setPreview(null); setPricingDialog(true); }}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Configure Price
            </Button>
          </div>

          {pricingQ.isLoading && <LoadingBlock label="Loading pricing…" />}
          {pricingQ.isError && <ErrorState onRetry={() => pricingQ.refetch()} />}
          {pricingQ.data && (
            <DataTable
              headers={['Plan', 'Mode', 'Period', 'Base Price', 'Devices', 'Status', '']}
              empty={<EmptyState title="No pricing configured yet. The legacy plan prices are used until a row exists." />}
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
                    {row.deploymentMode === 'CUSTOMER_DB'
                      ? 'Unlimited'
                      : `${row.includedDevices} + ${row.currency} ${row.additionalDevicePrice}/extra`}
                  </td>
                  <td className="px-3.5 py-3">
                    {row.isActive ? <StatusPill label="Active" tone="ok" /> : <StatusPill label="Inactive" tone="neutral" />}
                  </td>
                  <td className="px-3.5 py-3 text-right">
                    <button
                      onClick={() => togglePricingActive(row)}
                      className="tech-font rounded-full border border-border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-foreground/60 transition-colors hover:bg-muted"
                    >
                      {row.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </>
      )}

      {tab === 'offers' && (
        <>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-[12.5px] text-foreground/55">
              At most one offer applies per selection — the largest effective discount wins deterministically. Final prices never go negative.
            </p>
            <Button size="sm" onClick={() => { setOfferForm({ ...EMPTY_OFFER }); setOfferDialog(true); }}>
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
                    <button
                      onClick={() => toggleOffer(offer)}
                      className="tech-font rounded-full border border-border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-foreground/60 transition-colors hover:bg-muted"
                    >
                      {offer.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
        </>
      )}

      {/* Pricing dialog */}
      <Dialog open={pricingDialog} onOpenChange={setPricingDialog}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Configure Price</DialogTitle>
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
            {pricingForm.deploymentMode === 'MANAGED' && (
              <>
                <div className="space-y-2">
                  <Label>Included Devices *</Label>
                  <Input type="number" min="0" step="1" value={pricingForm.includedDevices} onChange={(e) => setPricingForm({ ...pricingForm, includedDevices: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label>Additional Device Price</Label>
                  <Input type="number" min="0" value={pricingForm.additionalDevicePrice} onChange={(e) => setPricingForm({ ...pricingForm, additionalDevicePrice: e.target.value })} />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  Devices beyond the included count are charged at the additional-device price. Customer Database is always unlimited and never charges per device.
                </p>
              </>
            )}
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
              {savingPricing ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save Price'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Offer dialog */}
      <Dialog open={offerDialog} onOpenChange={setOfferDialog}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Create Offer</DialogTitle>
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
              {savingOffer ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create Offer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}

// ─── Purchase Request Queue (V1) ───────────────────────────────────────────
// Super Admin review surface: SUBMITTED → REVIEWED → PAYMENT_VERIFIED →
// ACTIVATED (or REJECTED). Payment recording reuses the existing manual
// payment system; activation goes through the existing subscription
// lifecycle — this queue never forks either system.

type QueueRequest = {
  id: string;
  requestNumber: string;
  companyName: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  notes: string | null;
  plan: { id: string; name: string };
  deploymentMode: 'MANAGED' | 'CUSTOMER_DB';
  billingPeriod: 'MONTHLY' | 'YEARLY';
  deviceQuantity: number | null;
  basePrice: number;
  deviceCharge: number;
  discountAmount: number;
  finalPrice: number;
  currency: string;
  offerName: string | null;
  status: string;
  paymentReference: string | null;
  paymentMethod: string | null;
  paymentAmount: number | null;
  paymentDate: string | null;
  paymentNote: string | null;
  activatedSubscription: {
    id: string;
    status: string;
    organization: { id: string; name: string; slug: string };
  } | null;
  createdAt: string;
};

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'info' | 'neutral' | 'danger'> = {
  SUBMITTED: 'warn',
  REVIEWED: 'info',
  PAYMENT_VERIFIED: 'info',
  ACTIVATED: 'ok',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

export function SuperAdminPurchaseRequestsPage() {
  const [statusFilter, setStatusFilter] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // Full manual payment record dialog (§10): method/amount/ref/date/note are
  // captured at verification time — payment is never inferred from activation.
  const [payDialogId, setPayDialogId] = useState<string | null>(null);
  const [payDialogRequest, setPayDialogRequest] = useState<QueueRequest | null>(null);
  const [payForm, setPayForm] = useState({ method: 'bKash', amount: '', reference: '', date: '', note: '' });
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery<{ data: QueueRequest[] }>({
    queryKey: ['sa-purchase-requests', statusFilter],
    queryFn: async () => {
      const res = await fetch(`/api/super-admin/purchase-requests${statusFilter ? `?status=${statusFilter}` : ''}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('requests');
      return res.json();
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['sa-purchase-requests'] });

  async function act(id: string, action: string, extra: Record<string, unknown> = {}) {
    setActionId(id);
    try {
      const res = await fetch(`/api/super-admin/purchase-requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action, ...extra }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Action failed');
        return;
      }
      toast.success(`Request ${action.replace('_', ' ')}d`);
      setRejectId(null);
      setRejectReason('');
      setPayDialogId(null);
      invalidate();
    } catch {
      toast.error('Network error');
    } finally {
      setActionId(null);
    }
  }

  return (
    <PageTransition>
      <PageHeader
        eyebrow="Control Center"
        title="Purchase Requests"
        description="Review customer purchase requests, record manual payment verification, and activate subscriptions. Activation reuses the existing subscription lifecycle."
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {['', 'SUBMITTED', 'REVIEWED', 'PAYMENT_VERIFIED', 'ACTIVATED', 'REJECTED'].map((s) => (
          <button
            key={s || 'all'}
            onClick={() => setStatusFilter(s)}
            className={`tech-font rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.12em] transition-colors ${statusFilter === s ? 'border-cyan-300/60 bg-cyan-300/10 text-cyan-200' : 'border-border text-foreground/60 hover:bg-muted'}`}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      {isLoading && <LoadingBlock label="Loading requests…" />}
      {isError && <ErrorState onRetry={() => refetch()} />}
      {data && (
        <DataTable
          headers={['Request', 'Customer', 'Selection', 'Price', 'Status', 'Actions']}
          empty={<EmptyState title="No purchase requests." />}
        >
          {data.data.map((r) => (
            <tr key={r.id} className="transition-colors hover:bg-muted/40 align-top">
              <td className="px-3.5 py-3">
                <p className="font-medium text-foreground">{r.requestNumber}</p>
                <p className="text-[11px] text-foreground/40">{new Date(r.createdAt).toLocaleDateString()}</p>
              </td>
              <td className="px-3.5 py-3 text-[12px]">
                <p className="font-medium text-foreground">{r.companyName}</p>
                <p className="text-foreground/50">{r.contactName} · {r.contactEmail}</p>
              </td>
              <td className="px-3.5 py-3 text-[12px] text-foreground/70">
                <p>{r.plan.name}</p>
                <p className="text-[11px] text-foreground/45">
                  {r.deploymentMode === 'MANAGED' ? 'Managed' : 'Customer DB'} · {r.billingPeriod} ·{' '}
                  {r.deploymentMode === 'MANAGED' ? `${r.deviceQuantity ?? '—'} devices` : 'Unlimited devices'}
                </p>
                {r.offerName && <p className="text-[11px] text-emerald-500">Offer: {r.offerName} (−{r.currency} {r.discountAmount.toLocaleString()})</p>}
              </td>
              <td className="px-3.5 py-3 text-[12px]">
                <p className="font-semibold text-foreground">{r.currency} {r.finalPrice.toLocaleString()}</p>
                {r.deviceCharge > 0 && <p className="text-[11px] text-foreground/45">incl. {r.currency} {r.deviceCharge.toLocaleString()} devices</p>}
              </td>
              <td className="px-3.5 py-3"><StatusPill label={r.status} tone={STATUS_TONE[r.status] ?? 'neutral'} /></td>
              <td className="px-3.5 py-3">
                <div className="flex flex-col gap-1.5">
                  {r.activatedSubscription && (
                    <p className="text-[11px] text-foreground/60">
                      → {r.activatedSubscription.organization.name} · {r.activatedSubscription.status}
                    </p>
                  )}
                  {r.status === 'SUBMITTED' && (
                    <Button size="sm" variant="outline" disabled={actionId === r.id} onClick={() => act(r.id, 'review')}>
                      Mark Reviewed
                    </Button>
                  )}
                  {r.status === 'REVIEWED' && (
                    <Button
                      size="sm"
                      disabled={actionId === r.id}
                      onClick={() => {
                        setPayDialogRequest(r);
                        setPayForm({ method: 'bKash', amount: String(r.finalPrice), reference: '', date: new Date().toISOString().slice(0, 10), note: '' });
                        setPayDialogId(r.id);
                      }}
                    >
                      Record Payment
                    </Button>
                  )}
                  {r.status === 'PAYMENT_VERIFIED' && (
                    <Button size="sm" disabled={actionId === r.id} onClick={() => act(r.id, 'activate')}>
                      Activate Subscription
                    </Button>
                  )}
                  {['SUBMITTED', 'REVIEWED', 'PAYMENT_VERIFIED'].includes(r.status) && (
                    <Button size="sm" variant="ghost" className="text-rose-500" disabled={actionId === r.id} onClick={() => setRejectId(r.id)}>
                      Reject
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
      )}

      {/* Record Payment dialog — full manual payment record (§10) */}
      <Dialog open={payDialogId !== null} onOpenChange={(open) => { if (!open) setPayDialogId(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record manual payment</DialogTitle>
          </DialogHeader>
          {payDialogRequest && (
            <div className="space-y-3 py-2">
              <p className="text-[12px] text-foreground/70">
                {payDialogRequest.requestNumber} · {payDialogRequest.companyName} — requested{' '}
                <span className="font-medium text-foreground">{payDialogRequest.currency} {payDialogRequest.finalPrice.toLocaleString()}</span>
                . The requested price snapshot is never modified; the amount below is what was received.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Method *</Label>
                  <Select value={payForm.method} onValueChange={(v) => setPayForm({ ...payForm, method: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['bKash', 'Nagad', 'Rocket', 'Bank_Transfer', 'Cash', 'Other'].map((m) => (
                        <SelectItem key={m} value={m}>{m.replace(/_/g, ' ')}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Amount received *</Label>
                  <Input type="number" min="0" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} />
                </div>
                <div className="space-y-1.5">
                  <Label>Transaction / reference</Label>
                  <Input value={payForm.reference} onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} placeholder="e.g. bKash TrxID" />
                </div>
                <div className="space-y-1.5">
                  <Label>Payment date</Label>
                  <Input type="date" value={payForm.date} onChange={(e) => setPayForm({ ...payForm, date: e.target.value })} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Note</Label>
                <Input value={payForm.note} onChange={(e) => setPayForm({ ...payForm, note: e.target.value })} placeholder="Anything worth recording" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayDialogId(null)} disabled={actionId !== null}>Cancel</Button>
            <Button
              disabled={actionId !== null || !payForm.amount || Number.isNaN(Number(payForm.amount))}
              onClick={() =>
                payDialogId &&
                act(payDialogId, 'verify_payment', {
                  paymentMethod: payForm.method,
                  paymentAmount: Number(payForm.amount),
                  paymentReference: payForm.reference,
                  paymentDate: payForm.date || undefined,
                  paymentNote: payForm.note,
                })
              }
            >
              Verify Payment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog */}
      <Dialog open={rejectId !== null} onOpenChange={(open) => { if (!open) setRejectId(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject purchase request</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label>Reason (required)</Label>
            <Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Why is this request rejected?" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectId(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={!rejectReason.trim() || actionId !== null}
              onClick={() => rejectId && act(rejectId, 'reject', { reason: rejectReason })}
            >
              Reject Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
