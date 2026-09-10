'use client';

// Cinematic dark background system for landing + login. Pure CSS transforms —
// no rAF loops, no React state ticking. Respects prefers-reduced-motion via
// the CSS guard in globals.css. Never renders text or real data.

const PARTICLES = [
  { left: '8%', delay: '0s', duration: '16s' },
  { left: '17%', delay: '3s', duration: '21s' },
  { left: '26%', delay: '7s', duration: '14s' },
  { left: '38%', delay: '1.5s', duration: '19s' },
  { left: '47%', delay: '9s', duration: '23s' },
  { left: '58%', delay: '4s', duration: '17s' },
  { left: '67%', delay: '11s', duration: '20s' },
  { left: '76%', delay: '2s', duration: '15s' },
  { left: '85%', delay: '6s', duration: '22s' },
  { left: '93%', delay: '8s', duration: '18s' },
];

export function AnimatedBackground({
  variant = 'landing',
}: {
  variant?: 'landing' | 'auth';
}) {
  const subtle = variant === 'auth';
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* Base radial glows */}
      <div
        className="absolute -top-[20%] left-1/2 h-[60vh] w-[80vw] -translate-x-1/2 rounded-full opacity-60 blur-[120px]"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(0,180,255,0.14), rgba(0,180,255,0.05) 45%, transparent 70%)',
        }}
      />
      <div
        className="absolute -bottom-[25%] -left-[10%] h-[55vh] w-[55vw] rounded-full opacity-40 blur-[130px]"
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(90,140,255,0.12), transparent 65%)',
        }}
      />
      {/* Dot grid */}
      <div className="grid-overlay absolute inset-0 opacity-70 [mask-image:radial-gradient(ellipse_at_center,black_35%,transparent_78%)]" />
      {/* Synthetic data particles */}
      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className="omni-particle"
          style={{ left: p.left, animationDelay: p.delay, animationDuration: p.duration }}
        />
      ))}
      {/* Scanline sweep (reduced on auth to keep the form calm) */}
      <div className={`scanline absolute inset-x-0 ${subtle ? 'h-[22%] opacity-50' : 'h-[18%]'}`} />
      {/* Vignette to keep foreground readable */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(0,0,0,0.65)_100%)]" />
    </div>
  );
}