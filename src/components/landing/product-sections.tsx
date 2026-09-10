'use client';

import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  Camera,
  AppWindow,
  Globe,
  Clock3,
  MapPin,
  FolderKanban,
  BrainCircuit,
} from 'lucide-react';
import { Reveal, SectionHeading } from './shared';

// ─── ProductOverview — one platform, complete visibility ───────────────────
const OVERVIEW_CARDS: { icon: ReactNode; title: string; blurb: string }[] = [
  { icon: <Activity size={20} />, title: 'Activity', blurb: 'Live activity streams across every connected device.' },
  { icon: <Camera size={20} />, title: 'Screenshots', blurb: 'Policy-controlled visual evidence on a schedule you define.' },
  { icon: <AppWindow size={20} />, title: 'Applications', blurb: 'See which applications are in use and when.' },
  { icon: <Globe size={20} />, title: 'Websites', blurb: 'Understand browsing patterns within operational context.' },
  { icon: <Clock3 size={20} />, title: 'Attendance', blurb: 'Presence, sessions and working patterns across the org.' },
  { icon: <MapPin size={20} />, title: 'Location', blurb: 'Authorized location signals from supported devices.' },
  { icon: <FolderKanban size={20} />, title: 'Projects', blurb: 'Connect workforce activity to projects and tasks.' },
  { icon: <BrainCircuit size={20} />, title: 'AI Insights', blurb: 'Workforce signals turned into structured intelligence.' },
];

