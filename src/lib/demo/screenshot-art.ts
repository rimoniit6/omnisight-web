// OmniSight — Demo-First Experience: synthetic screenshot generator.
//
// Renders DETERMINISTIC, clearly-fictional screenshot PNGs with sharp (SVG
// composite → PNG buffer). No real image ever enters the demo: every pixel is
// drawn here. Buffers are deterministic per (scene, seed) so re-seeding
// produces identical artifacts (thumbnail worker re-runs stay idempotent).
//
// Storage always goes through the org-scoped helper (putScreenshot) — this
// module never constructs storage paths.

import sharp from 'sharp';
import { parsePngDimensions } from '@/lib/screenshots/storage';
import type { DemoScreenshotScene } from './fixtures';

const WIDTH = 1280;
const HEIGHT = 800;

/**
 * Build the SVG for a fake desktop window: title bar, traffic dots, three
 * content lines and a persistent "SIMULATED DEMO" watermark. Deterministic
 * per scene.
 */
function sceneSvg(scene: DemoScreenshotScene): string {
  const base = `hsl(${scene.hue}, 38%, 16%)`;
  const panel = `hsl(${scene.hue}, 32%, 22%)`;
  const accent = `hsl(${(scene.hue + 40) % 360}, 70%, 62%)`;
  const lines = scene.lines
    .map(
      (l, i) =>
        `<text x="90" y="${250 + i * 110}" font-family="monospace" font-size="34" fill="hsl(${scene.hue}, 20%, 82%)">${escapeXml(l)}</text>`
    )
    .join('');
  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${base}"/>
  <rect x="40" y="60" width="${WIDTH - 80}" height="${HEIGHT - 120}" rx="18" fill="${panel}"/>
  <rect x="40" y="60" width="${WIDTH - 80}" height="64" rx="18" fill="hsl(${scene.hue}, 30%, 28%)"/>
  <circle cx="86" cy="92" r="11" fill="#ef4444"/>
  <circle cx="122" cy="92" r="11" fill="#f59e0b"/>
  <circle cx="158" cy="92" r="11" fill="#22c55e"/>
  <text x="200" y="102" font-family="sans-serif" font-size="28" fill="hsl(${scene.hue}, 25%, 90%)">${escapeXml(scene.title)}</text>
  <rect x="90" y="180" width="${Math.floor((WIDTH - 180) * 0.62)}" height="10" rx="5" fill="${accent}" opacity="0.85"/>
  ${lines}
  <rect x="0" y="${HEIGHT - 84}" width="${WIDTH}" height="84" fill="rgba(0,0,0,0.55)"/>
  <text x="${WIDTH / 2}" y="${HEIGHT - 32}" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="30" letter-spacing="6" fill="#e2e8f0">SIMULATED DEMO</text>
</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Generate a synthetic screenshot PNG for a scene. Throws when sharp fails or
 * the produced bytes are not a valid PNG (fail-closed — the seeder aborts
 * rather than storing a broken artifact).
 */
export async function renderDemoScreenshot(scene: DemoScreenshotScene): Promise<Buffer> {
  const png = await sharp(Buffer.from(sceneSvg(scene))).png().toBuffer();
  const dims = parsePngDimensions(png);
  if (!dims || dims.width !== WIDTH || dims.height !== HEIGHT) {
    throw new Error('demo screenshot generator produced an invalid PNG');
  }
  return png;
}
