'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { Activity, BrainCircuit, Circle, Camera } from 'lucide-react';
import { useEffect, useState } from 'react';

const PRESENCE = [
  { name: 'Rimon', status: 'Active', app: 'Coding' },
  { name: 'Sarah', status: 'Active', app: 'Designing' },
  { name: 'John', status: 'Away', app: 'Meeting' },
];

function Counter({ to }: { to: number }) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const duration = 1400;
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1);
      setValue(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return <>{value}</>;
}

export function DashboardPreview() {
  const reduce = useReducedMotion();

  return (
    <div className="relative mx-auto mt-14 max-w-5xl">
      {/* Glow behind the preview */}
      <div
        aria-hidden
        className="absolute -inset-x-8 -top-10 -bottom-6 -z-10 rounded-[2rem] bg-[radial-gradient(ellipse_at_center,rgba(16,185,129,0.18),transparent_65%)] blur-2xl"
      />

      <motion.div
        initial={{ opacity: 0, y: 32 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.3, ease: 'easeOut' }}
        className="overflow-hidden rounded-2xl border border-border/70 bg-background/80 shadow-2xl backdrop-blur"
      >
        {/* Window chrome */}
        <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full bg-rose-400/80" />
            <span className="h-3 w-3 rounded-full bg-amber-400/80" />
            <span className="h-3 w-3 rounded-full bg-emerald-400/80" />
          </div>
          <span className="text-xs font-semibold tracking-wide text-muted-foreground">OmniSight</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600">
            <Circle className="h-2 w-2 fill-current" />
            LIVE
          </span>
        </div>

        {/* Body */}
        <div className="grid grid-cols-1 gap-4 p-4 sm:p-6 md:grid-cols-3">
          {/* Metric cards */}
          <motion.div
            whileHover={reduce ? undefined : { y: -3 }}
            className="rounded-xl border border-border/60 bg-background p-4"
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium">Employees Online</span>
              <Activity className="h-4 w-4 text-primary" />
            </div>
            <p className="mt-2 text-3xl font-bold text-foreground">
              <Counter to={24} />
            </p>
          </motion.div>

          <motion.div
            whileHover={reduce ? undefined : { y: -3 }}
            className="rounded-xl border border-border/60 bg-background p-4"
          >
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-medium">Productivity</span>
              <BrainCircuit className="h-4 w-4 text-primary" />
            </div>
            <p className="mt-2 text-3xl font-bold text-foreground">
              <Counter to={87} />
              <span className="text-base font-semibold text-muted-foreground">%</span>
            </p>
          </motion.div>

          {/* Live presence + AI insight stacked */}
          <div className="flex flex-col gap-4">
            <div className="rounded-xl border border-border/60 bg-background p-4">
              <div className="text-xs font-medium text-muted-foreground mb-2">Live Activity</div>
              <ul className="space-y-2">
                {PRESENCE.map((person, i) => (
                  <motion.li
                    key={person.name}
                    initial={reduce ? false : { opacity: 0, x: 12 }}
                    animate={reduce ? false : { opacity: 1, x: 0 }}
                    transition={{ delay: 0.6 + i * 0.15 }}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="flex items-center gap-2 font-medium text-foreground">
                      <span
                        className={
                          person.status === 'Active'
                            ? 'h-2 w-2 rounded-full bg-emerald-500'
                            : 'h-2 w-2 rounded-full bg-amber-400'
                        }
                      />
                      {person.name}
                    </span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {person.app}
                      {person.app === 'Coding' && <Camera className="h-3 w-3 text-muted-foreground/60" />}
                    </span>
                  </motion.li>
                ))}
              </ul>
            </div>

            <motion.div
              initial={reduce ? false : { opacity: 0, y: 12 }}
              animate={reduce ? false : { opacity: 1, y: 0 }}
              transition={{ delay: 0.95, duration: 0.5 }}
              className="rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 to-primary/5 p-4"
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
                <BrainCircuit className="h-3.5 w-3.5" />
                AI Insight
              </div>
              <p className="mt-1.5 text-sm text-foreground">
                Engineering productivity increased 14% this week.
              </p>
            </motion.div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
