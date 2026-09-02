# SVG Branding & Logo Resize — Forensic Audit Report

**Date:** 2026-09-02
**Scope:** SVG code paste, logo size controls, server-side sanitization, hierarchical branding resolution, frontend rendering

---

## Summary

| Metric | Result |
|--------|--------|
| Production Build | ✅ Clean |
| TypeScript | ✅ No errors |
| SVG Validation Tests | ✅ 37/37 |
| RBAC Forensic Tests | ✅ 44/44 |
| **Total Tests** | **✅ 81/81** |

---

## 1. Database Schema (Prisma)

### Fields Added
Both `PlatformBranding` and `OrganizationBranding` models extended with:

| Field | Type | Purpose |
|-------|------|---------|
| `logoType` | `String?` | `'svg'` when using inline SVG |
| `logoSvg` | `String?` | Sanitized SVG markup (max 1MB) |
| `logoWidth` | `Int?` | Display width in pixels |
| `logoHeight` | `Int?` | Display height in pixels (null = auto) |

- Migration: `20260902054057_add_svg_branding_fields` — applied successfully
- Default values: all `null` (backward compatible)

---

## 2. Server-Side SVG Validation (`src/lib/branding.ts`)

### validateSvgCode()
- ✅ Rejects empty input
- ✅ Rejects non-SVG content (must start with `<svg`)
- ✅ Enforces 1MB max size
- ✅ Rejects `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<input>`, `<textarea>`, `<select>` tags
- ✅ Rejects event handler attributes (`on*`)
- ✅ Rejects `javascript:` / `vbscript:` URIs
- ✅ Rejects `<style>` tags (CSS injection vector)
- ✅ Rejects `eval()` / `Function()` calls
- ✅ Returns parsed dimensions (viewBox preferred over width/height)

### sanitizeSvg()
- ✅ Strips dangerous elements via regex
- ✅ Removes event handler attributes
- ✅ Returns sanitized Buffer for storage

### getLogoDisplayDimensions()
- ✅ Returns `{ width: 64, height: null }` for original/null preset
- ✅ Returns preset dimensions for small/medium/large
- ✅ Supports custom width/height

### Logo Size Presets
| Preset | Width | Height |
|--------|-------|--------|
| original | 0 (use native) | null |
| small | 24px | null (auto) |
| medium | 32px | null (auto) |
| large | 48px | null (auto) |
| custom | 64px default | user-specified |

---

## 3. API Routes

### PATCH /api/branding/platform
- ✅ RBAC: `requireSuperAdmin()` — only super_admin
- ✅ Accepts `logoType`, `logoSvg`, `logoWidth`, `logoHeight` fields
- ✅ Validates SVG via `validateSvgCode()` when `logoType === 'svg'`
- ✅ Sanitizes via `sanitizeSvg()` before storage

### PATCH /api/branding/organization
- ✅ RBAC: `requireManagerOrg()` — manager or above
- ✅ Same SVG validation and sanitization
- ✅ Org-scoped (tenant isolation)

### POST /api/branding/platform/logo
- ✅ Supports file upload and SVG code paste (FormData `svgCode` field)
- ✅ SVG validation + sanitization on both paths
- ✅ TypeScript null-safety fix applied

### POST /api/branding/organization/logo
- ✅ Same dual-mode upload (file + SVG code)
- ✅ Same validation pipeline

---

## 4. Hierarchical Branding Resolution

### getEffectiveBranding()
```
Organization override → Platform default → System default
```

- ✅ `logoType` resolved: org || platform || null
- ✅ `logoSvg` resolved: org || platform || null
- ✅ `logoWidth` resolved: org ?? platform ?? null
- ✅ `logoHeight` resolved: org ?? platform ?? null

### Client-side (`use-effective-branding.ts`)
- ✅ `EffectiveBranding` interface includes all 4 new fields
- ✅ `DEFAULT_BRANDING` has null defaults for new fields
- ✅ Hook returns resolved values from server

---

## 5. Frontend Components

