'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Building2, Loader2, ArrowRight, Check } from 'lucide-react';
import { useAuthStore } from '@/lib/store';

/**
 * First-run bootstrap screen for an org-less Super Admin.
 *
 * After a fresh deployment (zero organizations), the Super Admin logs in with
 * the env-configured credentials and is asked to create the FIRST
 * organization. This is the ONLY bootstrap path — no demo data, no seeded
 * employees/departments/projects/devices are ever created here.
 *
 * On success the server returns a freshly signed session (JWT + cookie) with
 * the new organization context; the auth store is updated and the normal
 * Admin control plane (empty state) is shown.
 */
export function CreateOrganizationScreen() {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const login = useAuthStore((s) => s.login);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError('Please enter an organization name (at least 2 characters).');
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch('/api/organizations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || 'Failed to create organization');
        setIsLoading(false);
        return;
      }

      // The response carries the re-signed session (token + org context).
      login(data.token, data.user, data.organization);
    } catch {
      setError('Network error. Please try again.');
      setIsLoading(false);
    }
  };

  const inputBase =
    'w-full h-11 px-3 rounded-lg border bg-card/80 backdrop-blur text-sm outline-none transition-colors ' +
    'border-border focus:border-primary focus:ring-2 focus:ring-primary/20 placeholder:text-muted-foreground/70';

  return (
    <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-muted/40">
      {/* Subtle neutral washes */}
      <div className="absolute -top-40 -right-40 w-96 h-96 rounded-full bg-primary/5 blur-[80px] pointer-events-none" />
      <div className="absolute -bottom-40 -left-40 w-96 h-96 rounded-full bg-primary/5 blur-[80px] pointer-events-none" />

      <div className="relative z-10 w-full max-w-md px-4">
        {/* Logo */}
        <div className="text-center mb-8">
          <Image
            src="/logos/omnisight.svg"
            alt="OmniSight logo"
            width={112}
            height={112}
            className="object-contain mx-auto mb-4"
            priority
            unoptimized
          />
          <h1 className="text-[22px] font-semibold tracking-tight text-foreground">
            OmniSight
          </h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary mt-1">
            REMOTE INSIGHTS
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Welcome, Super Admin — let&apos;s set up your workspace
          </p>
        </div>

        {/* Card */}
        <div className="bg-card border border-border rounded-xl shadow-sm p-6">
          <div className="flex items-start gap-3 mb-5">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Building2 className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">Create your organization</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                Your deployment has no organization yet. Create the first one to start
                the Admin control plane — employees, departments and projects are added
                by you afterwards.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div>
              <label htmlFor="org-name" className="block text-sm font-medium mb-2 text-foreground">
                Organization Name
              </label>
              <input
                id="org-name"
                type="text"
                placeholder="e.g. Acme Corporation"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(''); }}
                className={inputBase}
                autoComplete="organization"
                autoFocus
                disabled={isLoading}
              />
            </div>

            {error && (
              <div role="alert" className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full h-11 bg-primary hover:bg-primary/90 text-primary-foreground font-medium text-sm rounded-lg border-0 cursor-pointer flex items-center justify-center gap-2 shadow-sm transition-colors duration-200 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <><Loader2 size={16} className="animate-spin" /> Creating...</>
              ) : (
                <>Create Organization <ArrowRight size={16} /></>
              )}
            </button>
          </form>

          {/* What this creates */}
          <div className="mt-5 pt-5 border-t border-border space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">What happens next</p>
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              <li className="flex items-center gap-2">
                <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" /> Organization created — you are bound to it
              </li>
              <li className="flex items-center gap-2">
                <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" /> Dashboard opens with empty state (0 employees/devices/projects)
              </li>
              <li className="flex items-center gap-2">
                <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" /> Devices appear after a real agent EXE is installed
              </li>
            </ul>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          © 2025 OmniSight · Workforce Intelligence Platform
        </p>
      </div>
    </div>
  );
}
