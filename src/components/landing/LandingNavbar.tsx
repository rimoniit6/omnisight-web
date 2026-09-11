'use client';

import { useEffect, useState } from 'react';
import { useReducedMotion, motion, AnimatePresence } from 'framer-motion';
import { Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { OmniSightLogo, ScrambleText } from './shared';

const NAV_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#live', label: 'Live' },
  { href: '#ai', label: 'AI' },
  { href: '#security', label: 'Security' },
  { href: '#deployment', label: 'Deployment' },
  { href: '#pricing', label: 'Pricing' },
];

export function LandingNavbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string>('');
  const reduce = useReducedMotion();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Active-section indication via IntersectionObserver (no scroll-spy math).
  useEffect(() => {
    const ids = NAV_LINKS.map((l) => l.href.slice(1));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id);
        }
      },
      { rootMargin: '-40% 0px -55% 0px' }
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  const scrollTo = (href: string) => {
    setOpen(false);
    document.querySelector(href)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <header
      role="banner"
      className={cn(
        'fixed inset-x-0 top-0 z-50 transition-all duration-300',
        scrolled
          ? 'border-b border-white/10 bg-black/60 backdrop-blur-xl'
          : 'border-b border-transparent bg-transparent'
      )}
    >
      <nav
        className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8"
        aria-label="Primary"
      >
        <OmniSightLogo />

        {/* Desktop nav */}
        <div className="hidden items-center gap-1 md:flex">
          {NAV_LINKS.map((link) => (
            <button
              key={link.href}
              onClick={() => scrollTo(link.href)}
              className={cn(
                'rounded-full px-3.5 py-2 text-[13px] transition-colors',
                active === link.href.slice(1)
                  ? 'text-white'
                  : 'text-white/55 hover:text-white'
              )}
            >
              <ScrambleText text={link.label} className="font-medium tracking-wide" />
            </button>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <a
            href="/login"
            className="tech-font rounded-full border border-white/15 px-5 py-2 text-[12px] font-bold uppercase tracking-[0.14em] text-white/80 transition-colors hover:border-white/40 hover:text-white"
          >
            Sign In
          </a>
          <button
            onClick={() => scrollTo('#pricing')}
            className="tech-font rounded-full bg-white px-5 py-2 text-[12px] font-bold uppercase tracking-[0.14em] text-black transition-transform hover:scale-[1.03] active:scale-[0.97]"
          >
            Get Started
          </button>
        </div>

        {/* Mobile hamburger */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-white/15 text-white md:hidden"
        >
          {open ? <X size={20} aria-hidden /> : <Menu size={20} aria-hidden />}
        </button>
      </nav>

      {/* Mobile menu */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className="border-b border-white/10 bg-black/90 backdrop-blur-xl md:hidden"
          >
            <div className="flex flex-col gap-1 px-4 py-4">
              {NAV_LINKS.map((link) => (
                <button
                  key={link.href}
                  onClick={() => scrollTo(link.href)}
                  className="rounded-lg px-4 py-3 text-left text-[15px] text-white/75 transition-colors hover:bg-white/5 hover:text-white"
                >
                  {link.label}
                </button>
              ))}
              <div className="mt-2 flex flex-col gap-2 border-t border-white/10 pt-4">
                <a
                  href="/login"
                  className="tech-font rounded-full border border-white/20 px-5 py-3 text-center text-[12px] font-bold uppercase tracking-[0.14em] text-white"
                >
                  Sign In
                </a>
                <button
                  onClick={() => scrollTo('#pricing')}
                  className="tech-font rounded-full bg-white px-5 py-3 text-center text-[12px] font-bold uppercase tracking-[0.14em] text-black"
                >
                  Get Started
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}