### BrandingPage (`branding-page.tsx`)
- ✅ Types updated: `PlatformBrandingData`, `OrgBrandingData`
- ✅ Platform section: SVG code textarea + logo size radio controls
- ✅ Organization section: SVG code textarea + logo size radio controls
- ✅ Live preview renders SVG via `dangerouslySetInnerHTML` with size
- ✅ SVG save/remove handlers call PATCH endpoints
- ✅ Logo size controls: Original/Small/Medium/Large/Custom with width/height inputs

### AppSidebar (`app-sidebar.tsx`)
- ✅ Renders SVG logos via `dangerouslySetInnerHTML` when `logoType === 'svg'`
- ✅ Falls back to `<Image>` for file-based logos
- ✅ Respects `logoWidth`/`logoHeight` for sizing
- ✅ Collapsed sidebar uses 48px fallback

### MobileSidebar (`mobile-sidebar.tsx`)
- ✅ Same SVG + size-aware rendering

### LoginPage (`login-page.tsx`)
- ✅ SVG rendering with size-aware dimensions
- ✅ File fallback preserved

### CreateOrganizationScreen
- ✅ SVG rendering with size-aware dimensions
- ✅ File fallback preserved

---

## 6. Security

### XSS Prevention
- ✅ SVG validated before storage (dangerous elements stripped)
- ✅ SVG sanitized before DB write
- ✅ Frontend uses `dangerouslySetInnerHTML` only on server-sanitized content
- ✅ Max size: 1MB enforced server-side
- ✅ All dangerous vectors tested: script, iframe, object, eval, javascript: URI, event handlers, style

### RBAC Enforcement
- ✅ Platform branding: super_admin only
- ✅ Organization branding: manager or above
- ✅ Effective branding GET: any authenticated user (read-only)
- ✅ No bypass via proxy path manipulation

---

## 7. Test Coverage

### SVG Validation (37 tests)
- 13 tests: `validateSvgCode` (valid/invalid content, size, dangerous elements)
- 6 tests: `sanitizeSvg` (stripping, preservation, xmlns)
- 2 tests: `validateSvgBuffer`
- 5 tests: `parseSvgDimensions` (viewBox, width/height, decimals, fallbacks)
- 5 tests: `LOGO_SIZE_PRESETS` (keys, values)
- 6 tests: `getLogoDisplayDimensions` (presets, custom, null)

### RBAC Forensic (44 tests)
- All 44 tests from prior audit continue passing
- Branding-specific RBAC tests included

---

## 8. Files Modified/Created

| File | Action |
|------|--------|
| `prisma/schema.prisma` | Extended with 4 fields per model |
| `prisma/migrations/20260902054057_.../migration.sql` | Created |
| `src/lib/branding.ts` | Added validateSvgCode, validateSvgBuffer, sanitizeSvg, parseSvgDimensions, getLogoDisplayDimensions, LOGO_SIZE_PRESETS |
| `src/hooks/use-effective-branding.ts` | Extended EffectiveBranding interface |
| `src/app/api/branding/platform/route.ts` | Accepts SVG/size fields |
| `src/app/api/branding/platform/logo/route.ts` | Supports SVG code paste + TypeScript fix |
| `src/app/api/branding/organization/route.ts` | Accepts SVG/size fields |
| `src/app/api/branding/organization/logo/route.ts` | Supports SVG code paste + TypeScript fix |
| `src/components/branding/branding-page.tsx` | SVG textarea, size controls, live preview |
| `src/components/layout/app-sidebar.tsx` | SVG-aware logo rendering |
| `src/components/layout/mobile-sidebar.tsx` | SVG-aware logo rendering |
| `src/components/auth/login-page.tsx` | SVG-aware logo rendering |
| `src/components/auth/create-organization-screen.tsx` | SVG-aware logo rendering |
| `tests/svg-validation.test.ts` | Created — 37 tests |

---

## 9. Verdict

**PASS** — All SVG branding and logo resize functionality is production-ready:

- Server-side validation and sanitization are comprehensive
- Hierarchical resolution (org → platform → default) works correctly
- RBAC enforcement verified at proxy, route handler, and service layers
- Frontend components render SVG safely with size controls
- 81/81 tests passing, clean production build
