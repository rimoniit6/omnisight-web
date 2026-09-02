import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── SVG Validation Test Suite ───────────────────────────────────────────────
// Tests for validateSvgCode, validateSvgBuffer, sanitizeSvg, parseSvgDimensions

// ─── Test Helpers ────────────────────────────────────────────────────────────

const VALID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60">
  <rect width="200" height="60" fill="#059669"/>
  <text x="100" y="35" text-anchor="middle" fill="white" font-size="20">Logo</text>
</svg>`;

const INVALID_SVG_BAD_CONTENT = `<svg xmlns="http://www.w3.org/2000/svg">
  <script>alert('xss')</script>
</svg>`;

const VALID_SVG_MINIMAL = `<svg xmlns="http://www.w3.org/2000/svg"/>`;

// ─── Imports ─────────────────────────────────────────────────────────────────

import {
  validateSvgCode,
  validateSvgBuffer,
  sanitizeSvg,
  parseSvgDimensions,
  LOGO_SIZE_PRESETS,
  getLogoDisplayDimensions,
} from '../src/lib/branding';

// ─── validateSvgCode ────────────────────────────────────────────────────────

describe('validateSvgCode', () => {
  it('accepts valid SVG with xmlns', () => {
    const result = validateSvgCode(VALID_SVG);
    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  it('accepts SVG missing xmlns (sanitizer adds it)', () => {
    const noXmlns = `<svg viewBox="0 0 200 60"><rect width="200" height="60" fill="#059669"/></svg>`;
    const result = validateSvgCode(noXmlns);
    assert.equal(result.valid, true);
  });

  it('rejects SVG containing <script> tags', () => {
    const result = validateSvgCode(INVALID_SVG_BAD_CONTENT);
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  it('rejects empty string', () => {
    const result = validateSvgCode('');
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  it('rejects non-SVG content', () => {
    const result = validateSvgCode('<html><body>Hello</body></html>');
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  it('accepts minimal valid SVG', () => {
    const result = validateSvgCode(VALID_SVG_MINIMAL);
    assert.equal(result.valid, true);
  });

  it('rejects SVG exceeding 1MB', () => {
    const largeSvg = `<svg xmlns="http://www.w3.org/2000/svg">${'x'.repeat(1024 * 1024 + 100)}</svg>`;
    const result = validateSvgCode(largeSvg);
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  it('rejects SVG with event handlers (onload, onclick)', () => {
    const result = validateSvgCode(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`);
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  it('rejects SVG with <iframe> tags', () => {
    const result = validateSvgCode(`<svg xmlns="http://www.w3.org/2000/svg"><iframe src="evil.com"/></svg>`);
    assert.equal(result.valid, false);
    assert.ok(result.error);
  });

  it('rejects SVG with <object> tags', () => {
    const result = validateSvgCode(`<svg xmlns="http://www.w3.org/2000/svg"><object data="evil.swf"/></svg>`);
    assert.equal(result.valid, false);
  });

  it('rejects SVG with <style> tag', () => {
    const result = validateSvgCode(`<svg xmlns="http://www.w3.org/2000/svg"><style>body{background:red}</style></svg>`);
    assert.equal(result.valid, false);
  });

  it('rejects SVG with eval()', () => {
    const result = validateSvgCode(`<svg xmlns="http://www.w3.org/2000/svg"><text eval("alert(1)")/></svg>`);
    assert.equal(result.valid, false);
  });

  it('rejects SVG with javascript: URI', () => {
    const result = validateSvgCode(`<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/></svg>`);
    assert.equal(result.valid, false);
  });
});

// ─── sanitizeSvg ────────────────────────────────────────────────────────────

describe('sanitizeSvg', () => {
  it('returns a Buffer', () => {
    const buf = Buffer.from(VALID_SVG, 'utf-8');
    const result = sanitizeSvg(buf);
    assert.ok(Buffer.isBuffer(result));
  });

  it('removes <script> tags from SVG', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>`;
    const clean = sanitizeSvg(Buffer.from(dirty, 'utf-8')).toString('utf-8');
    assert.ok(!clean.includes('<script>'));
    assert.ok(clean.includes('<rect/>'));
  });

  it('removes event handler attributes', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect onclick="alert(2)"/></svg>`;
    const clean = sanitizeSvg(Buffer.from(dirty, 'utf-8')).toString('utf-8');
    assert.ok(!clean.includes('onload'));
    assert.ok(!clean.includes('onclick'));
  });

  it('preserves valid SVG structure', () => {
    const clean = sanitizeSvg(Buffer.from(VALID_SVG, 'utf-8')).toString('utf-8');
    assert.ok(clean.includes('xmlns="http://www.w3.org/2000/svg"'));
    assert.ok(clean.includes('viewBox'));
    assert.ok(clean.includes('Logo'));
  });

  it('removes <iframe> and <object> tags', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><iframe src="x"/><object data="x"/></svg>`;
    const clean = sanitizeSvg(Buffer.from(dirty, 'utf-8')).toString('utf-8');
    assert.ok(!clean.includes('<iframe'));
    assert.ok(!clean.includes('<object'));
  });

  it('preserves xmlns attribute when present', () => {
    const withXmlns = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect/></svg>`;
    const clean = sanitizeSvg(Buffer.from(withXmlns, 'utf-8')).toString('utf-8');
    assert.ok(clean.includes('xmlns'));
  });
});

