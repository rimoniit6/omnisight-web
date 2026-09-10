'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import { motion, useReducedMotion } from 'framer-motion';
import { Eye, EyeOff, Loader2, ArrowRight } from 'lucide-react';
import { useAuthStore } from '@/lib/store';
import { useEffectiveBranding } from '@/hooks/use-effective-branding';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { spaceMono } from '@/lib/fonts';
import { AnimatedBackground } from '@/components/landing/AnimatedBackground';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [retryAfter, setRetryAfter] = useState(0);
  const [shakeKey, setShakeKey] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const login = useAuthStore((s) => s.login);
  const branding = useEffectiveBranding();
  const reduce = useReducedMotion();

  // Countdown timer for rate-limit retry (unchanged behavior)
  useEffect(() => {
    if (retryAfter <= 0) {
      if (retryTimerRef.current) {
        clearInterval(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      return;
    }
    retryTimerRef.current = setInterval(() => {
      setRetryAfter((prev) => {
        if (prev <= 1) {
          if (retryTimerRef.current) {
            clearInterval(retryTimerRef.current);
            retryTimerRef.current = null;
          }
          setError('');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (retryTimerRef.current) {
        clearInterval(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [retryAfter > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError('');
      setRetryAfter(0);

      if (!email.trim() || !password.trim()) {
        setError('Please enter both email and password');
        setShakeKey((k) => k + 1);
        return;
      }

      if (retryAfter > 0) return;

      setIsLoading(true);

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim(), password }),
        });

        const data = await res.json();

        if (!res.ok) {
          if (res.status === 429 && typeof data.retryAfter === 'number') {
            setRetryAfter(data.retryAfter);
            setError(`Too many sign-in attempts. Try again in ${data.retryAfter} seconds.`);
          } else {
            setError(data.error || 'Login failed');
          }
          setShakeKey((k) => k + 1);
          setIsLoading(false);
          return;
        }

        login(data.token, data.user, data.organization);
        toast.success(`Welcome back, ${data.user.name}!`);
      } catch {
        setError('Unable to sign in right now. Please try again.');
        setShakeKey((k) => k + 1);
        setIsLoading(false);
      }
    },
    [email, password, retryAfter, login]
  );

  const inputClass =
    'w-full h-12 rounded-xl border border-white/12 bg-white/[0.04] px-4 text-[15px] text-white placeholder:text-white/30 outline-none transition-all duration-200 focus:border-cyan-300/50 focus:bg-white/[0.06] focus:ring-2 focus:ring-cyan-300/15';

  const brandName = branding.brandName || 'OmniSight';

  return (
    <div
      className={`omni-cinematic relative min-h-[100dvh] overflow-hidden ${spaceMono.variable}`}
      role="main"
      aria-label="Login"
    >
      <AnimatedBackground variant="auth" />

      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-7xl flex-col px-5 py-6 sm:px-8 lg:flex-row lg:items-center lg:gap-16 lg:px-10">
        {/* Brand panel — desktop only */}
        <div className="hidden flex-1 lg:block">
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 18 }}
            animate={reduce ? false : { opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="flex items-center gap-3">
              <span className="relative inline-block h-11 w-11">
                <Image
                  src="/logos/omnisight.svg"
                  alt={`${brandName} logo`}
                  fill
                  sizes="44px"
                  className="object-contain drop-shadow-[0_0_14px_rgba(0,212,255,0.4)]"
                  priority
                  unoptimized
                />
              </span>
              <span className="text-xl font-semibold tracking-tight text-white">{brandName}</span>
            </div>
            <h1 className="mt-14 text-[clamp(40px,5vw,72px)] font-semibold leading-[1.02] tracking-tight text-white">
              See Work.
              <br />
              Understand Performance.
              <br />
              Move Faster.
            </h1>
            <p className="mt-6 max-w-md text-[15px] leading-relaxed text-white/50">
              A unified control center for workforce activity, productivity and
              operational intelligence.
            </p>
            <p className="tech-font mt-10 text-[10px] font-bold uppercase tracking-[0.3em] text-cyan-300/70">
              Workforce Intelligence Platform
            </p>
          </motion.div>
        </div>

        {/* Auth card */}
        <div className="flex w-full flex-1 items-center justify-center lg:justify-end">
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 22 }}
            animate={reduce ? false : { opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-md"
          >
            {/* Mobile logo */}
            <div className="mb-8 flex items-center gap-3 lg:hidden">
              <span className="relative inline-block h-10 w-10">
                <Image
                  src="/logos/omnisight.svg"
                  alt={`${brandName} logo`}
                  fill
                  sizes="40px"
                  className="object-contain"
                  priority
                  unoptimized
                />
              </span>
              <span className="text-lg font-semibold tracking-tight text-white">{brandName}</span>
            </div>

            <div key={shakeKey} className={cn('glass-panel rounded-[20px] p-7 sm:p-8', shakeKey > 0 && 'omni-shake')}>
              <h2 className="text-2xl font-semibold tracking-tight text-white">Welcome back.</h2>
              <p className="mt-1.5 text-[14px] text-white/50">Sign in to your {brandName} account.</p>

              <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-5" noValidate>
                {/* Email */}
                <div>
                  <label htmlFor="email" className="tech-font mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/60">
                    Email address
                  </label>
                  <input
                    id="email"
                    type="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setError('');
                    }}
                    className={inputClass}
                    autoComplete="email"
                    autoFocus
                    disabled={isLoading}
                    aria-required="true"
                    aria-invalid={!!error}
                    aria-describedby={error ? 'login-error' : undefined}
                  />
                </div>

                {/* Password */}
                <div>
                  <label htmlFor="password" className="tech-font mb-2 block text-[11px] font-bold uppercase tracking-[0.16em] text-white/60">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setError('');
                      }}
                      className={cn(inputClass, 'pr-12')}
                      autoComplete="current-password"
                      disabled={isLoading}
                      aria-required="true"
                      aria-invalid={!!error}
                      aria-describedby={error ? 'login-error' : undefined}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-3 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-white/45 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                </div>

                {/* Error */}
                {error && (
                  <div
                    id="login-error"
                    role="alert"
                    aria-live="assertive"
                    className="rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-[13px] text-red-200"
                  >
                    {error}
                  </div>
                )}

                {/* Submit */}
                <button
                  type="submit"
                  disabled={isLoading || retryAfter > 0}
                  className="tech-font inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white text-[13px] font-bold uppercase tracking-[0.16em] text-black transition-all duration-200 hover:scale-[1.02] hover:bg-white/90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={16} className="animate-spin" aria-hidden />
                      Signing in...
                    </>
                  ) : retryAfter > 0 ? (
                    `Try again in ${retryAfter}s`
                  ) : (
                    <>
                      Sign In <ArrowRight size={16} aria-hidden />
                    </>
                  )}
                </button>
              </form>
            </div>

            <p className="mt-7 text-center text-[11.5px] text-white/35">
              © 2026 {brandName} · Workforce Intelligence Platform
            </p>
          </motion.div>
        </div>
      </div>
    </div>
  );
}