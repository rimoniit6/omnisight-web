'use client';

import { useState } from 'react';
import { Loader2, Mail, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';

const PLAN_OPTIONS = ['Free', 'Pro', 'Business', 'Enterprise', 'Self-Hosted'] as const;

export interface ContactFormProps {
  initialPlan?: string;
}

export function ContactForm({ initialPlan = 'Enterprise' }: ContactFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [plan, setPlan] = useState<string>(initialPlan);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, company, planInterest: plan, message }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Something went wrong. Please try again.');
        return;
      }
      setSent(true);
      toast.success('Message sent! Our team will reach out shortly.');
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border/60 bg-muted/30 p-10 text-center">
        <CheckCircle2 className="h-10 w-10 text-primary" />
        <h3 className="text-lg font-semibold text-foreground">Thank you!</h3>
        <p className="max-w-sm text-sm text-muted-foreground">
          Your inquiry has been received. A member of our team will contact you
          at <span className="font-medium text-foreground">{email}</span> shortly.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="lead-name">Full Name</Label>
          <Input
            id="lead-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Doe"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lead-email">Work Email</Label>
          <Input
            id="lead-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@company.com"
            required
          />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="lead-company">Company</Label>
          <Input
            id="lead-company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Acme Inc."
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lead-plan">Plan Interested In</Label>
          <Select value={plan} onValueChange={setPlan}>
            <SelectTrigger id="lead-plan">
              <SelectValue placeholder="Select a plan" />
            </SelectTrigger>
            <SelectContent>
              {PLAN_OPTIONS.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="lead-message">Message</Label>
        <Textarea
          id="lead-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Tell us a bit about your team and what you need…"
          rows={4}
        />
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={loading}>
        {loading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Sending…
          </>
        ) : (
          'Send Message'
        )}
      </Button>

      <p className="flex items-center justify-center gap-1.5 text-center text-sm text-muted-foreground">
        <Mail className="h-4 w-4" />
        Or reach us directly at{' '}
        <a href="mailto:sales@omnisight.com" className="font-medium text-primary hover:underline">
          sales@omnisight.com
        </a>
      </p>
    </form>
  );
}