export function ProductOverview() {
  const reduce = useReducedMotion();
  return (
    <section id="product" className="relative mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <SectionHeading
        copyKey="overview"
        eyebrow="Product Overview"
        title={
          <>
            One platform.
            <br />
            Complete workforce visibility.
          </>
        }
        subtitle="From real-time activity to long-term workforce intelligence, OmniSight brings the signals that matter into one operational view."
      />

      <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {OVERVIEW_CARDS.map((card, i) => (
          <Reveal key={card.title} delay={(i % 4) * 0.08} className="h-full">
            <motion.div
              whileHover={reduce ? undefined : { scale: 1.02, y: -4 }}
              transition={{ type: 'spring', stiffness: 320, damping: 24 }}
              className="glass-panel group h-full rounded-2xl p-6 transition-colors hover:border-cyan-300/30"
            >
              <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-cyan-300 transition-colors group-hover:border-cyan-300/30 group-hover:text-cyan-200">
                {card.icon}
              </div>
              <h3 className="mt-4 text-[15px] font-semibold text-white">{card.title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-white/50">{card.blurb}</p>
            </motion.div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

// ─── LiveActivityPreview — synthetic realtime surface ──────────────────────
const STATUS_CHIPS = [
  { label: 'ONLINE', count: 24, tone: 'text-emerald-300 border-emerald-400/30' },
  { label: 'ACTIVE', count: 18, tone: 'text-cyan-300 border-cyan-400/30' },
  { label: 'IDLE', count: 4, tone: 'text-amber-300 border-amber-400/30' },
  { label: 'AWAY', count: 2, tone: 'text-white/50 border-white/20' },
];

const STREAM = [
  { time: '10:41:02', name: 'Rimon', app: 'VS Code', tag: 'Active', tone: 'text-cyan-300' },
  { time: '10:41:08', name: 'Tanvir', app: 'Chrome', tag: 'Research', tone: 'text-emerald-300' },
  { time: '10:41:14', name: 'Nabila', app: 'Figma', tag: 'Designing', tone: 'text-cyan-300' },
  { time: '10:41:21', name: 'Hasan', app: 'Slack', tag: 'Comm.', tone: 'text-amber-300' },
  { time: '10:41:29', name: 'Sadia', app: 'Notion', tag: 'Writing', tone: 'text-cyan-300' },
  { time: '10:41:37', name: 'Rafi', app: 'Terminal', tag: 'Active', tone: 'text-emerald-300' },
];

export function LiveActivityPreview() {
  return (
    <section id="live" className="relative overflow-hidden border-y border-white/10 bg-white/[0.015] py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          copyKey="live"
          eyebrow="Live Workforce Visibility"
          title={
            <>
              Know what is happening.
              <br />
              While it is happening.
            </>
          }
          subtitle="Organization-scoped realtime presence — online, active, idle and away states stream as they change. Synthetic preview below."
        />

        <div className="mx-auto mt-14 max-w-4xl">
          <Reveal>
            <div className="glass-panel overflow-hidden rounded-2xl">
              {/* Status chips */}
              <div className="grid grid-cols-2 gap-2 border-b border-white/10 p-4 sm:grid-cols-4">
                {STATUS_CHIPS.map((s) => (
                  <div
                    key={s.label}
                    className={`rounded-lg border bg-white/[0.03] px-3 py-2.5 text-center ${s.tone}`}
                  >
                    <p className="tech-font text-[10px] font-bold uppercase tracking-[0.2em]">{s.label}</p>
                    <p className="mt-1 text-xl font-semibold text-white">{s.count}</p>
                  </div>
                ))}
              </div>

              {/* Timeline */}
              <div className="overflow-hidden p-4">
                <div className="omni-marquee flex w-max gap-3">
                  {[...STREAM, ...STREAM].map((row, i) => (
                    <div
                      key={i}
                      className="flex w-64 shrink-0 items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5 text-[12px]"
                    >
                      <span className="tech-font text-white/35">{row.time}</span>
                      <span className="text-white/85">{row.name}</span>
                      <span className="max-w-[90px] truncate text-white/50">{row.app}</span>
                      <span className={`tech-font font-bold ${row.tone}`}>{row.tag}</span>
                    </div>
                  ))}
                </div>
              </div>

              <p className="px-4 pb-4 text-[11px] text-white/30">
                Illustrative synthetic activity — never real employee data.
              </p>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// ─── FeatureSection — monitoring capabilities ──────────────────────────────
const FEATURES: { icon: ReactNode; title: string; body: string }[] = [
  { icon: <Activity size={22} />, title: 'Activity Monitoring', body: 'Understand how work is actually happening — applications, processes and engagement across the day.' },
  { icon: <AppWindow size={22} />, title: 'Application Tracking', body: 'See which applications are being used and when, with org-scoped usage signals.' },
  { icon: <Globe size={22} />, title: 'Website Tracking', body: 'Understand browsing patterns without losing operational context.' },
  { icon: <Camera size={22} />, title: 'Screenshots', body: 'Capture periodic visual evidence according to organization policy — never silently.' },
  { icon: <Clock3 size={22} />, title: 'Attendance', body: 'Understand presence, sessions and working patterns across your organization.' },
  { icon: <MapPin size={22} />, title: 'Location', body: 'Track authorized workforce location signals from supported devices.' },
  { icon: <FolderKanban size={22} />, title: 'Projects & Tasks', body: 'Connect workforce activity with projects and operational work.' },
  { icon: <BrainCircuit size={22} />, title: 'AI Insights', body: 'Turn workforce signals into actionable intelligence — trends, anomalies and summaries.' },
];

export function FeatureSection() {
  const reduce = useReducedMotion();
  return (
    <section id="features" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <SectionHeading
        copyKey="features"
        eyebrow="Monitoring Capabilities"
        title="Everything your organization needs to understand work."
        subtitle="Each capability is policy-controlled, consent-aware and enforced server-side."
      />
      <div className="mt-14 grid grid-cols-1 gap-5 md:grid-cols-2">
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={(i % 2) * 0.1}>
            <motion.div
              whileHover={reduce ? undefined : { scale: 1.02, y: -4 }}
              transition={{ type: 'spring', stiffness: 320, damping: 24 }}
              className="glass-panel group flex h-full gap-5 rounded-2xl p-7 transition-colors hover:border-cyan-300/30"
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-cyan-300 transition-colors group-hover:text-cyan-200">
                {f.icon}
              </div>
              <div>
                <h3 className="text-[16px] font-semibold text-white">{f.title}</h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-white/50">{f.body}</p>
              </div>
            </motion.div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}