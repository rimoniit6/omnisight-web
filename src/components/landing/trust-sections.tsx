'use client';

import { ShieldCheck, Server, Database, Fingerprint } from 'lucide-react';
import { Reveal, SectionHeading } from './shared';

// ─── SecuritySection — honest enterprise security claims only ──────────────
const SECURITY_ITEMS = [
  { title: 'Organization isolation', body: 'Operational data is tenant-scoped — one organization can never read another.' },
  { title: 'Role-based access', body: 'Granular permissions from viewer to organization admin, enforced server-side.' },
  { title: 'Server-side authorization', body: 'Identity and tenant are always derived from verified sessions, never client input.' },
  { title: 'Deployment-aware access', body: 'Access follows the organization deployment mode — including Super Admin privacy boundaries.' },
  { title: 'Policy-controlled screenshots', body: 'Capture frequency and retention are organization policy, enforced at the API.' },
  { title: 'Encrypted configuration', body: 'Sensitive settings are encrypted at rest and never returned to clients.' },
];

export function SecuritySection() {
  return (
    <section id="security" className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
      <SectionHeading
        copyKey="security"
        eyebrow="Security & Privacy"
        title="Visibility without losing control."
        subtitle="Monitoring is only useful when it is trustworthy. OmniSight is architected so access, data and policies are enforced at the platform layer."
      />

      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SECURITY_ITEMS.map((item, i) => (
          <Reveal key={item.title} delay={(i % 3) * 0.08}>
            <div className="glass-panel h-full rounded-2xl p-6 transition-colors hover:border-white/25">
              <ShieldCheck size={18} className="text-cyan-300" aria-hidden />
              <h3 className="mt-3.5 text-[15px] font-semibold text-white">{item.title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-white/50">{item.body}</p>
            </div>
          </Reveal>
        ))}
      </div>

      <Reveal className="mx-auto mt-12 max-w-3xl">
        <p className="text-center text-[12.5px] leading-relaxed text-white/40">
          OmniSight publishes only the security properties it verifies in its own
          architecture. No unverified compliance certifications are claimed.
        </p>
      </Reveal>
    </section>
  );
}

// ─── DeploymentModes — V1 active modes: MANAGED / CUSTOMER_DB ──────────────
// PRIVATE is not a V1 customer-facing option. Future enterprise/self-hosted
// architecture may be introduced in a later version.
const MODES = [
  {
    name: 'OmniSight Managed',
    icon: <Server size={20} />,
    headline: 'OmniSight-managed infrastructure.',
    body: 'Fastest deployment with centralized administration — OmniSight hosts and operates the platform, database, and storage.',
    points: ['Zero infrastructure setup', 'Centralized administration', 'OmniSight-operated', 'Fully managed database and storage'],
  },
  {
    name: 'Customer Database',
    icon: <Database size={20} />,
    headline: 'Your data infrastructure. Our application.',
    body: 'The OmniSight application runs the platform while your organization controls the primary data infrastructure.',
    points: ['Customer-controlled primary DB', 'OmniSight-managed application', 'Operational data stays customer-side', 'Configure after onboarding'],
  },
];

export function DeploymentModes() {
  return (
    <section id="deployment" className="relative overflow-hidden border-y border-white/10 bg-white/[0.015] py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          copyKey="deployment"
          eyebrow="Deployment Modes"
          title="Choose the way your organization runs."
          subtitle="One OmniSight platform, two deployment models — the organization record always decides the runtime mode, never the device."
        />

        <div className="mt-14 mx-auto grid max-w-3xl grid-cols-1 gap-5 sm:grid-cols-2">
          {MODES.map((mode, i) => (
            <Reveal key={mode.name} delay={i * 0.1} className="h-full">
              <div className="glass-panel group flex h-full flex-col rounded-2xl p-7 transition-colors hover:border-cyan-300/30">
                <div className="flex items-center justify-between">
                  <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-cyan-300">
                    {mode.icon}
                  </span>
                  <span className="tech-font text-[10px] font-bold uppercase tracking-[0.22em] text-white/40">
                    Mode 0{i + 1}
                  </span>
                </div>
                <h3 className="tech-font mt-6 text-[15px] font-bold tracking-[0.14em] text-cyan-300">
                  {mode.name}
                </h3>
                <p className="mt-2 text-[15px] font-semibold text-white">{mode.headline}</p>
                <p className="mt-2 text-[13px] leading-relaxed text-white/50">{mode.body}</p>
                <ul className="mt-5 space-y-2 border-t border-white/10 pt-5">
                  {mode.points.map((p) => (
                    <li key={p} className="flex items-center gap-2 text-[12.5px] text-white/60">
                      <span className="h-1 w-1 rounded-full bg-cyan-300" aria-hidden />
                      {p}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
