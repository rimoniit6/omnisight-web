// Derives platform raster/icon variants from the canonical OmniSight SVG
// (public/logos/omnisight.svg) — the single source of truth.
// Never hand-edit the outputs; re-run this script after replacing the SVG.
//
// The SVG itself is used directly everywhere in the UI (crisp at any size,
// transparent background, zero duplication). Only formats browsers/Windows
// cannot consume as raw SVG are derived here:
//   - public/favicon.svg — favicon-specific SVG derivative: SAME artwork,
//     SAME defs/elements, but a tight viewBox crop (110 110 280 280) so the
//     mark occupies ~96% of the canvas width instead of 50% of the full
//     500x500 canvas (the raw canonical renders the mark far too small in a
//     browser tab). The canonical file is NEVER edited — the crop happens
//     here, at derivation time.
//   - public/favicon.ico (16/32/48) — raster fallback for browsers that
//     cannot consume SVG favicons.
//   - public/favicon.png (32) — classic raster fallback.
//   - public/apple-touch-icon.png (180) — iOS home-screen icon.
//   - omnisight-agent/src/renderer/omnisight-mark.svg — Agent header
//     presentation derivative. WHY IT EXISTS: the renderer header shows the
//     mark next to the "OmniSight Agent" wordmark; the canonical 500x500
//     canvas has ~25% whitespace on each side of the mark, so displaying the
//     canonical file directly makes the visible mark tiny (or forces an
//     oversized box that pushes the wordmark away). This derivative applies
//     the same tight viewBox crop as the favicon (SAME artwork, defs, glow,
//     gradients, transparency — only the viewBox differs). It is a derived
//     display asset, never the canonical source.
//   - omnisight-agent/assets/icon.ico (16/24/32/48/64/128/256) — agent window,
//     tray, installer / Start Menu / shortcut / exe icon. Also rendered from
//     the tight crop so the 16px tray entry shows the mark (~14px) instead of
//     the ~8px mark produced by the full-canvas render (same root cause).
// All derived from the canonical artwork — same shapes, gradients, glow,
// transparent background, no borders/backgrounds added.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const svgPath = join(publicDir, 'logos', 'omnisight.svg');
const svg = readFileSync(svgPath, 'utf8');

if (!svg.includes('grad1') || !svg.includes('<ellipse')) {
  throw new Error('Canonical SVG structure not recognized.');
}

// -- Favicon derivative: tight crop of the canonical mark ---------------------
// Mark content on the 500x500 canvas spans ~127..373 horizontally and
// ~164..336 vertically (incl. stroke + glow blur). A square crop centered on
// 250,250 with a safe glow margin yields viewBox="110 110 280 280": the mark
// fills ~96% of the width and ~64% of the height (the artwork itself is a
// 1.5:1 orbital mark — filling more would crop or stretch it, which is
// forbidden). Margins stay transparent and large enough to prevent clipping.
const defsStart = svg.indexOf('<defs>');
const defsEnd = svg.indexOf('</defs>') + '</defs>'.length;
const svgEnd = svg.lastIndexOf('</svg>');
const faviconSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="110 110 280 280">\n' +
  '  ' + svg.slice(defsStart, defsEnd) + '\n' +
  '  ' + svg.slice(defsEnd, svgEnd) +
  '</svg>\n';

async function render(svgSource, size) {
  return sharp(Buffer.from(svgSource), { density: Math.max(96, (size * 96) / 200) })
    .resize(size, size, { fit: 'cover' })
    .png()
    .toBuffer();
}

// -- 1. Browser favicon set (tight-crop derivative) --
writeFileSync(join(publicDir, 'favicon.svg'), faviconSvg);
writeFileSync(join(publicDir, 'favicon.png'), await render(faviconSvg, 32));
writeFileSync(join(publicDir, 'apple-touch-icon.png'), await render(faviconSvg, 180));
writeFileSync(join(publicDir, 'favicon.ico'), writeIco([
  { size: 16, png: await render(faviconSvg, 16) },
  { size: 32, png: await render(faviconSvg, 32) },
  { size: 48, png: await render(faviconSvg, 48) },
]));

// -- 2. Desktop Agent header mark (presentation derivative, tight crop) --
const rendererAssets = join(root, 'omnisight-agent', 'src', 'renderer');
mkdirSync(rendererAssets, { recursive: true });
writeFileSync(join(rendererAssets, 'omnisight-mark.svg'), faviconSvg);

// -- 3. Windows .ico (PNG-compressed entries; Vista+ format) for the agent --
function writeIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + 16 * count;
  const entries = [];
  const blobs = [];
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size === 256 ? 0 : size, 0);
    e.writeUInt8(size === 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
    blobs.push(png);
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = [];
for (const size of icoSizes) icoPngs.push({ size, png: await render(faviconSvg, size) });

const assetsDir = join(root, 'omnisight-agent', 'assets');
mkdirSync(assetsDir, { recursive: true });
rmSync(join(assetsDir, 'icon.ico'), { force: true });
writeFileSync(join(assetsDir, 'icon.ico'), writeIco(icoPngs));

const report = {
  canonical: 'public/logos/omnisight.svg',
  outputs: [
    'public/favicon.svg (SVG, tight-crop derivative)',
    'public/favicon.ico (16/32/48)',
    'public/favicon.png (32)',
    'public/apple-touch-icon.png (180)',
    'omnisight-agent/src/renderer/omnisight-mark.svg (agent header derivative)',
    'omnisight-agent/assets/icon.ico (16/24/32/48/64/128/256, tight crop)',
  ],
};
console.log('[brand] ' + JSON.stringify(report, null, 2));