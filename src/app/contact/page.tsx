'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Mail, MessageSquareText } from 'lucide-react';
import { PublicHeader } from '@/components/layout/PublicHeader';
import { PublicFooter } from '@/components/layout/PublicFooter';
import { ContactForm } from '@/components/marketing/ContactForm';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

function ContactContent() {
  const searchParams = useSearchParams();
  const plan = searchParams.get('plan') ?? undefined;
  const safePlan =
    plan && ['Free', 'Pro', 'Business', 'Enterprise', 'Self-Hosted'].includes(plan) ? plan : undefined;

  return (
    <main className="mx-auto max-w-3xl flex-1 px-4 py-16 sm:px-6">
      <div className="mb-10 text-center">
        <span className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MessageSquareText className="h-6 w-6" />
        </span>
        <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">Contact Sales</h1>
        <p className="mt-3 text-muted-foreground">
          Tell us about your team and we&apos;ll help you pick the right plan —
          including self-hosted and enterprise options.
        </p>
      </div>

      <Card className="border-border/60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            Get in touch
          </CardTitle>
          <CardDescription>
            {safePlan
              ? `We see you're interested in the ${safePlan} plan. `
              : ' '}
            Fill in the form and a sales specialist will reach out within one
            business day.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ContactForm initialPlan={safePlan ?? 'Enterprise'} />
        </CardContent>
      </Card>
    </main>
  );
}

export default function ContactPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <PublicHeader />
      <Suspense fallback={null}>
        <ContactContent />
      </Suspense>
      <PublicFooter />
    </div>
  );
}
