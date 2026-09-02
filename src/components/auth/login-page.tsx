'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Image from 'next/image';
import { Eye, EyeOff, Lock, Mail, Loader2, ArrowRight } from 'lucide-react';
import { useAuthStore } from '@/lib/store';
import { useEffectiveBranding } from '@/hooks/use-effective-branding';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [retryAfter, setRetryAfter] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const login = useAuthStore((s) => s.login);
  const branding = useEffectiveBranding();

  // Countdown timer for rate-limit retry
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

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setRetryAfter(0);

    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password');
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
        setIsLoading(false);
        return;
      }

      login(data.token, data.user, data.organization);
      toast.success(`Welcome back, ${data.user.name}!`);
    } catch {
      setError('Network error. Please try again.');
      setIsLoading(false);
    }
  }, [email, password, retryAfter, login]);

  const inputBase =
    'w-full h-11 pl-10 pr-3 rounded-lg border bg-card/80 backdrop-blur text-sm outline-none transition-colors ' +
    'border-border focus:border-primary focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/70';

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-muted/40" role="main" aria-label="Login">
      {/* Subtle neutral washes */}
      <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-primary/5 blur-[80px] pointer-events-none" />
      <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-primary/5 blur-[80px] pointer-events-none" />

      <div className="relative z-10 w-full max-w-md px-4">
        {/* Logo */}
        <div className="text-center mb-8">
          {branding.logoType === 'svg' && branding.logoSvg ? (
            <div
              style={{
                width: branding.logoWidth && branding.logoWidth > 0 ? branding.logoWidth : 112,
                height: branding.logoHeight && branding.logoHeight > 0 ? branding.logoHeight : 112,
              }}
              dangerouslySetInnerHTML={{ __html: branding.logoSvg }}
              className="mx-auto mb-4 flex items-center justify-center"
            />
          ) : (
            <Image
              src={branding.logoUrl}
              alt={`${branding.brandName} logo`}
              width={112}
              height={112}
              className="object-contain mx-auto mb-4"
              priority
              unoptimized
            />
          )}
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
            {branding.brandName}
          </h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary mt-1">
            {branding.tagline}
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Sign in to your workforce intelligence platform
          </p>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-xl shadow-sm p-6">
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            {/* Email */}
            <div>
              <label htmlFor="email" className="block text-sm font-medium mb-2 text-foreground">
                Email Address
              </label>
              <div className="relative">
                <Mail size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="email"
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError(''); }}
                  className={inputBase}
                  autoComplete="email"
                  autoFocus
                  disabled={isLoading}
                  aria-required="true"
                  aria-invalid={!!error}
                  aria-describedby={error ? 'login-error' : undefined}
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label htmlFor="password" className="block text-sm font-medium mb-2 text-foreground">
                Password
              </label>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  className={cn(inputBase, 'pr-10')}
                  autoComplete="current-password"
                  disabled={isLoading}
                  aria-required="true"
                  aria-invalid={!!error}
                  aria-describedby={error ? 'login-error' : undefined}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div id="login-error" role="alert" aria-live="assertive" className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={isLoading || retryAfter > 0}
              className="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-sm rounded-lg border-0 cursor-pointer flex items-center justify-center gap-2 shadow-sm transition-colors duration-200 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <><Loader2 size={16} className="animate-spin" /> Signing in...</>
              ) : retryAfter > 0 ? (
                <><Loader2 size={16} /> Try again in {retryAfter}s</>
              ) : (
                <>Sign In <ArrowRight size={16} /></>
              )}
            </button>
          </form>

        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          © 2026 {branding.brandName} · Workforce Intelligence Platform
        </p>
      </div>
    </div>
  );
}
