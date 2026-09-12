'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Check, Database, Server, Sparkles } from 'lucide-react';
import { Reveal, SectionHeading, GlowButton, useLandingContent } from './shared';

// ─── Pricing — V1 deployment-mode-aware pricing section ────────────────────
// Two deployment modes: OmniSight Managed and Customer Database.
// Pricing rows come from PlanPricing via /api/plans (Super Admin config).
// The client NEVER computes or hardcodes prices — if a PlanPricing row has
// basePrice=0, the section shows "Contact us for pricing" instead.
//
// Both modes use device-based entitlement (includedDevices + additionalDevicePrice).
// There are no "unlimited devices" in the V1 commercial model.

interface PublicPlan {
  id: string;
  name: string;
  description: string | null;
  currency: string;
  features: string[];
  /** V1 pricing rows from PlanPricing (Super Admin config). */
  pricing: Array<{
    deploymentMode: 'MANAGED' | 'CUSTOMER_DB';
    billingPeriod: 'MONTHLY' | 'YEARLY';
    basePrice: number;
    currency: string;
    includedDevices: number;
    additionalDevicePrice: number;
  }>;
  /** True when at least one PlanPricing row has basePrice > 0. */
  hasActivePricing: boolean;
  offerName?: string | null;
  offerIsFree?: boolean;
  /** Regular price (highest configured V1 base price) before any offer discount. */
  regularPrice: number;
  /** Final price after applying the best active offer discount. Equals regularPrice when no offer. */
  finalPrice: number;
  /** Discount amount applied by the winning offer. 0 when no offer. */
  discountAmount: number;
}

const CURRENCY_SYMBOL: Record<string, string> = { BDT: '৳', USD: '$', EUR: '€' };

/** A PlanPricing row with basePrice > 0 is considered "configured". */
function isConfigured(row: { basePrice: number } | undefined): row is { basePrice: number } {
  return row != null && row.basePrice > 0;
}

function fmtSymbol(currency: string) {
  return CURRENCY_SYMBOL[currency] ?? `${currency} `;
}

// ─── Managed plan card ──────────────────────────────────────────────────────
function ManagedPlanCard({
  plan,
  period,
  index,
}: {
  plan: PublicPlan;
  period: 'MONTHLY' | 'YEARLY';
  index: number;
}) {
  const managed = plan.pricing.find(
    (r) => r.deploymentMode === 'MANAGED' && r.billingPeriod === period,
  );
  // Currency comes from the V1 pricing row; fallback to plan-level currency.
  const cur = fmtSymbol(managed?.currency ?? plan.currency);
  const configured = isConfigured(managed);

  return (
    <Reveal delay={index * 0.1} className="h-full">
      <motion.div
        whileHover={{ scale: 1.02, y: -4 }}
        transition={{ type: 'spring', stiffness: 320, damping: 24 }}
        className="glass-panel flex h-full flex-col rounded-2xl p-7"
      >
        <p className="tech-font text-[12px] font-bold uppercase tracking-[0.22em] text-cyan-300">
          {plan.name}
        </p>

        {plan.offerName && (
          <span className="mt-2 inline-flex w-fit items-center rounded-full border border-emerald-300/40 bg-emerald-300/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-300">
            {plan.offerIsFree ? 'Free offer' : `Offer: ${plan.offerName}`}
          </span>
        )}

        {configured ? (
          <>
            {plan.discountAmount > 0 && plan.regularPrice > 0 ? (
              <>
                <p className="mt-4 text-4xl font-semibold tracking-tight text-white">
                  {cur}
                  {plan.finalPrice.toLocaleString()}
                  <span className="ml-1 text-sm font-normal text-white/40">/ month</span>
                </p>
                <p className="mt-1 text-sm text-white/40">
                  <span className="line-through decoration-rose-400/60">{cur}{plan.regularPrice.toLocaleString()}</span>
                  <span className="ml-2 font-medium text-emerald-300">
                    Save {Math.round((plan.discountAmount / plan.regularPrice) * 100)}%
                  </span>
                </p>
              </>
            ) : (
              <p className="mt-4 text-4xl font-semibold tracking-tight text-white">
                {cur}
                {managed!.basePrice.toLocaleString()}
                <span className="ml-1 text-sm font-normal text-white/40">/ month</span>
              </p>
            )}
            <p className="mt-1 text-[11.5px] text-white/40">
              {period === 'YEARLY' ? 'Billed yearly' : 'Billed monthly'}
              {` · ${managed!.includedDevices} devices included`}
              {managed!.additionalDevicePrice
                ? ` · +${cur}${managed!.additionalDevicePrice.toLocaleString()}/extra device`
                : ''}
            </p>
          </>
        ) : (
          <p className="mt-4 text-lg font-medium text-white/50">Contact us for pricing</p>
        )}

        <p className="mt-2 min-h-[40px] text-[13px] leading-relaxed text-white/50">
          {plan.description || 'Scoped for your organization\u2019s needs.'}
        </p>

        <div className="mt-6">
          <GlowButton
            href={`/checkout?planId=${plan.id}`}
            variant={plan.name === 'Pro' ? 'primary' : 'outline'}
            className="w-full"
          >
            {configured ? 'Request Pricing' : 'Contact Sales'}
          </GlowButton>
        </div>
      </motion.div>
    </Reveal>
  );
}

