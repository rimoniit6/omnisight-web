'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface CTASectionProps {
  heading?: string;
  subtext?: string;
}

export function CTASection({
  heading = 'Ready to get started? Join thousands of teams.',
  subtext = 'Start monitoring smarter with real-time workforce intelligence — deployed in minutes, self-hosted if you need it.',
}: CTASectionProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Trial/early-access signup: route to the app where accounts are provisioned.
    router.push(email.trim() ? `/login?email=${encodeURIComponent(email.trim())}` : '/login');
  };

  return (
    <section id="get-started" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="relative overflow-hidden rounded-2xl bg-primary px-6 py-14 text-center text-primary-foreground shadow-xl">
        <div className="relative z-10 mx-auto max-w-2xl">
          <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">{heading}</h2>
          <p className="mt-4 text-base leading-relaxed text-primary-foreground/85">{subtext}</p>
          <form
            onSubmit={handleSubmit}
            className="mx-auto mt-8 flex max-w-md flex-col gap-3 sm:flex-row"
          >
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your work email"
              aria-label="Work email"
              className="bg-background text-foreground placeholder:text-muted-foreground"
            />
            <Button
              type="submit"
              size="lg"
              className="bg-foreground text-background hover:bg-foreground/90"
            >
              Get Started
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </form>
          <p className="mt-4 text-xs text-primary-foreground/70">
            No credit card required. Privacy-first by design.
          </p>
        </div>
      </div>
    </section>
  );
}
