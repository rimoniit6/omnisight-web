'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Activity, Globe, Camera, Zap } from 'lucide-react';
import { AnimatedBackground } from './AnimatedBackground';
import { GlowButton, useLandingContent } from './shared';

// ─── Synthetic hero dashboard visual (clearly illustrative, no real data) ──
function HeroDashboard() {
  const rows = [
    { name: 'Rimon', app: 'VS Code', tag: 'Working', tone: 'text-cyan-300' },
    { name: 'Tanvir', app: 'Chrome', tag: 'Research', tone: 'text-emerald-300' },
    { name: 'Nabila', app: 'Figma', tag: 'Designing', tone: 'text-cyan-300' },
    { name: 'Hasan', app: 'Slack', tag: 'Comm.', tone: 'text-amber-300' },
  ];
  const apps = [
    { name: 'Chrome', pct: 82, tone: 'bg-cyan-400/80' },
    { name: 'VS Code', pct: 64, tone: 'bg-sky-400/80' },
    { name: 'Slack', pct: 47, tone: 'bg-indigo-400/70' },
    { name: 'Figma', pct: 38, tone: 'bg-emerald-400/70' },
  ];

  return (
    <div className="omni-float relative mx-auto mt-14 w-full max-w-3xl" aria-hidden>
      <div className="glass-panel relative overflow-hidden p-5 sm:p-6">
        {/* Header bar */}
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <span className="tech-font text-[11px] font-bold uppercase tracking-[0.24em] text-white/70">
            OmniSight
          </span>
          <span className="tech-font inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-emerald-300">
            <span className="omni-pulse inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Live
          </span>
        </div>

        <div className="grid gap-5 pt-5 sm:grid-cols-[1.15fr_1fr]">
          {/* Left: online + activity bars */}
          <div>
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-semibold tracking-tight text-white">24</span>
              <span className="tech-font text-[10px] font-bold uppercase tracking-[0.22em] text-white/45">
                Employees online
              </span>
            </div>
            <p className="tech-font mt-1 text-[10px] uppercase tracking-[0.18em] text-white/35">
              Synthetic preview
            </p>

            <div className="mt-5 space-y-3">
              {apps.map((a) => (
                <div key={a.name}>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-white/70">{a.name}</span>
                    <span className="tech-font text-white/40">{a.pct}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${a.pct}%` }}
                      transition={{ duration: 1.2, delay: 0.6, ease: 'easeOut' }}
                      className={`h-full rounded-full ${a.tone}`}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Right: live activity rows */}
          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
            <p className="tech-font mb-3 text-[10px] font-bold uppercase tracking-[0.22em] text-white/45">
              Live activity
            </p>
            <div className="space-y-2.5">
              {rows.map((r, i) => (
                <motion.div
                  key={r.name}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.5 + i * 0.12 }}
                  className="flex items-center justify-between gap-2 text-[11px]"
                >
                  <span className="text-white/85">{r.name}</span>
                  <span className="text-white/45">{r.app}</span>
                  <span className={`tech-font ${r.tone}`}>{r.tag}</span>
                </motion.div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom stat chips */}
        <div className="mt-5 grid grid-cols-3 gap-2 border-t border-white/10 pt-4">
          {[
            { icon: Activity, label: 'Productivity', value: 'Real-time' },
            { icon: Globe, label: 'Websites', value: 'Tracked' },
            { icon: Camera, label: 'Screenshots', value: 'Policy' },
          ].map((s) => (
            <div key={s.label} className="flex items-center gap-2">
              <s.icon size={14} className="shrink-0 text-cyan-300/80" aria-hidden />
              <div className="min-w-0">
                <p className="truncate text-[10px] text-white/40">{s.label}</p>
                <p className="tech-font truncate text-[10px] font-bold uppercase tracking-wider text-white/75">
                  {s.value}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Floating corner chips */}
      <div className="absolute -right-3 -top-3 hidden rounded-full border border-white/15 bg-black/70 px-3 py-1.5 sm:block">
        <span className="tech-font text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300">
          <Zap size={11} className="mr-1 inline" aria-hidden />
          Real-time
        </span>
      </div>
    </div>
  );
}

// ─── Hero ──────────────────────────────────────────────────────────────────
const HEADING_LINES = ['Understand How Work Happens.', 'Monitor Activity.', 'Protect Productivity.'];
const HERO_DEFAULT_SUBTITLE =
  'OmniSight gives organizations real-time visibility into workforce\nactivity, productivity, applications, websites, screenshots, attendance\nand operational performance — all from one secure control center.';

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
          <HeroDashboard />
        </motion.div>
      </div>

      {/* Bottom fade into the page */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-b from-transparent to-black" />
      <p className="sr-only">Synthetic preview dashboard — no real employee data is shown.</p>
    </section>
  );
}