// ─── Customer Database pricing row ──────────────────────────────────────────
function CustomerDbPricing({
  plan,
  period,
}: {
  plan: PublicPlan;
  period: 'MONTHLY' | 'YEARLY';
}) {
  const row = plan.pricing.find(
    (r) => r.deploymentMode === 'CUSTOMER_DB' && r.billingPeriod === period,
  );
  // Currency comes from the V1 pricing row; fallback to plan-level currency.
  const cur = fmtSymbol(row?.currency ?? plan.currency);
  const configured = isConfigured(row);

  return (
    <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4">
      <div>
        <p className="text-[14px] font-semibold text-white">{plan.name}</p>
        <p className="mt-0.5 text-[12px] text-white/40">
          {configured
            ? `${row!.includedDevices} devices included${row!.additionalDevicePrice ? ` · +${cur}${row!.additionalDevicePrice.toLocaleString()}/extra` : ''}`
            : 'Not configured'}
        </p>
      </div>
      {configured ? (
        <p className="text-right text-[15px] font-semibold text-white">
          {cur}
          {row!.basePrice.toLocaleString()}
          <span className="ml-1 text-[12px] font-normal text-white/40">
            / {period === 'YEARLY' ? 'yr' : 'mo'}
          </span>
        </p>
      ) : (
        <p className="text-[13px] text-white/40">Not configured</p>
      )}
    </div>
  );
}

