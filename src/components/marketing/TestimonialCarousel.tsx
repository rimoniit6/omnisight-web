'use client';

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Quote } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface Testimonial {
  quote: string;
  author: string;
  role: string;
  company: string;
}

const TESTIMONIALS: Testimonial[] = [
  {
    quote:
      'OmniSight gave us complete visibility into remote work without feeling invasive. The AI insights surface real productivity gaps we never saw before.',
    author: 'Sarah Chen',
    role: 'VP of Operations',
    company: 'Northwind Logistics',
  },
  {
    quote:
      'The self-hosted option sealed it for us. All monitoring data stays on our own servers — our security team is finally comfortable.',
    author: 'Marcus Alvarez',
    role: 'Head of IT',
    company: 'Vertex Manufacturing',
  },
  {
    quote:
      'We replaced three separate tools with OmniSight. Screenshot search, USB policies, and reporting in one place. Setup took under an hour.',
    author: 'Priya Sharma',
    role: 'People Operations Lead',
    company: 'Brightline Studios',
  },
];

export function TestimonialCarousel() {
  const [index, setIndex] = useState(0);
  const current = TESTIMONIALS[index % TESTIMONIALS.length];

  const prev = () => setIndex((i) => (i - 1 + TESTIMONIALS.length) % TESTIMONIALS.length);
  const next = () => setIndex((i) => (i + 1) % TESTIMONIALS.length);

  return (
    <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
      <div className="relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={index}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
            transition={{ duration: 0.4 }}
          >
            <Card className="border-border/60">
              <CardContent className="flex flex-col items-center gap-4 p-8 sm:p-10">
                <Quote className="h-8 w-8 text-primary" />
                <p className="text-lg leading-relaxed text-foreground sm:text-xl">
                  &ldquo;{current.quote}&rdquo;
                </p>
                <div>
                  <div className="font-semibold text-foreground">{current.author}</div>
                  <div className="mt-0.5 text-sm text-muted-foreground">
                    {current.role} · {current.company}
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="mt-6 flex items-center justify-center gap-3">
        <Button variant="ghost" size="icon" onClick={prev} aria-label="Previous testimonial">
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div className="flex items-center gap-2">
          {TESTIMONIALS.map((t, i) => (
            <button
              key={t.company}
              type="button"
              aria-label={`Testimonial ${i + 1}`}
              onClick={() => setIndex(i)}
              className={`h-2 w-2 rounded-full transition-colors ${
                i === index ? 'bg-primary' : 'bg-border'
              }`}
            />
          ))}
        </div>
        <Button variant="ghost" size="icon" onClick={next} aria-label="Next testimonial">
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>
    </div>
  );
}
