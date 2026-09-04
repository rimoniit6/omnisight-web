'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Menu, X, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PublicHeaderProps {
  appName?: string;
}

const NAV_LINKS = [
  { href: '/#features', label: 'Features' },
  { href: '/#how-it-works', label: 'How It Works' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/#contact', label: 'Contact' },
];

export function PublicHeader({ appName = 'OmniSight' }: PublicHeaderProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return (
    <header
      role="banner"
      className="sticky top-0 z-50 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70"
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5" aria-label={`${appName} home`}>
          <span className="relative h-8 w-8">
            <Image
              src="/logos/omnisight.svg"
              alt={`${appName} logo`}
              fill
              sizes="32px"
              className="object-contain"
              priority
            />
          </span>
          <span className="text-lg font-semibold tracking-tight text-foreground">
            {appName}
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Right actions */}
        <div className="hidden items-center gap-3 md:flex">
          {isAuthenticated ? (
            <>
              <Button variant="outline" size="sm" asChild>
                <Link href="/">
                  <ShieldCheck className="mr-1.5 h-4 w-4" />
                  Dashboard
                </Link>
              </Button>
              <LogoutLink />
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Login
              </Link>
              <Button size="sm" asChild>
                <Link href="/login">Get Started</Link>
              </Button>
            </>
          )}
        </div>

        {/* Mobile toggle */}
        <button
          type="button"
          className="inline-flex h-10 w-10 items-center justify-center rounded-md text-foreground md:hidden"
          onClick={() => setMobileOpen((v) => !v)}
          aria-expanded={mobileOpen}
          aria-label="Toggle navigation"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile menu */}
      <div className={cn('md:hidden', mobileOpen ? 'block' : 'hidden')}>
        <nav className="space-y-1 border-t border-border/60 px-4 py-3" aria-label="Mobile">
          {NAV_LINKS.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              onClick={() => setMobileOpen(false)}
              className="block rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
          <div className="flex flex-col gap-2 pt-2">
            {isAuthenticated ? (
              <>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/" onClick={() => setMobileOpen(false)}>
                    Dashboard
                  </Link>
                </Button>
                <LogoutLink />
              </>
            ) : (
              <>
                <Button size="sm" asChild>
                  <Link href="/login" onClick={() => setMobileOpen(false)}>
                    Get Started
                  </Link>
                </Button>
                <Link
                  href="/login"
                  onClick={() => setMobileOpen(false)}
                  className="rounded-md px-3 py-2 text-center text-sm font-medium text-muted-foreground hover:text-foreground"
                >
                  Login
                </Link>
              </>
            )}
          </div>
        </nav>
      </div>
    </header>
  );
}

function LogoutLink() {
  const logout = useAuthStore((s) => s.logout);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void logout();
      }}
    >
      Logout
    </Button>
  );
}