// ─── Main pricing section ───────────────────────────────────────────────────
export function PricingSection() {
  const { data } = useQuery<{ plans: PublicPlan[] }>({
    queryKey: ['landing-plans'],
    queryFn: async () => {
      const res = await fetch('/api/plans');
      if (!res.ok) throw new Error('Failed to load plans');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const [period, setPeriod] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  // Every catalog plan is a V1 plan (MANAGED / CUSTOMER_DB) — self-hosted plans
  // no longer exist, so no filtering is required.
  const allPlans = data?.plans ?? [];

  // ── V1-driven classification (no legacy priceMonthly) ─────────────────
  // A plan is "free" when it has NO active V1 pricing rows (basePrice > 0).
  // A plan is "paid" when at least one MANAGED row has basePrice > 0.
  // This ensures the landing page is a VIEW of Super Admin config, not a
  // second place where commercial values are defined.
  const freePlan = allPlans.find((p) => !p.hasActivePricing);
  const paidPlans = allPlans.filter((p) =>
    p.pricing.some((r) => r.deploymentMode === 'MANAGED' && r.basePrice > 0),
  );

  // Customer Database: plans that have at least one CUSTOMER_DB row
  const customerDbPlans = allPlans.filter((p) =>
    p.pricing.some((r) => r.deploymentMode === 'CUSTOMER_DB'),
  );

  // Check if any Customer Database pricing is actually configured
  const hasCustomerDbPricing = customerDbPlans.some((p) =>
    p.pricing.some(
      (r) => r.deploymentMode === 'CUSTOMER_DB' && r.basePrice > 0,
    ),
  );

  return (
    <section id="pricing" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <SectionHeading
        copyKey="pricing"
        eyebrow="Pricing"
        title="Choose the way your organization works."
        subtitle="Two deployment modes. Pick the one that fits your infrastructure — then choose a plan."
      />

      {/* Monthly / Yearly toggle */}
      <div className="mx-auto mb-14 flex justify-center">
        <div className="tech-font inline-flex rounded-full border border-white/10 bg-white/5 p-1">
          {(['MONTHLY', 'YEARLY'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`rounded-full px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] transition-colors ${
                period === p
                  ? 'bg-cyan-300/20 text-cyan-200'
                  : 'text-white/50 hover:text-white/80'
              }`}
            >
              {p === 'MONTHLY' ? 'Monthly' : 'Yearly'}
            </button>
          ))}
        </div>
      </div>

      {/* ── OMNISIGHT MANAGED ──────────────────────────────────────────── */}
      <Reveal>
        <div className="mb-6 flex items-center gap-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-cyan-300">
            <Server size={16} />
          </span>
          <div>
            <h3 className="tech-font text-[14px] font-bold uppercase tracking-[0.18em] text-white">
              OmniSight Managed
            </h3>
            <p className="text-[12.5px] text-white/40">
              We host the platform, database, and storage. Zero infrastructure setup.
            </p>
          </div>
        </div>
      </Reveal>

      <div className="grid gap-5 md:grid-cols-3">
        {/* Free Access — 7 Days (OmniSight Managed only) */}
        {freePlan && (
          <Reveal delay={0} className="h-full">
            <motion.div
              whileHover={{ scale: 1.02, y: -4 }}
              transition={{ type: 'spring', stiffness: 320, damping: 24 }}
              className="glass-panel flex h-full flex-col rounded-2xl p-7"
            >
              <p className="tech-font text-[12px] font-bold uppercase tracking-[0.22em] text-emerald-300">
                Free Access — 7 Days
              </p>
              <p className="mt-4 text-4xl font-semibold tracking-tight text-white">
                Free
              </p>
              <p className="mt-1 text-[11.5px] text-white/40">
                7-day trial · No credit card required
              </p>
              <p className="mt-2 min-h-[40px] text-[13px] leading-relaxed text-white/50">
                Try OmniSight with full features for 7 days. Submit a
                request and our team provisions your environment.
              </p>
              <ul className="mt-5 flex-1 space-y-2.5 border-t border-white/10 pt-5">
                <li className="flex items-start gap-2.5 text-[13px] text-white/65">
                  <Check size={15} className="mt-0.5 shrink-0 text-emerald-300" aria-hidden />
                  7 days full access
                </li>
                <li className="flex items-start gap-2.5 text-[13px] text-white/65">
                  <Check size={15} className="mt-0.5 shrink-0 text-emerald-300" aria-hidden />
                  No credit card required
                </li>
                <li className="flex items-start gap-2.5 text-[13px] text-white/65">
                  <Check size={15} className="mt-0.5 shrink-0 text-emerald-300" aria-hidden />
                  Super Admin approval &amp; provisioning
                </li>
              </ul>
              <div className="mt-6">
                <GlowButton href="/contact?plan=Free" variant="outline" className="w-full">
                  Get 7 Days Free Access
                </GlowButton>
              </div>
            </motion.div>
          </Reveal>
        )}

        {/* Pro and Business paid cards */}
        {paidPlans.map((plan, i) => (
          <ManagedPlanCard
            key={plan.id}
            plan={plan}
            period={period}
            index={i + 1}
          />
        ))}
      </div>

      <Reveal className="mx-auto mt-8 max-w-2xl text-center">
        <p className="text-[12.5px] leading-relaxed text-white/40">
          Select a plan → Contact OmniSight → Manual payment →
          Organization provisioning → Receive credentials → First login.
        </p>
      </Reveal>

      {/* ── CUSTOMER DATABASE ──────────────────────────────────────────── */}
      {customerDbPlans.length > 0 && (
        <>
          <Reveal className="mt-20">
            <div className="mb-6 flex items-center gap-3">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-cyan-300">
                <Database size={16} />
              </span>
              <div>
                <h3 className="tech-font text-[14px] font-bold uppercase tracking-[0.18em] text-white">
                  Customer Database
                </h3>
                <p className="text-[12.5px] text-white/40">
                  Your data infrastructure. Our application. Device-based pricing.
                </p>
              </div>
            </div>
          </Reveal>

          <Reveal delay={0.05}>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {customerDbPlans.map((plan) => (
                <CustomerDbPricing
                  key={plan.id}
                  plan={plan}
                  period={period}
                />
              ))}

              {hasCustomerDbPricing ? (
                <div className="flex items-center rounded-xl border border-white/10 bg-white/[0.03] px-5 py-4">
                  <div>
                    <p className="text-[13px] font-semibold text-white">
                      All Customer Database plans include
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      <li className="flex items-center gap-2 text-[12px] text-white/50">
                        <span className="h-1 w-1 rounded-full bg-cyan-300" aria-hidden />
                        Device-based pricing — included + per-device charge
                      </li>
                      <li className="flex items-center gap-2 text-[12px] text-white/50">
                        <span className="h-1 w-1 rounded-full bg-cyan-300" aria-hidden />
                        Customer-controlled primary database
                      </li>
                      <li className="flex items-center gap-2 text-[12px] text-white/50">
                        <span className="h-1 w-1 rounded-full bg-cyan-300" aria-hidden />
                        OmniSight-managed application layer
                      </li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="flex items-center rounded-xl border border-dashed border-white/15 px-5 py-4">
                  <div>
                    <p className="text-[13px] font-medium text-white/50">
                      Customer Database pricing not yet configured
                    </p>
                    <p className="mt-1 text-[12px] text-white/35">
                      Contact us for a custom quote.
                    </p>
                    <GlowButton href="/contact" variant="outline" className="mt-3 !px-4 !py-1.5 !text-[11px]">
                      Contact Sales
                    </GlowButton>
                  </div>
                </div>
              )}
            </div>
          </Reveal>

          <Reveal className="mx-auto mt-6 max-w-2xl text-center">
            <p className="text-[12.5px] leading-relaxed text-white/40">
              Customer Database deployments use your organization&apos;s primary database.
              Device-based pricing — included devices plus per-device charges for extras.
            </p>
          </Reveal>
        </>
      )}
    </section>
  );
}

// ─── FinalCTA ──────────────────────────────────────────────────────────────
export function FinalCTA() {
  const reduce = useReducedMotion();
  const content = useLandingContent();
  const f = (content.final ?? {}) as { eyebrow?: string; title?: string; subtitle?: string; primaryCta?: string; secondaryCta?: string };
  const primaryLabel = f.primaryCta ?? 'Get Started';
  const secondaryLabel = f.secondaryCta ?? 'Talk to OmniSight';
  return (
    <section className="relative overflow-hidden border-t border-white/10 py-28">
      {/* Cinematic glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 h-[70vh] w-[70vw] -translate-x-1/2 -translate-y-1/2 rounded-full blur-[140px]"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(0,180,255,0.16), rgba(90,140,255,0.06) 50%, transparent 72%)',
        }}
      />
      <div className="relative z-10 mx-auto max-w-4xl px-4 text-center sm:px-6">
        <Reveal>
          <span className="tech-font inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.28em] text-cyan-300/90">
            <Sparkles size={12} aria-hidden />
            {f.eyebrow ?? 'Workforce intelligence'}
          </span>
          <h2 className="mt-6 text-3xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl">
            {f.title ?? 'Turn workforce activity into operational intelligence.'}
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-white/55">
            {f.subtitle ?? 'Bring activity, productivity, visibility and intelligence into one platform.'}
          </p>
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 14 }}
            whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <GlowButton href="#pricing">
              {primaryLabel} <ArrowRight size={15} aria-hidden />
            </GlowButton>
            <GlowButton href="/contact" variant="outline">
              {secondaryLabel}
            </GlowButton>
          </motion.div>
        </Reveal>
      </div>
    </section>
  );
}

// ─── LandingFooter — minimal, no fake contacts ─────────────────────────────
const FOOTER_LINKS = [
  { label: 'Product', href: '#product' },
  { label: 'Features', href: '#features' },
  { label: 'Security', href: '#security' },
  { label: 'Deployment', href: '#deployment' },
  { label: 'Pricing', href: '#pricing' },
];

export function LandingFooter() {
  const scrollTo = (href: string) => {
    document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
  };
  const content = useLandingContent();
  const footer = (content.footer ?? {}) as { tagline?: string; copyright?: string };
  const tagline = footer.tagline ?? 'Workforce Intelligence Platform';
  const copyright = footer.copyright ?? '© 2026 OmniSight. All rights reserved.';

  return (
    <footer className="border-t border-white/10 bg-black py-12" role="contentinfo">
      <div className="mx-auto flex max-w-7xl flex-col items-center gap-8 px-4 sm:px-6 lg:px-8 md:flex-row md:items-start md:justify-between">
        <div className="text-center md:text-left">
          <p className="tech-font text-[13px] font-bold tracking-[0.18em] text-white">OMNISIGHT</p>
          <p className="mt-1 text-[12px] text-white/45">{tagline}</p>
        </div>

        <nav aria-label="Footer" className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
          {FOOTER_LINKS.map((l) => (
            <button
              key={l.label}
              onClick={() => scrollTo(l.href)}
              className="tech-font text-[11px] font-bold uppercase tracking-[0.16em] text-white/55 transition-colors hover:text-white"
            >
              {l.label}
            </button>
          ))}
          <a
            href="/login"
            className="tech-font text-[11px] font-bold uppercase tracking-[0.16em] text-white/55 transition-colors hover:text-white"
          >
            Sign In
          </a>
        </nav>

        <p className="text-center text-[11.5px] text-white/35 md:text-right">
          {copyright}
        </p>
      </div>
    </footer>
  );
}
