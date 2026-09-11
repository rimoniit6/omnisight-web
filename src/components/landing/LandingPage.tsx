'use client';

import { spaceMono } from '@/lib/fonts';
import { LandingNavbar } from './LandingNavbar';
import { HeroSection } from './HeroSection';
import { LiveActivityPreview, FeatureSection } from './product-sections';
import { ScreenshotPreview, AIInsightPreview } from './intelligence-sections';
import { SecuritySection, DeploymentModes } from './trust-sections';
import { PricingSection, FinalCTA, LandingFooter } from './commerce-sections';

/**
 * OmniSight — cinematic one-page public landing (unauthenticated root).
 * Presentation-only: no auth, no data-plane access, no schema, no fake metrics.
 * Scoped to a dark cinematic system that never touches the authenticated app.
 */
export function LandingPage() {
  return (
    <div className={`omni-cinematic min-h-screen overflow-x-hidden ${spaceMono.variable}`}>
      <a
        href="#features"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:text-black"
      >
        Skip to content
      </a>
      <LandingNavbar />
      <main>
        <HeroSection />
        <LiveActivityPreview />
        <FeatureSection />
        <ScreenshotPreview />
        <AIInsightPreview />
        <SecuritySection />
        <DeploymentModes />
        <PricingSection />
        <FinalCTA />
      </main>
      <LandingFooter />
    </div>
  );
}