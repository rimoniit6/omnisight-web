'use client';

import Link from 'next/link';
import { motion, useScroll, useTransform } from 'framer-motion';
import { ArrowRight, ShieldCheck, Video } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const STATS = [
  { value: '10k+', label: 'Teams Trust Us' },
  { value: '99.9%', label: 'Uptime' },
  { value: 'GDPR', label: 'Compliant' },
];

export function AnimatedHero() {
  const { scrollY } = useScroll();
  const yTitle = useTransform(scrollY, [0, 500], [0, 120]);
  const opacity = useTransform(scrollY, [0, 400], [1, 0]);

  return (
    <section className="relative overflow-hidden">
      {/* Gradient / parallax background */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top_left,rgba(16,185,129,0.14),transparent_55%),radial-gradient(ellipse_at_top_right,rgba(99,102,241,0.12),transparent_55%)]"
      />
      <motion.div style={{ y: yTitle, opacity }} className="mx-auto max-w-6xl px-4 pb-16 pt-20 text-center sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mb-6 inline-flex"
        >
          <Badge variant="secondary" className="gap-2 px-3 py-1.5">
            <ShieldCheck className="h-4 w-4" />
            Self-hosted available · Your data, your servers
          </Badge>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.1 }}
          className="mx-auto max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl"
        >
          Workforce Intelligence,{' '}
          <span className="bg-gradient-to-r from-emerald-500 to-indigo-500 bg-clip-text text-transparent">
            Built for Privacy.
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.2 }}
          className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground"
        >
          OmniSight gives you real-time activity monitoring, AI-powered
          insights, and granular policy control — with a self-hosted option so
          your data stays on your own servers.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
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
            <a href="#how-it-works">
              <Video className="mr-2 h-4 w-4" />
              Watch Demo
            </a>
          </Button>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.4 }}
          className="mt-4 text-sm text-muted-foreground"
        >
          No credit card required · Set up in minutes
        </motion.p>

        {/* Trust / stats */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.5 }}
          className="mt-14 grid grid-cols-3 gap-4 border-t border-border/60 pt-8"
        >
          {STATS.map((stat) => (
            <div key={stat.label} className="text-center">
              <div className="text-2xl font-bold text-foreground sm:text-3xl">{stat.value}</div>
              <div className="mt-1 text-sm text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </motion.div>
      </motion.div>
    </section>
  );
}
