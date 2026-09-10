'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

// ─── OmniSightLogo ─────────────────────────────────────────────────────────
// Official brand mark (public/logos/omnisight.svg) + optional wordmark.
// Always renders the OFFICIAL logo — never a redesign.
export function OmniSightLogo({
  href = '/',
  className,
  wordmark = 'OmniSight',
  showWordmark = true,
  size = 32,
}: {
  href?: string;
  className?: string;
  wordmark?: string;
  showWordmark?: boolean;
  size?: number;
}) {
  const content = (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <span className="relative inline-block" style={{ width: size, height: size }}>
        <Image
          src="/logos/omnisight.svg"
          alt={`${wordmark} logo`}
          fill
          sizes={`${size}px`}
          className="object-contain drop-shadow-[0_0_12px_rgba(0,212,255,0.35)]"
          priority
          unoptimized
        />
      </span>
      {showWordmark && (
        <span className="text-[17px] font-semibold tracking-tight text-white">
          {wordmark}
        </span>
      )}
    </span>
  );

  if (href) {
    return (
      <Link href={href} aria-label={`${wordmark} home`} className="shrink-0">
        {content}
      </Link>
    );
  }
  return content;
}

// ─── Reveal — scroll-triggered entrance ────────────────────────────────────
export function Reveal({
  children,
  delay = 0,
  y = 24,
  className,
  amount = 0.2,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  amount?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, amount }}
      transition={{ duration: 0.6, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

// ─── ScrambleText — fast subtle character scramble on trigger ──────────────
const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';

export function ScrambleText({
  text,
  className,
  trigger = 'hover',
  speed = 28,
}: {
  text: string;
  className?: string;
  /** 'hover' scrambles on pointer-enter; 'view' scrambles once when scrolled into view */
  trigger?: 'hover' | 'view';
  speed?: number;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(text);
  const startedRef = useRef(false);
  const frameRef = useRef<number | null>(null);

  const runScramble = () => {
    if (reduce || startedRef.current) return;
    startedRef.current = true;
    const target = text;
    let frame = 0;
    // Higher `speed` = faster resolve (fewer frames per char).
    const total = Math.min(target.length, Math.max(2, Math.round(speed / 2)));
    const tick = () => {
      frame += 1;
      const progress = Math.min(1, frame / total);
      const resolved = target
        .split('')
        .map((ch, i) => {
          if (ch === ' ') return ' ';
          if (i / target.length < progress * 1.15) return ch;
          return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
        })
        .join('');
      setDisplay(resolved);
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(tick);
      }
    };
    frameRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    if (reduce) {
      setDisplay(text);
      return;
    }
    if (trigger === 'view' && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) {
            runScramble();
            io.disconnect();
          }
        },
        { threshold: 0.6 }
      );
      if (ref.current) io.observe(ref.current);
      return () => io.disconnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, text, reduce]);

  useEffect(
    () => () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  return (
    <span
      ref={ref}
      className={cn('omni-scramble tech-font', className)}
      onMouseEnter={trigger === 'hover' ? runScramble : undefined}
    >
      {display}
    </span>
  );
}

// ─── Landing content overrides (public read; Super Admin-managed) ──────────
/**
 * Load the Super Admin-managed landing copy overrides once (shared query key,
 * so every section that reads it shares a single request). Returns an empty
 * document when nothing has been saved — sections then render their defaults.
 */
export function useLandingContent(): Record<string, unknown> {
  const { data } = useQuery<Record<string, unknown>>({
    queryKey: ['landing-content'],
    queryFn: async () => {
      const res = await fetch('/api/landing');
      if (!res.ok) return {};
      const json = (await res.json().catch(() => ({}))) as { content?: unknown };
      const content = json?.content;
      return content && typeof content === 'object' ? (content as Record<string, unknown>) : {};
    },
    staleTime: 5 * 60 * 1000,
  });
  return data ?? {};
}

// ─── SectionHeading — eyebrow + title + subtitle block ─────────────────────
export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = 'center',
  copyKey,
}: {
  eyebrow: string;
  title: ReactNode;
  subtitle?: string;
  align?: 'center' | 'left';
  /** Landing content section whose overrides replace these defaults. */
  copyKey?: string;
}) {
  // Read once per heading — the shared query key dedupes the fetch across the
  // whole landing page, so this is one request regardless of section count.
  const content = useLandingContent();
  const block = copyKey ? (content[copyKey] as { eyebrow?: string; title?: string; subtitle?: string } | undefined) : undefined;
  const eyebrowText = block?.eyebrow ?? eyebrow;
  const titleNode: ReactNode = block?.title ?? title;
  const subtitleText = block?.subtitle ?? subtitle;
  return (
    <Reveal
      className={cn(
        'max-w-3xl',
        align === 'center' ? 'mx-auto text-center' : 'text-left'
      )}
    >
      <p className="tech-font text-[11px] font-bold uppercase tracking-[0.28em] text-cyan-300/80">
        {eyebrowText}
      </p>
      <h2 className="mt-4 text-3xl font-semibold leading-[1.1] tracking-tight text-white sm:text-4xl md:text-[44px]">
        {titleNode}
      </h2>
      {subtitleText && (
        <p className="mt-4 text-base leading-relaxed text-white/55 sm:text-lg">
          {subtitleText}
        </p>
      )}
    </Reveal>
  );
}

// ─── GlowButton — cinematic CTA (white primary / outline secondary) ────────
export function GlowButton({
  children,
  href,
  onClick,
  variant = 'primary',
  className,
  type,
}: {
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  variant?: 'primary' | 'outline';
  className?: string;
  type?: 'button' | 'submit';
}) {
  const classes = cn(
    'tech-font inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-[13px] font-bold uppercase tracking-[0.14em] transition-all duration-200 select-none',
    variant === 'primary'
      ? 'bg-white text-black hover:scale-[1.02] hover:bg-white/90 active:scale-[0.98]'
      : 'border border-white/20 bg-white/5 text-white hover:border-white/40 hover:bg-white/10 active:scale-[0.98]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
    className
  );

  if (href) {
    return (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type ?? 'button'} onClick={onClick} className={classes}>
      {children}
    </button>
  );
}