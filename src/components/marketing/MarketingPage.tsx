'use client';

import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  ArrowRight,
  BrainCircuit,
  Camera,
  Check,
  Database,
  Eye,
  Gauge,
  Lock,
  MonitorCog,
  Network,
  Server,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PublicHeader } from '@/components/layout/PublicHeader';
import { PublicFooter } from '@/components/layout/PublicFooter';
import { DashboardPreview } from '@/components/marketing/DashboardPreview';
import { FeatureCard, type FeatureItem } from '@/components/marketing/FeatureCard';
import { PricingCard, type PlanCard } from '@/components/marketing/PricingCard';
import { ContactForm } from '@/components/marketing/ContactForm';

// ─── Spec'd feature set: exactly six cards ───────────────────────────────
const FEATURES: FeatureItem[] = [
  {
    icon: Activity,
    title: 'Real-Time Monitoring',
    description:
      'Live employee activity and connection status, streaming across every device as it happens.',
  },
  {
    icon: BrainCircuit,
    title: 'AI Workforce Intelligence',
    description:
      'Turn activity data into useful insights and reports — with AI that surfaces trends and anomalies automatically.',
  },
  {
    icon: Camera,
    title: 'Screenshot Monitoring',
    description:
      'Understand what is happening on screen with configurable, consent-aware screenshots.',
  },
  {
    icon: Gauge,
    title: 'Productivity Analytics',
    description:
      'Track activity trends and workforce performance with clear, actionable visualizations.',
  },
  {
    icon: Users,
    title: 'Enterprise Controls',
    description:
      'Manage devices, users, policies, and organization settings from a single control plane.',
  },
  {
    icon: Lock,
    title: 'Privacy-First Architecture',
    description:
      'Give organizations control over their data and monitoring policies — including self-hosting on your own infrastructure.',
  },
];

// ─── How it works: three spec'd steps ────────────────────────────────────
const STEPS = [
  {
    icon: UserPlus,
    title: 'Connect Your Workforce',
    description:
      'Install/connect the OmniSight service on your organization devices in minutes.',
  },
  {
    icon: MonitorCog,
    title: 'Configure Your Workspace',
    description:
      'Your Organization Admin controls monitoring, AI, privacy, and data settings.',
  },
  {
    icon: Sparkles,
    title: 'Understand Your Workforce',
    description:
      'View real-time activity, analytics, screenshots, and AI insights from one dashboard.',
  },
];

const VALUE_STRIP = [
  { icon: Eye, label: 'Real-Time Visibility' },
  { icon: BrainCircuit, label: 'AI-Powered Insights' },
  { icon: Lock, label: 'Privacy-First Monitoring' },
  { icon: Users, label: 'Enterprise Control' },
  { icon: Server, label: 'Self-Hosted Ready' },
];

// Shared scroll-reveal variant
const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0 },
};

function SectionTitle({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5 }}
      className="mx-auto mb-12 max-w-2xl text-center"
    >
      <p className="text-sm font-semibold uppercase tracking-wider text-primary">{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">{title}</h2>
      <p className="mt-3 text-muted-foreground">{subtitle}</p>
    </motion.div>
  );
}

// ─── Pricing section, driven by the live plan catalog (BDT) ──────────────
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

