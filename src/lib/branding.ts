/**
 * OmniSight — Hierarchical Branding Service
 *
 * Resolves the effective branding by merging:
 *   Organization override → Platform branding → Built-in defaults
 *
 * This is the SINGLE source of truth for branding resolution.
 * Every consumer (API, UI, PDF, metadata) must go through this service.
 */

import { db } from '@/lib/db';
import { log } from '@/lib/logger';

// ─── Built-in Defaults (fallback of last resort) ───────────────────────────

export const DEFAULT_BRANDING = {
  brandName: 'OmniSight',
  logoUrl: '/logos/omnisight.svg',
  faviconUrl: '/favicon.svg',
  primaryColor: '#059669',
  browserTitle: 'OmniSight - AI-Powered Workforce Intelligence',
  tagline: 'REMOTE INSIGHTS',
} as const;

// ─── Effective Branding Type ────────────────────────────────────────────────

export interface EffectiveBranding {
  brandName: string;
  logoUrl: string;
  faviconUrl: string;
  primaryColor: string;
  browserTitle: string;
  tagline: string;
  /** Whether this branding came from an organization override (vs platform/default) */
  isOrganizationOverride: boolean;
  /** Logo source type: 'file' for uploaded image, 'svg' for inline SVG code */
  logoType: string | null;
  /** Sanitized inline SVG code (when logoType is 'svg') */
  logoSvg: string | null;
  /** Logo display width in px (null = original/default) */
  logoWidth: number | null;
  /** Logo display height in px (null = auto from aspect ratio) */
  logoHeight: number | null;
}

// ─── Cache (per-request, short-lived) ───────────────────────────────────────
// Simple in-memory cache with TTL to avoid repeated DB hits within a single
// request lifecycle. NOT a persistent cache — invalidation happens on write.
// Cache keys include organizationId to prevent cross-org leakage.

const brandingCache = new Map<string, { branding: EffectiveBranding; ts: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

function getCachedBranding(key: string): EffectiveBranding | null {
  const entry = brandingCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    brandingCache.delete(key);
    return null;
  }
  return entry.branding;
}

function setCachedBranding(key: string, branding: EffectiveBranding): void {
  brandingCache.set(key, { branding, ts: Date.now() });
}

/** Invalidate cached branding for a specific organization or platform. */
export function invalidateBrandingCache(organizationId?: string | null): void {
  if (organizationId) {
    brandingCache.delete(`org:${organizationId}`);
    brandingCache.delete(`org-raw:${organizationId}`);
  }
  brandingCache.delete('platform');
}

// ─── Color Validation ───────────────────────────────────────────────────────