// ─── validateSvgBuffer ──────────────────────────────────────────────────────

describe('validateSvgBuffer', () => {
  it('accepts valid SVG buffer', () => {
    const buf = Buffer.from(VALID_SVG, 'utf-8');
    const result = validateSvgBuffer(buf);
    assert.equal(result.valid, true);
  });

  it('rejects buffer that is not valid SVG', () => {
    const buf = Buffer.from('<html>not svg</html>', 'utf-8');
    const result = validateSvgBuffer(buf);
    assert.equal(result.valid, false);
  });
});

// ─── parseSvgDimensions ─────────────────────────────────────────────────────

describe('parseSvgDimensions', () => {
  it('parses width and height from viewBox', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"/>`;
    const dims = parseSvgDimensions(svg);
    assert.equal(dims.width, 200);
    assert.equal(dims.height, 60);
  });

  it('parses explicit width/height attributes', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100"/>`;
    const dims = parseSvgDimensions(svg);
    assert.equal(dims.width, 300);
    assert.equal(dims.height, 100);
  });

  it('returns undefined dimensions for invalid SVG', () => {
    const dims = parseSvgDimensions('not svg');
    assert.equal(dims.width, undefined);
    assert.equal(dims.height, undefined);
  });

  it('parses viewBox with decimal values (keeps decimals)', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128.5 64.25"/>`;
    const dims = parseSvgDimensions(svg);
    assert.equal(dims.width, 128.5);
    assert.equal(dims.height, 64.25);
  });

  it('prefers viewBox over width/height when both present', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300" viewBox="0 0 200 60"/>`;
    const dims = parseSvgDimensions(svg);
    assert.equal(dims.width, 200);
    assert.equal(dims.height, 60);
  });
});

// ─── Logo Size Presets ──────────────────────────────────────────────────────

describe('Logo size presets', () => {
  it('LOGO_SIZE_PRESETS has expected keys', () => {
    assert.ok(typeof LOGO_SIZE_PRESETS === 'object');
    assert.ok(LOGO_SIZE_PRESETS !== null);
    const keys = Object.keys(LOGO_SIZE_PRESETS);
    assert.ok(keys.includes('original'));
    assert.ok(keys.includes('small'));
    assert.ok(keys.includes('medium'));
    assert.ok(keys.includes('large'));
    assert.ok(keys.includes('custom'));
  });

  it('original preset has width=0', () => {
    assert.equal(LOGO_SIZE_PRESETS.original.width, 0);
  });

  it('small preset has width=24', () => {
    assert.equal(LOGO_SIZE_PRESETS.small.width, 24);
  });

  it('medium preset has width=32', () => {
    assert.equal(LOGO_SIZE_PRESETS.medium.width, 32);
  });

  it('large preset has width=48', () => {
    assert.equal(LOGO_SIZE_PRESETS.large.width, 48);
  });
});

// ─── getLogoDisplayDimensions ───────────────────────────────────────────────

describe('getLogoDisplayDimensions', () => {
  it('returns 64xnull for null preset (original)', () => {
    const dims = getLogoDisplayDimensions(null);
    assert.equal(dims.width, 64);
    assert.equal(dims.height, null);
  });

  it('returns 64xnull for original preset', () => {
    const dims = getLogoDisplayDimensions('original');
    assert.equal(dims.width, 64);
    assert.equal(dims.height, null);
  });

  it('returns 24xnull for small preset', () => {
    const dims = getLogoDisplayDimensions('small');
    assert.equal(dims.width, 24);
    assert.equal(dims.height, null);
  });

  it('returns 32xnull for medium preset', () => {
    const dims = getLogoDisplayDimensions('medium');
    assert.equal(dims.width, 32);
    assert.equal(dims.height, null);
  });

  it('returns customWidth when custom preset with customWidth', () => {
    const dims = getLogoDisplayDimensions('custom', 100, 50);
    assert.equal(dims.width, 100);
    assert.equal(dims.height, 50);
  });

  it('returns 64xnull for custom preset without customWidth', () => {
    const dims = getLogoDisplayDimensions('custom');
    assert.equal(dims.width, 64);
    assert.equal(dims.height, null);
  });
});
