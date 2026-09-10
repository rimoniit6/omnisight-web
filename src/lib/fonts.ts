import { Space_Mono } from 'next/font/google';

// Technical font for the OmniSight cinematic public system (landing + login).
// Next.js self-hosts the font at build time — no runtime CDN dependency.
// NOTE: this module must NOT be marked 'use client' — next/font is server-only;
// client components import `spaceMono.variable` from here.
export const spaceMono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-space-mono',
  display: 'swap',
});