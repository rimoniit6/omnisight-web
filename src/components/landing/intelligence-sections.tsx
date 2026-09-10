'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { Camera, TrendingUp, Users, AlertTriangle, Activity, ArrowDown } from 'lucide-react';
import { Reveal, SectionHeading } from './shared';

// ─── ScreenshotPreview — policy-controlled capture surface ─────────────────
const SHOT_TIMES = ['09:00', '09:10', '09:20', '09:30'];

export function ScreenshotPreview() {
  const reduce = useReducedMotion();
  return (
    <section id="screenshots" className="relative overflow-hidden border-y border-white/10 bg-white/[0.015] py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <Reveal>
            <SectionHeading
              copyKey="screenshot"
              align="left"
              eyebrow="Screenshot Monitoring"
              title="Periodic visual evidence. Policy controlled."
              subtitle="Screenshot capture runs on an organization-defined schedule with explicit retention policy. Frequency and retention are separate settings — and both are enforced server-side, never decided by a device."
            />
            <div className="mt-8 flex flex-wrap gap-2.5">
              {['Policy: Every 10 minutes', 'Retention: Organization policy', 'Status: Active'].map((c) => (
                <span
                  key={c}
                  className="tech-font rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-white/70"
                >
                  {c}
                </span>
              ))}
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="glass-panel rounded-2xl p-6">
              <div className="flex items-center justify-between border-b border-white/10 pb-4">
                <span className="tech-font text-[11px] font-bold uppercase tracking-[0.22em] text-white/70">
                  <Camera size={13} className="mr-1.5 inline text-cyan-300" aria-hidden />
                  Capture timeline
                </span>
                <span className="tech-font text-[10px] uppercase tracking-[0.18em] text-emerald-300">
                  Policy active
                </span>
              </div>
              <div className="flex items-center justify-between pt-8">
                {SHOT_TIMES.map((t, i) => (
                  <div key={t} className="flex flex-1 flex-col items-center">
                    <motion.span
                      initial={reduce ? false : { scale: 0 }}
                      whileInView={reduce ? undefined : { scale: 1 }}
                      viewport={{ once: true }}
                      transition={{ delay: 0.3 + i * 0.15, type: 'spring', stiffness: 260, damping: 16 }}
                      className="mb-3 inline-block h-3 w-3 rounded-full bg-cyan-300 shadow-[0_0_10px_rgba(0,212,255,0.7)]"
                    />
                    <span className="tech-font text-[10px] font-bold tracking-wider text-white/50">{t}</span>
                    {i < SHOT_TIMES.length - 1 && (
                      <span className="absolute h-px w-[25%] translate-x-[150%] bg-gradient-to-r from-cyan-300/50 to-transparent" />
                    )}
                  </div>
                ))}
              </div>
              {/* Synthetic thumbnails */}
              <div className="mt-8 grid grid-cols-3 gap-3">
                {[
                  ['bg-gradient-to-br from-slate-700/70 to-slate-900/70', 'Editor'],
                  ['bg-gradient-to-br from-indigo-900/60 to-slate-900/70', 'Docs'],
                  ['bg-gradient-to-br from-slate-800/70 to-slate-950/80', 'Terminal'],
                ].map(([bg, label]) => (
                  <div
                    key={label}
                    className={`aspect-[4/3] rounded-lg border border-white/10 ${bg} p-2`}
                  >
                    <div className="mb-1.5 h-1 w-1/3 rounded bg-white/15" />
                    <div className="mb-1 h-1 w-2/3 rounded bg-white/10" />
                    <div className="h-1 w-1/2 rounded bg-white/10" />
                    <p className="tech-font mt-1 text-[9px] uppercase tracking-wider text-white/35">{label}</p>
                  </div>
                ))}
              </div>
              <p className="mt-4 text-[11px] text-white/30">
                Illustrative synthetic thumbnails — screenshots only ever appear per organization policy.
              </p>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// ─── AIInsightPreview — synthetic analysis panel ───────────────────────────
const INSIGHT_ROWS = [
  { icon: <TrendingUp size={15} />, label: 'Focus trend', value: '↑ 12%', tone: 'text-emerald-300' },
  { icon: <Users size={15} />, label: 'Active workforce', value: '18', tone: 'text-cyan-300' },
  { icon: <AlertTriangle size={15} />, label: 'Attention shift', value: 'Detected', tone: 'text-amber-300' },
  { icon: <Activity size={15} />, label: 'Project momentum', value: 'Improving', tone: 'text-emerald-300' },
];

export function AIInsightPreview() {
  return (
    <section id="ai" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <SectionHeading
        copyKey="ai"
        eyebrow="AI Workforce Intelligence"
        title={
          <>
            Raw activity is data.
            <br />
            Intelligence is the advantage.
          </>
        }
        subtitle="OmniSight transforms workforce signals into structured insights that help organizations understand productivity, operational patterns and emerging trends."
      />

      <div className="mx-auto mt-14 grid max-w-4xl gap-5 md:grid-cols-[1fr_1.1fr]">
        <Reveal>
          <div className="glass-panel h-full rounded-2xl p-6">
            <p className="tech-font mb-5 text-[10px] font-bold uppercase tracking-[0.24em] text-white/50">
              Workforce insight
            </p>
            <div className="space-y-4">
              {INSIGHT_ROWS.map((r) => (
                <div key={r.label} className="flex items-center justify-between text-[13px]">
                  <span className="flex items-center gap-2 text-white/60">
                    <span className="text-cyan-300/80">{r.icon}</span>
                    {r.label}
                  </span>
                  <span className={`tech-font font-bold ${r.tone}`}>{r.value}</span>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="glass-panel h-full rounded-2xl p-6">
            <p className="tech-font mb-4 text-[10px] font-bold uppercase tracking-[0.24em] text-white/50">
              AI summary
            </p>
            <p className="text-[14px] leading-relaxed text-white/70">
              Engineering activity increased during the afternoon session while
              context switching decreased across the monitored workspace.
            </p>
            <div className="mt-6 flex items-center gap-2 border-t border-white/10 pt-4">
              <span className="tech-font inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />
              <span className="tech-font text-[10px] uppercase tracking-[0.18em] text-white/40">
                Generated from measured activity
              </span>
            </div>
          </div>
        </Reveal>
      </div>
      <p className="mx-auto mt-5 max-w-xl text-center text-[11px] text-white/30">
        Illustrative synthetic demonstration data — AI never invents metrics.
      </p>
    </section>
  );
}

// ─── ArchitectureSection — Agent → API → Tenant → Control → Intelligence ───
const NODES = [
  { label: 'AGENT', sub: 'Runs on organization devices' },
  { label: 'SECURE API', sub: 'Authenticated, server-authoritative' },
  { label: 'TENANT DATA', sub: 'Organization-scoped by design' },
  { label: 'CONTROL CENTER', sub: 'Role-based admin workspace' },
  { label: 'INTELLIGENCE', sub: 'Insights, reports, analytics' },
];

export function ArchitectureSection() {
  const reduce = useReducedMotion();
  return (
    <section id="how" className="relative overflow-hidden border-y border-white/10 bg-white/[0.015] py-24">
      <div className="mx-auto max-w-5xl px-4 text-center sm:px-6 lg:px-8">
        <SectionHeading
          copyKey="architecture"
          eyebrow="How OmniSight Works"
          title="Your workforce signals. Your organization. Your control."
          subtitle="One agent communicates only with the OmniSight API. Tenant identity is resolved server-side — devices never touch a database directly."
        />

        <div className="mt-14 flex flex-col items-center gap-0">
          {NODES.map((node, i) => (
            <Reveal key={node.label} delay={i * 0.1} className="w-full max-w-md">
              <motion.div
                whileHover={reduce ? undefined : { scale: 1.03 }}
                transition={{ type: 'spring', stiffness: 300, damping: 22 }}
                className="glass-panel mx-auto w-full rounded-2xl px-6 py-5"
              >
                <p className="tech-font text-[13px] font-bold tracking-[0.22em] text-cyan-300">
                  {node.label}
                </p>
                <p className="mt-1 text-[12px] text-white/50">{node.sub}</p>
              </motion.div>
              {i < NODES.length - 1 && (
                <div className="flex justify-center py-1.5" aria-hidden>
                  <motion.span
                    animate={reduce ? undefined : { y: [0, 5, 0], opacity: [0.4, 1, 0.4] }}
                    transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                    className="text-cyan-300/60"
                  >
                    <ArrowDown size={18} />
                  </motion.span>
                </div>
              )}
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}