function PricingSection() {
  const { data } = useQuery<{ plans: PublicPlan[] }>({
    queryKey: ['plans'],
    queryFn: async () => {
      const res = await fetch('/api/plans');
      if (!res.ok) throw new Error('Failed to load plans');
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  const plans = data?.plans ?? [];
  const payPlans = plans.filter((p) => !p.isSelfHosted).slice(0, 3);

  const cards: PlanCard[] = payPlans.map((p) => {
    const symbol = CURRENCY_SYMBOL[p.currency] ?? p.currency + ' ';
    const isFree = p.priceMonthly === 0;
    return {
      name: p.name,
      price: `${symbol}${p.priceMonthly.toLocaleString()}`,
      period: '/ month',
      description:
        p.description ||
        `For ${p.name === 'Free' ? 'small teams getting started' : 'growing teams that need more'}.`,
      features:
        p.features.length > 0
          ? p.features
          : [
              `Up to ${p.maxDevices < 0 ? 'unlimited' : p.maxDevices} devices`,
              `Data retention: ${p.retentionDays === 0 ? 'unlimited' : p.retentionDays + ' days'}`,
              'Real-time monitoring',
              'AI-powered insights',
            ],
      cta: isFree ? 'Get Started' : 'Contact Sales',
      href: '#contact',
      highlighted: p.name === 'Pro',
    };
  });

  return (
    <section id="pricing" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <SectionTitle
        eyebrow="Pricing"
        title="Simple, transparent pricing"
        subtitle="Choose the plan that fits your organization. Every paid plan starts with a conversation — our team helps you pick the right setup."
      />
      <div className="grid gap-6 pt-4 md:grid-cols-3">
        {cards.map((plan, i) => (
          <motion.div
            key={plan.name}
            variants={fadeUp}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-60px' }}
            transition={{ duration: 0.5, delay: i * 0.12 }}
            whileHover={{ y: -6 }}
          >
            <PricingCard plan={plan} />
          </motion.div>
        ))}
      </div>
    </section>
  );
}

export function MarketingPage() {
  const reduce = useReducedMotion();

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <PublicHeader />

      <main className="flex-1">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden
            className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,rgba(16,185,129,0.15),transparent_55%),radial-gradient(ellipse_at_top_right,rgba(99,102,241,0.14),transparent_55%)]"
          />
          <div className="mx-auto max-w-6xl px-4 pb-20 pt-20 text-center sm:px-6">
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 20 }}
              animate={reduce ? false : { opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="mb-6 inline-flex"
            >
              <Badge variant="secondary" className="gap-2 px-3 py-1.5">
                <ShieldCheck className="h-4 w-4" />
                Privacy-first · Self-hosted ready
              </Badge>
            </motion.div>

            <motion.h1
              initial={reduce ? false : { opacity: 0, y: 24 }}
              animate={reduce ? false : { opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.1 }}
              className="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl"
            >
              Workforce Intelligence,{' '}
              <span className="bg-gradient-to-r from-emerald-500 to-indigo-500 bg-clip-text text-transparent">
                Built for Privacy.
              </span>
            </motion.h1>

            <motion.p
              initial={reduce ? false : { opacity: 0, y: 20 }}
              animate={reduce ? false : { opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.2 }}
              className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground"
            >
              Monitor activity, understand productivity, and turn workforce data
              into actionable intelligence — with AI-powered insights and
              enterprise-grade privacy controls.
            </motion.p>

            <motion.div
              initial={reduce ? false : { opacity: 0, y: 16 }}
              animate={reduce ? false : { opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.3 }}
              className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row"
            >
              <Button size="lg" asChild>
                <a href="#contact">
                  Get Started
                  <ArrowRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <a href="#features">Explore Features</a>
              </Button>
            </motion.div>

            {/* Animated dashboard preview */}
            <DashboardPreview />
          </div>
        </section>

        {/* ── Trust / value strip ───────────────────────────────────────── */}
        <section className="border-y border-border/60 bg-muted/30 py-10">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-4 px-4 sm:px-6">
            {VALUE_STRIP.map((item, i) => {
              const Icon = item.icon;
              return (
                <motion.div
                  key={item.label}
                  variants={fadeUp}
                  initial="hidden"
                  whileInView="show"
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.08 }}
                  className="flex items-center gap-2.5"
                >
                  <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="text-sm font-semibold text-foreground">{item.label}</span>
                </motion.div>
              );
            })}
          </div>
        </section>

        {/* ── Features ──────────────────────────────────────────────────── */}
        <section id="features" className="border-border/60 py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionTitle
              eyebrow="Features"
              title="Everything You Need to Understand Your Workforce"
              subtitle="A complete workforce intelligence platform — from live activity to AI-driven analysis — with privacy at the core."
            />
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature, i) => (
                <motion.div
                  key={feature.title}
                  variants={fadeUp}
                  initial="hidden"
                  whileInView="show"
                  viewport={{ once: true, margin: '-60px' }}
                  transition={{ duration: 0.5, delay: (i % 3) * 0.1 }}
                  whileHover={reduce ? undefined : { y: -6 }}
                >
                  <FeatureCard feature={feature} />
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ── How it works ──────────────────────────────────────────────── */}
        <section id="how-it-works" className="border-y border-border/60 bg-muted/30 py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionTitle
              eyebrow="How it works"
              title="From zero to full visibility in three steps"
              subtitle="A simple flow designed to keep the customer journey effortless."
            />
            <div className="grid gap-6 md:grid-cols-3">
              {STEPS.map((step, i) => {
                const Icon = step.icon;
                return (
                  <motion.div
                    key={step.title}
                    variants={fadeUp}
                    initial="hidden"
                    whileInView="show"
                    viewport={{ once: true, margin: '-60px' }}
                    transition={{ duration: 0.5, delay: i * 0.15 }}
                    className="relative rounded-xl border border-border/60 bg-background p-6"
                  >
                    <span className="absolute right-6 top-6 text-4xl font-bold text-muted-foreground/10">
                      0{i + 1}
                    </span>
                    <span className="inline-flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="h-6 w-6" />
                    </span>
                    <h3 className="mt-4 text-lg font-semibold text-foreground">{step.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.description}</p>
                  </motion.div>
                );
              })}
            </div>

            {/* Animated flow */}
            <motion.div
              variants={fadeUp}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="mx-auto mt-12 flex max-w-3xl flex-wrap items-center justify-center gap-3 text-sm"
            >
              {['Devices', 'OmniSight', 'Intelligence', 'Admin Dashboard'].map((node, i, arr) => (
                <div key={node} className="flex items-center gap-3">
                  <span className="rounded-full border border-primary/30 bg-primary/5 px-4 py-1.5 font-medium text-foreground">
                    {node}
                  </span>
                  {i < arr.length - 1 && <ArrowRight className="h-4 w-4 text-primary/60" />}
                </div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* ── Privacy / self-hosted reassurance ─────────────────────────── */}
        <section id="self-hosted" className="mx-auto max-w-6xl px-4 py-20 text-center sm:px-6">
          <motion.div
            variants={fadeUp}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.5 }}
            className="mx-auto flex max-w-2xl flex-col items-center"
          >
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Database className="h-7 w-7" />
            </span>
            <h2 className="mt-6 text-3xl font-bold tracking-tight sm:text-4xl">
              Your Data, Your Servers
            </h2>
            <p className="mt-4 max-w-xl text-muted-foreground">
              With OmniSight Self-Hosted you deploy on your own infrastructure.
              Monitoring data, screenshots, and insights never leave your control.
              Organizations can even bring their own analytics database.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-2.5">
              {['Role-based access', 'Full audit trail', 'Encrypted at rest', 'Configurable retention'].map(
                (point) => (
                  <Badge key={point} variant="outline" className="gap-1.5 px-3 py-1.5">
                    <Check className="h-3.5 w-3.5 text-primary" />
                    {point}
                  </Badge>
                )
              )}
            </div>
          </motion.div>
        </section>

        {/* ── Pricing (live BDT catalog) ────────────────────────────────── */}
        <PricingSection />

        {/* ── Contact / CTA ─────────────────────────────────────────────── */}
        <section id="contact" className="border-t border-border/60 bg-muted/20 pb-20 pt-20">
          <div className="mx-auto max-w-3xl px-4 sm:px-6">
            <motion.div
              variants={fadeUp}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: '-80px' }}
              transition={{ duration: 0.5 }}
              className="text-center"
            >
              <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background px-4 py-1.5 text-sm text-muted-foreground">
                <Network className="h-4 w-4" />
                Let&apos;s work together
              </span>
              <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">
                Let&apos;s Build Your Workforce Intelligence Setup
              </h2>
              <p className="mt-3 text-muted-foreground">
                Tell us what your organization needs. Our team will help you choose
                the right OmniSight setup.
              </p>
            </motion.div>
            <motion.div
              variants={fadeUp}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, margin: '-60px' }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="mt-8"
            >
              <ContactForm initialPlan="Business" />
            </motion.div>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
