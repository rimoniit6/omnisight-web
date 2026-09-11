'use client';

import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  Activity,
  BrainCircuit,
  TrendingUp,
  AlertTriangle,
  Users,
  AlertOctagon,
} from 'lucide-react';
import { AnimatedBackground } from './AnimatedBackground';
import { GlowButton, useLandingContent } from './shared';

// ─── Hero visual: 3-panel composition (See → Understand → Act) ──────────────
function HeroVisual() {
  return (
    <div className="relative mx-auto mt-14 w-full max-w-5xl" aria-hidden>
      <div className="grid gap-4 sm:grid-cols-[0.85fr_1.15fr_0.85fr] sm:items-center">
        {/* Left panel — SEE (activity feed) */}
        <motion.div
          initial={{ opacity: 0, x: -20, rotateY: 6 }}
          animate={{ opacity: 1, x: 0, rotateY: 0 }}
          transition={{ duration: 0.9, delay: 1.0, ease: [0.22, 1, 0.36, 1] }}
          className="glass-panel overflow-hidden rounded-2xl p-4 sm:translate-y-4 sm:scale-[0.92]"
          style={{ transformStyle: 'preserve-3d', perspective: '1200px' }}
        >
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <span className="tech-font text-[10px] font-bold uppercase tracking-[0.22em] text-white/60">
              <Activity size={11} className="mr-1 inline text-emerald-300" />
              Live Activity
            </span>
            <span className="tech-font inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-[0.18em] text-emerald-300">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Live
            </span>
          </div>
          <div className="mt-3 space-y-2">
            {[
              { name: 'Rimon', app: 'VS Code', tag: 'Working', color: 'text-cyan-300' },
              { name: 'Tanvir', app: 'Chrome', tag: 'Research', color: 'text-emerald-300' },
              { name: 'Nabila', app: 'Figma', tag: 'Designing', color: 'text-cyan-300' },
              { name: 'Hasan', app: 'Slack', tag: 'Comm.', color: 'text-amber-300' },
              { name: 'Sadia', app: 'Notion', tag: 'Writing', color: 'text-cyan-300' },
            ].map((r, i) => (
              <motion.div
                key={r.name}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 1.3 + i * 0.08 }}
                className="flex items-center justify-between text-[10px]"
              >
                <span className="text-white/80">{r.name}</span>
                <span className="text-white/40">{r.app}</span>
                <span className={`tech-font font-bold ${r.color}`}>{r.tag}</span>
              </motion.div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3 border-t border-white/10 pt-3">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              <span className="text-[9px] text-white/45">24 online</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-cyan-400" />
              <span className="text-[9px] text-white/45">18 active</span>
            </div>
          </div>
        </motion.div>

        {/* Center panel — UNDERSTAND (AI insight, focal point) */}
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.9, delay: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="glass-panel relative overflow-hidden rounded-2xl p-5 shadow-[0_0_40px_rgba(0,180,255,0.12)] sm:z-10 sm:scale-105"
          style={{ transformStyle: 'preserve-3d', perspective: '1200px' }}
        >
          <div className="absolute -right-8 -top-8 h-32 w-32 rounded-full bg-cyan-500/10 blur-[60px]" />
          <div className="relative">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <span className="tech-font text-[10px] font-bold uppercase tracking-[0.22em] text-white/60">
                <BrainCircuit size={11} className="mr-1 inline text-cyan-300" />
                AI Intelligence
              </span>
              <span className="tech-font text-[9px] font-bold uppercase tracking-[0.16em] text-cyan-300">
                Deep Analysis
              </span>
            </div>
            <div className="mt-4 space-y-3">
              <div className="flex items-start gap-2.5">
                <div className="mt-0.5 h-5 w-5 shrink-0 rounded bg-emerald-500/20 flex items-center justify-center">
                  <TrendingUp size={11} className="text-emerald-300" />
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-white/90">Productivity trend improving</p>
                  <p className="text-[10px] text-white/45">Engineering focus increased 12% this week</p>
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <div className="mt-0.5 h-5 w-5 shrink-0 rounded bg-amber-500/20 flex items-center justify-center">
                  <AlertTriangle size={11} className="text-amber-300" />
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-white/90">Context switching detected</p>
                  <p className="text-[10px] text-white/45">3 employees above threshold</p>
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <div className="mt-0.5 h-5 w-5 shrink-0 rounded bg-cyan-500/20 flex items-center justify-center">
                  <Users size={11} className="text-cyan-300" />
                </div>
                <div>
                  <p className="text-[11px] font-semibold text-white/90">Team capacity at 82%</p>
                  <p className="text-[10px] text-white/45">Optimal range for sprint velocity</p>
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2 border-t border-white/10 pt-3">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-300" />
              <span className="tech-font text-[9px] uppercase tracking-[0.16em] text-white/35">
                Generated from measured activity
              </span>
            </div>
          </div>
        </motion.div>

        {/* Right panel — ACT (alert/anomaly) */}
        <motion.div
          initial={{ opacity: 0, x: 20, rotateY: -6 }}
          animate={{ opacity: 1, x: 0, rotateY: 0 }}
          transition={{ duration: 0.9, delay: 1.1, ease: [0.22, 1, 0.36, 1] }}
          className="glass-panel overflow-hidden rounded-2xl p-4 sm:translate-y-4 sm:scale-[0.92]"
          style={{ transformStyle: 'preserve-3d', perspective: '1200px' }}
        >
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <span className="tech-font text-[10px] font-bold uppercase tracking-[0.22em] text-white/60">
              <AlertOctagon size={11} className="mr-1 inline text-amber-300" />
              Anomaly Detected
            </span>
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold text-amber-300">
              HIGH
            </span>
          </div>
          <div className="mt-3 space-y-2.5">
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2.5">
              <p className="text-[11px] font-semibold text-white/90">Off-hours activity</p>
              <p className="text-[10px] text-white/45">Active session detected outside working hours</p>
            </div>
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-2.5">
              <p className="text-[11px] font-semibold text-white/90">Policy breach attempt</p>
              <p className="text-[10px] text-white/45">Restricted application access blocked</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
              <p className="text-[11px] font-semibold text-white/90">Productivity drop</p>
              <p className="text-[10px] text-white/45">Below baseline for 2 consecutive hours</p>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <span className="flex-1 rounded-md bg-white/5 py-1.5 text-center text-[9px] font-bold text-white/60">
              Investigate
            </span>
            <span className="flex-1 rounded-md bg-cyan-500/15 py-1.5 text-center text-[9px] font-bold text-cyan-300">
              Resolve
            </span>
          </div>
        </motion.div>
      </div>
    </div>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────────────
const HEADING_LINES = ['See Everything.', 'Understand Why.', 'Act on Intelligence.'];
const HERO_DEFAULT_SUBTITLE =
  'OmniSight captures workforce activity — applications, websites, screenshots\nand attendance — then transforms it into AI-powered insights your\norganization can actually act on. Every capability is policy-controlled,\nconsent-aware and enforced server-side.';

export function HeroSection() {
  const reduce = useReducedMotion();
  const content = useLandingContent();
  const h = (content.hero ?? {}) as { eyebrow?: string; title?: string[]; subtitle?: string; primaryCta?: string; secondaryCta?: string };
  const headingLines = h.title && h.title.length > 0 ? h.title : HEADING_LINES;
  const subtitle = h.subtitle ?? HERO_DEFAULT_SUBTITLE;
  const primaryLabel = h.primaryCta ?? 'Get Started';
  const secondaryLabel = h.secondaryCta ?? 'Explore Platform';

  return (
    <section className="relative flex min-h-[100dvh] min-h-[700px] flex-col overflow-hidden">
      <AnimatedBackground variant="landing" />

      <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 flex-col items-center px-4 pb-16 pt-28 sm:px-6 sm:pt-32 lg:px-8">
        {/* Eyebrow */}
        <motion.p
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={reduce ? false : { opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="tech-font rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.3em] text-cyan-300/90 backdrop-blur"
        >
          {h.eyebrow ?? 'Workforce Intelligence Platform'}
        </motion.p>

        {/* Heading — staggered line reveal */}
        <h1 className="mt-8 max-w-5xl text-center text-[clamp(44px,8vw,110px)] font-semibold leading-[0.98] tracking-tight text-white">
          {headingLines.map((line, i) => (
            <span key={line} className="block overflow-hidden pb-1">
              <motion.span
                initial={reduce ? false : { opacity: 0, y: '0.6em' }}
                animate={reduce ? false : { opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: 0.15 + i * 0.14, ease: [0.22, 1, 0.36, 1] }}
                className="block"
              >
                {line}
              </motion.span>
            </span>
          ))}
        </h1>

        <motion.p
          initial={reduce ? false : { opacity: 0, y: 18 }}
          animate={reduce ? false : { opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.65 }}
          className="mt-7 max-w-2xl text-center text-base leading-relaxed text-white/55 sm:text-lg"
        >
          {subtitle}
        </motion.p>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={reduce ? false : { opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.8 }}
          className="mt-9 flex flex-col items-center gap-3 sm:flex-row"
        >
          <GlowButton href="#pricing">
            {primaryLabel} <ArrowRight size={15} aria-hidden />
          </GlowButton>
          <GlowButton href="#product" variant="outline">
            {secondaryLabel}
          </GlowButton>
        </motion.div>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 24 }}
          animate={reduce ? false : { opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.95 }}
          className="w-full"
        >
          <HeroVisual />
        </motion.div>
      </div>

      {/* Bottom fade into the page */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-b from-transparent to-black" />
      <p className="sr-only">Synthetic preview dashboard — no real employee data is shown.</p>
    </section>
  );
}