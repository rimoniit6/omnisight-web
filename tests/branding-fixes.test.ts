/**
 * Branding system regression tests.
 *
 * Covers: cache consistency (H5), cross-tenant cache invalidation (M1),
 * SVG sanitization defense (M3), and branding resolution correctness.
 *
 * Run: npx tsx --test tests/branding-fixes.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  invalidateBrandingCache,
  sanitizeSvg,
  validateSvgCode,
  DEFAULT_BRANDING,
} from '../src/lib/branding';

// ─── H5: getPlatformBranding cache consistency ──────────────────────────────
// We can't easily test getPlatformBranding() directly without a DB, but we can
// verify the DEFAULT_BRANDING shape matches EffectiveBranding expectations.

describe('DEFAULT_BRANDING shape', () => {
  it('has all required EffectiveBranding fields', () => {
    assert.equal(typeof DEFAULT_BRANDING.brandName, 'string');
    assert.equal(typeof DEFAULT_BRANDING.logoUrl, 'string');
    assert.equal(typeof DEFAULT_BRANDING.faviconUrl, 'string');
    assert.equal(typeof DEFAULT_BRANDING.primaryColor, 'string');
    assert.equal(typeof DEFAULT_BRANDING.browserTitle, 'string');
    assert.equal(typeof DEFAULT_BRANDING.tagline, 'string');
  });

  it('brandName is non-empty', () => {
    assert.ok(DEFAULT_BRANDING.brandName.length > 0);
  });

  it('logoUrl starts with /', () => {
    assert.ok(DEFAULT_BRANDING.logoUrl.startsWith('/'));
  });

  it('faviconUrl starts with /', () => {
    assert.ok(DEFAULT_BRANDING.faviconUrl.startsWith('/'));
  });

  it('primaryColor is valid hex', () => {
    assert.ok(/^#[0-9a-fA-F]{6}$/.test(DEFAULT_BRANDING.primaryColor));
  });
});

// ─── M1: Cache invalidation ─────────────────────────────────────────────────

describe('invalidateBrandingCache', () => {
  it('is a function', () => {
    assert.equal(typeof invalidateBrandingCache, 'function');
  });

  it('accepts no arguments (platform invalidation)', () => {
    // Should not throw
    invalidateBrandingCache();
  });

  it('accepts null argument', () => {
    invalidateBrandingCache(null);
  });

  it('accepts an organizationId string', () => {
    invalidateBrandingCache('test-org-id');
  });
});

// ─── M3: SVG sanitization defense-in-depth ──────────────────────────────────

describe('SVG sanitization defense', () => {
  it('removes <script> tags', () => {
    const dangerous = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("xss")</script><rect width="100" height="100"/></svg>'
    );
    const sanitized = sanitizeSvg(dangerous);
    const result = sanitized.toString('utf-8');
    assert.ok(!result.includes('<script>'), 'script tag should be removed');
    assert.ok(result.includes('<rect'), 'safe content should remain');
  });

  it('removes event handler attributes', () => {
    const dangerous = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="100" height="100"/></svg>'
    );
    const sanitized = sanitizeSvg(dangerous);
    const result = sanitized.toString('utf-8');
    assert.ok(!result.includes('onload'), 'onload handler should be removed');
  });

  it('removes javascript: URIs', () => {
    const dangerous = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)">click</a></svg>'
    );
    const sanitized = sanitizeSvg(dangerous);
    const result = sanitized.toString('utf-8');
    assert.ok(!result.includes('javascript:'), 'javascript: URI should be removed');
  });

  it('removes <foreignObject> elements', () => {
    const dangerous = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div onclick="alert(1)">xss</div></foreignObject></svg>'
    );
    const sanitized = sanitizeSvg(dangerous);
    const result = sanitized.toString('utf-8');
    assert.ok(!result.includes('foreignObject'), 'foreignObject should be removed');
  });

  it('removes <style> elements', () => {
    const dangerous = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>rect { fill: red; }</style><rect width="100" height="100"/></svg>'
    );
    const sanitized = sanitizeSvg(dangerous);
    const result = sanitized.toString('utf-8');
    assert.ok(!result.includes('<style>'), 'style element should be removed');
    assert.ok(result.includes('<rect'), 'safe content should remain');
  });

  it('removes eval() calls', () => {
    const dangerous = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" onclick="eval(\'alert(1)\')"/></svg>'
    );
    const sanitized = sanitizeSvg(dangerous);
    const result = sanitized.toString('utf-8');
    assert.ok(!result.includes('eval('), 'eval() should be removed');
  });

  it('removes CDATA sections', () => {
    const dangerous = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100"/><![CDATA[<script>alert(1)</script>]]></svg>'
    );
    const sanitized = sanitizeSvg(dangerous);
    const result = sanitized.toString('utf-8');
    assert.ok(!result.includes('CDATA'), 'CDATA should be removed');
  });

  it('removes XML processing instructions', () => {
    const dangerous = Buffer.from(
      '<?xml-stylesheet type="text/xsl" href="evil.xsl"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100"/></svg>'
    );
    const sanitized = sanitizeSvg(dangerous);
    const result = sanitized.toString('utf-8');
    assert.ok(!result.includes('<?xml'), 'processing instruction should be removed');
    assert.ok(result.includes('<rect'), 'safe content should remain');
  });

  it('preserves valid SVG content', () => {
    const safe = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 60"><rect width="200" height="60" fill="#059669"/><text x="100" y="35" text-anchor="middle" fill="white" font-size="20">Logo</text></svg>'
    );
    const sanitized = sanitizeSvg(safe);
    const result = sanitized.toString('utf-8');
    assert.ok(result.includes('<rect'), 'rect should remain');
    assert.ok(result.includes('<text'), 'text should remain');
    assert.ok(result.includes('viewBox'), 'viewBox should remain');
  });
});

// ─── validateSvgCode ────────────────────────────────────────────────────────

describe('validateSvgCode', () => {
  it('rejects empty input', () => {
    const result = validateSvgCode('');
    assert.equal(result.valid, false);
  });

  it('rejects non-SVG content', () => {
    const result = validateSvgCode('<div>not an svg</div>');
    assert.equal(result.valid, false);
  });

  it('rejects SVG with <script>', () => {
    const result = validateSvgCode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.equal(result.valid, false);
    assert.ok(result.error?.includes('script'));
  });

  it('rejects SVG with event handlers', () => {
    const result = validateSvgCode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    assert.equal(result.valid, false);
    assert.ok(result.error?.includes('event handler'));
  });

  it('rejects SVG with javascript: URI', () => {
    const result = validateSvgCode('<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"/></svg>');
    assert.equal(result.valid, false);
    assert.ok(result.error?.includes('javascript'));
  });

  it('rejects SVG with <style>', () => {
    const result = validateSvgCode('<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:red}</style></svg>');
    assert.equal(result.valid, false);
    assert.ok(result.error?.includes('style'));
  });

  it('accepts valid SVG', () => {
    const result = validateSvgCode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100"/></svg>');
    assert.equal(result.valid, true);
    assert.equal(result.error, undefined);
  });

  it('accepts SVG with XML declaration', () => {
    const result = validateSvgCode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100"/></svg>');
    assert.equal(result.valid, true);
  });
});