const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Reject dangerous CSS values (url(), expression(), javascript:, etc.) */
const DANGEROUS_CSS_PATTERNS = [
  /expression\s*\(/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /url\s*\(/i,
  /<\s*script/i,
  /<\s*style/i,
  /@import/i,
  /behavior\s*:/i,
];

export function isValidHexColor(color: string): boolean {
  if (!HEX_COLOR_REGEX.test(color)) return false;
  return !DANGEROUS_CSS_PATTERNS.some((p) => p.test(color));
}

// ─── String Validation ──────────────────────────────────────────────────────

const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export function isValidBrandName(name: string): boolean {
  if (typeof name !== 'string') return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return false;
  if (CONTROL_CHAR_REGEX.test(trimmed)) return false;
  return true;
}

export function isValidBrowserTitle(title: string): boolean {
  if (typeof title !== 'string') return false;
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return false;
  if (CONTROL_CHAR_REGEX.test(trimmed)) return false;
  return true;
}

export function isValidTagline(tagline: string): boolean {
  if (typeof tagline !== 'string') return false;
  const trimmed = tagline.trim();
  if (trimmed.length === 0 || trimmed.length > 100) return false;
  if (CONTROL_CHAR_REGEX.test(trimmed)) return false;
  return true;
}

// ─── Core: Get Platform Branding ────────────────────────────────────────────

async function getPlatformBranding(): Promise<{
  brandName?: string | null;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  primaryColor?: string | null;
  browserTitle?: string | null;
  tagline?: string | null;
  logoType?: string | null;
  logoSvg?: string | null;
  logoWidth?: number | null;
  logoHeight?: number | null;
}> {
  const cached = getCachedBranding('platform');
  if (cached) return cached;

  try {
    const row = await db.platformBranding.findFirst();
    if (!row) return {};

    const result = {
      brandName: row.brandName,
      logoUrl: row.logoUrl,
      faviconUrl: row.faviconUrl,
      primaryColor: row.primaryColor,
      browserTitle: row.browserTitle,
      tagline: row.tagline,
      logoType: row.logoType,
      logoSvg: row.logoSvg,
      logoWidth: row.logoWidth,
      logoHeight: row.logoHeight,
    };

    const branding: EffectiveBranding = {
      brandName: result.brandName || DEFAULT_BRANDING.brandName,
      logoUrl: result.logoUrl || DEFAULT_BRANDING.logoUrl,
      faviconUrl: result.faviconUrl || DEFAULT_BRANDING.faviconUrl,
      primaryColor: result.primaryColor || DEFAULT_BRANDING.primaryColor,
      browserTitle: result.browserTitle || DEFAULT_BRANDING.browserTitle,
      tagline: result.tagline || DEFAULT_BRANDING.tagline,
      isOrganizationOverride: false,
      logoType: result.logoType || null,
      logoSvg: result.logoSvg || null,
      logoWidth: result.logoWidth ?? null,
      logoHeight: result.logoHeight ?? null,
    };

    setCachedBranding('platform', branding);
    return result;
  } catch (error) {
    log.error('branding.platform_fetch_failed', { error: String(error) });
    return {};
  }
}

// ─── Core: Get Organization Branding ────────────────────────────────────────

async function getOrganizationBranding(
  organizationId: string
): Promise<{
  brandName?: string | null;
  logoUrl?: string | null;
  faviconUrl?: string | null;
  primaryColor?: string | null;
  browserTitle?: string | null;
  tagline?: string | null;
  logoType?: string | null;
  logoSvg?: string | null;
  logoWidth?: number | null;
  logoHeight?: number | null;
} | null> {
  const cacheKey = `org-raw:${organizationId}`;
  const cached = getCachedBranding(cacheKey);
  if (cached) return cached;

  try {
    const row = await db.organizationBranding.findUnique({
      where: { organizationId },
    });
    if (!row) return null;

    return {
      brandName: row.brandName,
      logoUrl: row.logoUrl,
      faviconUrl: row.faviconUrl,
      primaryColor: row.primaryColor,
      browserTitle: row.browserTitle,
      tagline: row.tagline,
      logoType: row.logoType,
      logoSvg: row.logoSvg,
      logoWidth: row.logoWidth,
      logoHeight: row.logoHeight,
    };
  } catch (error) {
    log.error('branding.org_fetch_failed', { organizationId, error: String(error) });
    return null;
  }
}

// ─── Public: Get Effective Branding ─────────────────────────────────────────

/**
 * Resolve the effective branding for a given organization context.
 *
 * Fallback chain:
 *   OrganizationBranding (non-null fields)
 *   → PlatformBranding (non-null fields)
 *   → DEFAULT_BRANDING (built-in defaults)
 */
export async function getEffectiveBranding(
  organizationId?: string | null
): Promise<EffectiveBranding> {
  const cacheKey = organizationId ? `org:${organizationId}` : 'platform';
  const cached = getCachedBranding(cacheKey);
  if (cached) return cached;

  const platform = await getPlatformBranding();
  const org = organizationId ? await getOrganizationBranding(organizationId) : null;

  const effective: EffectiveBranding = {
    brandName:
      org?.brandName || platform.brandName || DEFAULT_BRANDING.brandName,
    logoUrl:
      org?.logoUrl || platform.logoUrl || DEFAULT_BRANDING.logoUrl,
    faviconUrl:
      org?.faviconUrl || platform.faviconUrl || DEFAULT_BRANDING.faviconUrl,
    primaryColor:
      org?.primaryColor || platform.primaryColor || DEFAULT_BRANDING.primaryColor,
    browserTitle:
      org?.browserTitle || platform.browserTitle || DEFAULT_BRANDING.browserTitle,
    tagline:
      org?.tagline || platform.tagline || DEFAULT_BRANDING.tagline,
    isOrganizationOverride: !!(org && (
      org.brandName || org.logoUrl || org.faviconUrl ||
      org.primaryColor || org.browserTitle || org.tagline ||
      org.logoType || org.logoSvg || org.logoWidth || org.logoHeight
    )),
    logoType: org?.logoType || platform.logoType || null,
    logoSvg: org?.logoSvg || platform.logoSvg || null,
    logoWidth: org?.logoWidth ?? platform.logoWidth ?? null,
    logoHeight: org?.logoHeight ?? platform.logoHeight ?? null,
  };

  setCachedBranding(cacheKey, effective);
  return effective;
}

// ─── Public: Get Raw Platform Branding (for admin UI) ───────────────────────

export async function getRawPlatformBranding() {
  const row = await db.platformBranding.findFirst();
  return row || {
    id: '',
    brandName: DEFAULT_BRANDING.brandName,
    logoUrl: null,
    logoType: null,
    logoSvg: null,
    logoWidth: null,
    logoHeight: null,
    faviconUrl: null,
    primaryColor: null,
    browserTitle: null,
    tagline: DEFAULT_BRANDING.tagline,
    updatedAt: new Date(),
    updatedBy: null,
  };
}

// ─── Public: Get Raw Org Branding (for admin UI) ────────────────────────────

export async function getRawOrganizationBranding(organizationId: string) {
  const row = await db.organizationBranding.findUnique({
    where: { organizationId },
  });
  return row;
}

// ─── SVG Sanitization ───────────────────────────────────────────────────────

/**
 * Sanitize SVG content to prevent XSS. Removes:
 * - <script> tags and their contents
 * - Event handler attributes (onload, onclick, etc.)
 * - <foreignObject>, <iframe>, <embed>, <object>, <applet> (can embed HTML)
 * - <use> elements (can reference external resources via xlink:href)
 * - <image> elements (can reference external URLs)
 * - javascript: and vbscript: URIs
 * - data: URIs in href/src (except data:image)
 * - xlink:href with dangerous values
 * - xml processing instructions
 * - CDATA sections (can hide script content)
 * - <style> elements (CSS injection vector)
 * - eval(), expression(), Function()
 */
export function sanitizeSvg(svgContent: Buffer): Buffer {
  let content = svgContent.toString('utf-8');

  // Remove XML processing instructions (e.g., <?xml-stylesheet ...?>)
  content = content.replace(/<\?[\s\S]*?\?>/gi, '');

  // Remove CDATA sections (can hide script content)
  content = content.replace(/<!\[CDATA\[[\s\S]*?\]\]>/gi, '');

  // Remove <script> tags and contents
  content = content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // Remove event handler attributes (on*)
  content = content.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // Remove dangerous elements
  content = content.replace(/<(foreignObject|iframe|embed|object|applet|use|image)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  content = content.replace(/<(foreignObject|iframe|embed|object|applet|use|image)\b[^>]*\/?>/gi, '');

  // Remove javascript: and vbscript: URIs in all attribute contexts
  content = content.replace(/(href|src|action|background|dynsrc|lowsrc)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '');
  content = content.replace(/(href|src|action|background|dynsrc|lowsrc)\s*=\s*(?:"vbscript:[^"]*"|'vbscript:[^']*'|vbscript:[^\s>]+)/gi, '');

  // Remove data: URIs in href/src (except data:image/*)
  content = content.replace(/(href|src|action)\s*=\s*(?:"data:(?!image)[^"]*"|'data:(?!image)[^']*'|data:(?!image)[^\s>]+)/gi, '');

  // Remove xlink:href with dangerous values
  content = content.replace(/xlink:href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, '');
  content = content.replace(/xlink:href\s*=\s*(?:"data:(?!image)[^"]*"|'data:(?!image)[^']*'|data:(?!image)[^\s>]+)/gi, '');

  // Remove <style> elements (CSS injection vector)
  content = content.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove eval(), expression(), and Function() patterns in any context
  content = content.replace(/\beval\s*\(/gi, '');
  content = content.replace(/\bFunction\s*\(/gi, '');
  content = content.replace(/expression\s*\(/gi, '');

  return Buffer.from(content, 'utf-8');
}

// ─── SVG Validation ─────────────────────────────────────────────────────────

const MAX_SVG_SIZE = 1 * 1024 * 1024; // 1MB

/** Dangerous SVG elements that can embed HTML or reference external resources */
const DANGEROUS_ELEMENTS = [
  'script', 'foreignobject', 'iframe', 'embed', 'object', 'applet',
  'handler', 'foreignObject',
];

/** Dangerous attribute patterns */
const DANGEROUS_ATTR_PATTERNS = [
  /^on/i,              // event handlers (onclick, onload, etc.)
  /javascript\s*:/i,   // javascript URIs
  /vbscript\s*:/i,     // vbscript URIs
  /expression\s*\(/i,  // CSS expressions
  /data\s*:/i,         // data URIs (except in specific contexts)
];

export interface SvgValidationResult {
  valid: boolean;
  error?: string;
  width?: number;
  height?: number;
  viewBox?: string;
}

/**
 * Validate SVG code (string input from paste).
 * Returns validation result with optional dimensions.
 */
export function validateSvgCode(svgCode: string): SvgValidationResult {
  if (typeof svgCode !== 'string') {
    return { valid: false, error: 'Invalid SVG input' };
  }

  const trimmed = svgCode.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'SVG code is empty' };
  }

  if (trimmed.length > MAX_SVG_SIZE) {
    return { valid: false, error: 'SVG exceeds maximum size of 1MB' };
  }

  // Must start with <svg (allow XML declaration before it)
  const withoutXmlDecl = trimmed.replace(/<\?xml[^?]*\?>/gi, '').trim();
  if (!withoutXmlDecl.toLowerCase().startsWith('<svg')) {
    return { valid: false, error: 'Invalid SVG: must contain an <svg> root element' };
  }

  // Check for balanced tags (basic well-formedness)
  const svgTagMatch = withoutXmlDecl.match(/<svg\b[^>]*>/i);
  if (!svgTagMatch) {
    return { valid: false, error: 'Invalid SVG: malformed <svg> element' };
  }

  // Check for dangerous elements
  const lowerContent = withoutXmlDecl.toLowerCase();
  for (const elem of DANGEROUS_ELEMENTS) {
    const regex = new RegExp(`<${elem}\\b`, 'i');
    if (regex.test(lowerContent)) {
      return { valid: false, error: `This SVG contains unsupported or unsafe content: <${elem}>` };
    }
  }

  // Check for event handler attributes
  if (/\s+on\w+\s*=/i.test(withoutXmlDecl)) {
    return { valid: false, error: 'This SVG contains unsupported or unsafe content: event handlers' };
  }

  // Check for javascript: / vbscript: URIs
  if (/(?:href|src|action)\s*=\s*(?:"javascript:|'javascript:|javascript:)/i.test(withoutXmlDecl)) {
    return { valid: false, error: 'This SVG contains unsupported or unsafe content: javascript URI' };
  }
  if (/(?:href|src|action)\s*=\s*(?:"vbscript:|'vbscript:|vbscript:)/i.test(withoutXmlDecl)) {
    return { valid: false, error: 'This SVG contains unsupported or unsafe content: vbscript URI' };
  }

  // Check for <style> (CSS injection vector)
  if (/<style\b/i.test(withoutXmlDecl)) {
    return { valid: false, error: 'This SVG contains unsupported or unsafe content: <style>' };
  }

  // Check for eval/Function
  if (/\beval\s*\(/i.test(withoutXmlDecl) || /\bFunction\s*\(/i.test(withoutXmlDecl)) {
    return { valid: false, error: 'This SVG contains unsupported or unsafe content: eval/Function' };
  }

  // Extract dimensions
  const dims = parseSvgDimensions(withoutXmlDecl);

  return {
    valid: true,
    width: dims.width,
    height: dims.height,
    viewBox: dims.viewBox,
  };
}

/**
 * Validate uploaded SVG file buffer.
 * Returns validation result with sanitized buffer.
 */
export function validateSvgBuffer(svgBuffer: Buffer): { valid: boolean; error?: string; sanitized?: Buffer } {
  if (svgBuffer.length > MAX_SVG_SIZE) {
    return { valid: false, error: 'SVG exceeds maximum size of 1MB' };
  }

  const content = svgBuffer.toString('utf-8');
  const result = validateSvgCode(content);

  if (!result.valid) {
    return { valid: false, error: result.error };
  }

  return { valid: true, sanitized: sanitizeSvg(svgBuffer) };
}

/**
 * Parse SVG dimensions from viewBox, width, and height attributes.
 */
export function parseSvgDimensions(svgContent: string): {
  width?: number;
  height?: number;
  viewBox?: string;
} {
  const viewBoxMatch = svgContent.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  const widthMatch = svgContent.match(/\bwidth\s*=\s*["'](\d+(?:\.\d+)?)["']/i);
  const heightMatch = svgContent.match(/\bheight\s*=\s*["'](\d+(?:\.\d+)?)["']/i);

  let width: number | undefined;
  let height: number | undefined;
  let viewBox: string | undefined;

  if (viewBoxMatch) {
    viewBox = viewBoxMatch[1];
    const parts = viewBox.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
      width = parts[2];
      height = parts[3];
    }
  }

  if (!width && widthMatch) width = Math.round(Number(widthMatch[1]));
  if (!height && heightMatch) height = Math.round(Number(heightMatch[1]));

  return { width, height, viewBox };
}

// ─── Logo Size Configuration ────────────────────────────────────────────────

export type LogoSizePreset = 'original' | 'small' | 'medium' | 'large' | 'custom';

export const LOGO_SIZE_PRESETS: Record<LogoSizePreset, { width: number; height: number | null; label: string }> = {
  original: { width: 0, height: null, label: 'Original / Default' },
  small:    { width: 24, height: null, label: 'Small' },
  medium:   { width: 32, height: null, label: 'Medium' },
  large:    { width: 48, height: null, label: 'Large' },
  custom:   { width: 64, height: null, label: 'Custom' },
};

export function isValidLogoSize(size: string): size is LogoSizePreset {
  return size in LOGO_SIZE_PRESETS;
}

export function getLogoDisplayDimensions(
  preset: LogoSizePreset | null | undefined,
  customWidth?: number | null,
  customHeight?: number | null,
  originalWidth?: number | null,
  originalHeight?: number | null,
): { width: number; height: number | null } {
  if (!preset || preset === 'original') {
    return { width: originalWidth ?? 64, height: originalHeight ?? null };
  }

  const presetConfig = LOGO_SIZE_PRESETS[preset];
  if (preset === 'custom') {
    const w = customWidth && customWidth > 0 ? customWidth : presetConfig.width;
    const h = customHeight && customHeight > 0 ? customHeight : null;
    return { width: w, height: h };
  }

  return { width: presetConfig.width, height: presetConfig.height };
}
