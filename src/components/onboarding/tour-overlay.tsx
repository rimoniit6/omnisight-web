'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronRight, ChevronLeft, Sparkles } from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { tourSteps, type TourStep } from '@/lib/tour-steps';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface TargetRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function getTargetRect(targetId: string): TargetRect | null {
  const el = document.querySelector(`[data-tour-target="${targetId}"]`);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function getPopoverPosition(targetRect: TargetRect | null, placement: TourStep['placement']) {
  const gap = 12;
  const cardWidth = 340;
  const cardHeight = 200;

  if (!targetRect) {
    return { top: 0, left: 0 };
  }

  let top = 0;
  let left = 0;

  switch (placement) {
    case 'bottom':
      top = targetRect.top + targetRect.height + gap;
      left = targetRect.left + targetRect.width / 2 - cardWidth / 2;
      break;
    case 'top':
      top = targetRect.top - cardHeight - gap;
      left = targetRect.left + targetRect.width / 2 - cardWidth / 2;
      break;
    case 'left':
      top = targetRect.top + targetRect.height / 2 - cardHeight / 2;
      left = targetRect.left - cardWidth - gap;
      break;
    case 'right':
      top = targetRect.top + targetRect.height / 2 - cardHeight / 2;
      left = targetRect.left + targetRect.width + gap;
      break;
  }

  // Clamp within viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  top = Math.max(16, Math.min(top, vh - cardHeight - 16));
  left = Math.max(16, Math.min(left, vw - cardWidth - 16));

  return { top, left };
}

export function TourOverlay() {
  const { tourCompleted, setTourCompleted, currentTourStep, setCurrentTourStep } = useAppStore();
  const [mounted, setMounted] = useState(false);
  const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const cardRef = useRef<HTMLDivElement>(null);
  const posUpdateTimerRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);

  // Mount phase - set mounted in a timeout callback (not synchronous in effect)
  useEffect(() => {
    const id = setTimeout(() => setMounted(true), 600);
    return () => clearTimeout(id);
  }, []);

  // Position the card based on target - use requestAnimationFrame callback
  const schedulePositionUpdate = useCallback(() => {
    if (posUpdateTimerRef.current) {
      cancelAnimationFrame(posUpdateTimerRef.current);
    }
    posUpdateTimerRef.current = requestAnimationFrame(() => {
      const step = tourSteps[currentTourStep];
      if (!step) return;
      const rect = getTargetRect(step.target);
      setTargetRect(rect);
      const pos = getPopoverPosition(rect, step.placement);
      setPosition({ top: pos.top, left: pos.left });
    });
  }, [currentTourStep]);

  // Subscribe to resize and scroll events
  useEffect(() => {
    if (!mounted || tourCompleted) return;

    // Schedule initial position update via rAF callback
    schedulePositionUpdate();
    window.addEventListener('resize', schedulePositionUpdate);
    window.addEventListener('scroll', schedulePositionUpdate, true);

    return () => {
      window.removeEventListener('resize', schedulePositionUpdate);
      window.removeEventListener('scroll', schedulePositionUpdate, true);
      if (posUpdateTimerRef.current) {
        cancelAnimationFrame(posUpdateTimerRef.current);
      }
    };
  }, [mounted, tourCompleted, schedulePositionUpdate]);

  // Update position when step changes
  useEffect(() => {
    if (mounted && !tourCompleted) {
      schedulePositionUpdate();
    }
  }, [currentTourStep, mounted, tourCompleted, schedulePositionUpdate]);

  const visible = mounted && !tourCompleted;

  const step = tourSteps[currentTourStep];
  const totalSteps = tourSteps.length;
  const isFirst = currentTourStep === 0;
  const isLast = currentTourStep === totalSteps - 1;

  const handleNext = () => {
    if (isLast) {
      setTourCompleted(true);
    } else {
      setCurrentTourStep(currentTourStep + 1);
    }
  };

  const handlePrevious = () => {
    if (currentTourStep > 0) {
      setCurrentTourStep(currentTourStep - 1);
    }
  };

  const handleSkip = () => {
    setTourCompleted(true);
  };

  // Handle click outside the card to dismiss
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
      handleSkip();
    }
  };

  if (!visible || !step) return null;

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="fixed inset-0 z-[100]"
          onClick={handleBackdropClick}
          style={{ pointerEvents: 'auto' }}
        >
          {/* Highlight spotlight on target element */}
          {targetRect && (
            <motion.div
              key={`spotlight-${currentTourStep}`}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3 }}
              className="fixed pointer-events-none z-[101]"
              style={{
                top: targetRect.top - 4,
                left: targetRect.left - 4,
                width: targetRect.width + 8,
                height: targetRect.height + 8,
                borderRadius: 8,
                boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45), 0 0 20px 4px rgba(52, 211, 153, 0.3)',
              }}
            />
          )}

          {/* Tour card */}
          <motion.div
            ref={cardRef}
            key={`card-${currentTourStep}`}
            initial={{ opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 300, damping: 25 }}
            className="fixed z-[102] w-[340px]"
            style={{ top: position.top, left: position.left }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-card rounded-xl shadow-2xl border border-primary/20 overflow-hidden">
              {/* Accent bar */}
              <div className="h-1.5 bg-primary" />

              <div className="p-5">
                {/* Header row */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2.5">
                    {/* Step number badge */}
                    <span className="inline-flex items-center justify-center h-6 min-w-[28px] px-2 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 text-[11px] font-bold border border-emerald-500/20">
                      {currentTourStep + 1}/{totalSteps}
                    </span>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: totalSteps }).map((_, i) => (
                        <span
                          key={i}
                          className={cn(
                            'h-1 w-1 rounded-full transition-colors duration-300',
                            i === currentTourStep ? 'bg-emerald-500 w-3' : 'bg-muted-foreground/25'
                          )}
                        />
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={handleSkip}
                    className="p-1 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                    aria-label="Close tour"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Title */}
                <h3 className="text-base font-semibold text-foreground mb-2">{step.title}</h3>

                {/* Content */}
                <p className="text-sm text-muted-foreground leading-relaxed mb-5">
                  {step.content}
                </p>

                {/* Actions */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {!isFirst && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handlePrevious}
                        className="h-8 px-3 text-xs"
                      >
                        <ChevronLeft className="w-3.5 h-3.5 mr-1" />
                        Back
                      </Button>
                    )}
                    <button
                      onClick={handleSkip}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1"
                    >
                      Skip tour
                    </button>
                  </div>

                  <Button
                    size="sm"
                    onClick={handleNext}
                    className={cn(
                      'h-8 px-4 text-xs btn-press',
                      isLast
                        ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                        : 'bg-primary text-primary-foreground'
                    )}
                  >
                    {isLast ? (
                      <>
                        <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                        Get Started
                      </>
                    ) : (
                      <>
                        Next
                        <ChevronRight className="w-3.5 h-3.5 ml-1" />
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
