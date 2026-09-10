'use client';

import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Check, Sparkles } from 'lucide-react';
import { Reveal, SectionHeading, GlowButton, useLandingContent } from './shared';

// ─── Pricing — driven by the live plan catalog (same /api/plans contract ───
interface PublicPlan {
  id: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  currency: string;
  maxDevices: number;
  retentionDays: number;
  features: string[];
  isSelfHosted: boolean;
}

const CURRENCY_SYMBOL: Record<string, string> = { BDT: '৳', USD: '$', EUR: '€' };

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

  const plans = (data?.plans ?? []).filter((p) => !p.isSelfHosted).slice(0, 3);

  return (
    <section id="pricing" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <SectionHeading
        copyKey="pricing"
        eyebrow="Pricing"
        title="Choose the way your organization works."
        subtitle="Every plan starts with a conversation. Select a package, talk to OmniSight, and our team handles provisioning — no online checkout."
      />

      <div className="mt-14 grid gap-5 md:grid-cols-3">
        {plans.map((plan, i) => {
          const symbol = CURRENCY_SYMBOL[plan.currency] ?? `${plan.currency} `;
          const isFree = plan.priceMonthly === 0;
          const features =
            plan.features.length > 0
              ? plan.features
              : [
                  `Up to ${plan.maxDevices < 0 ? 'unlimited' : plan.maxDevices} devices`,
                  `Retention: ${plan.retentionDays === 0 ? 'unlimited' : `${plan.retentionDays} days`}`,
                  'Real-time monitoring',
                  'AI-powered insights',
                ];
          return (
            <Reveal key={plan.id} delay={i * 0.1} className="h-full">
              <motion.div
                whileHover={{ scale: 1.02, y: -4 }}
                transition={{ type: 'spring', stiffness: 320, damping: 24 }}
                className="glass-panel flex h-full flex-col rounded-2xl p-7"
              >
                <p className="tech-font text-[12px] font-bold uppercase tracking-[0.22em] text-cyan-300">
                  {plan.name}
                </p>
                <p className="mt-4 text-4xl font-semibold tracking-tight text-white">
                  {symbol}
                  {plan.priceMonthly.toLocaleString()}
                  <span className="ml-1 text-sm font-normal text-white/40">/ month</span>
                </p>
                <p className="mt-2 min-h-[40px] text-[13px] leading-relaxed text-white/50">
                  {plan.description || 'Scoped for your organization’s needs.'}
                </p>
                <ul className="mt-5 flex-1 space-y-2.5 border-t border-white/10 pt-5">
                  {features.slice(0, 5).map((f) => (
                    <li key={f} className="flex items-start gap-2.5 text-[13px] text-white/65">
                      <Check size={15} className="mt-0.5 shrink-0 text-cyan-300" aria-hidden />
                      {f}
                    </li>
                  ))}
                </ul>
                <div className="mt-6">
                  <GlowButton href="/contact" variant={plan.name === 'Pro' ? 'primary' : 'outline'} className="w-full">
                    {isFree ? 'Get Started' : 'Talk to OmniSight'}
                  </GlowButton>
                </div>
              </motion.div>
            </Reveal>
          );
        })}
      </div>

      <Reveal className="mx-auto mt-8 max-w-2xl text-center">
        <p className="text-[12.5px] leading-relaxed text-white/40">
          Select a package → Contact OmniSight → Manual payment →
          Organization provisioning → Receive credentials → First login.
        </p>
      </Reveal>
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