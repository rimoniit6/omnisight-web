/**
 * Branding regression guard (rebrand WorkLensAI → OmniSight).
 *
 * User-facing surfaces must never render the legacy brand, while technical
 * identifiers (cookie name, storage keys, data directory, process exclusions,
 * legacy env alias, native host / extension identities) must remain intact.
 *
 * Run: npx tsx --test tests/branding-regression.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
// The `omnisight-agent` component lives in a SEPARATE sibling repository
// (E:\Live project\omnisight\omnisight-agent), not inside the web checkout.
// `omnisight-agent/...` paths below resolve there; `src/...` and
// `browser-extension/...` resolve within the web repo.
const AGENT_ROOT = resolve(ROOT, '..', 'omnisight-agent');
const resolvePath = (rel: string) => (rel.startsWith('omnisight-agent/') ? join(AGENT_ROOT, rel.slice('omnisight-agent/'.length)) : join(ROOT, rel));

// `AGENT_PRESENT`: true when the sibling agent repo is checked out, so these
// tests run against the real source; otherwise they skip cleanly (portability).
const AGENT_PRESENT = existsSync(join(AGENT_ROOT, 'package.json'));
const agentTest = AGENT_PRESENT ? test : test.skip;

// User-facing surfaces: any leftover WorkLensAI here is a rebrand miss.
// (brand.ts previousName is allowed — it is the deliberate legacy reference.)
const USER_FACING = [
  'src/app/layout.tsx',
  'src/app/loading.tsx',
  'src/app/page.tsx',
  'src/lib/tour-steps.ts',
  'src/lib/consent.ts',
  'src/lib/pdf-generator.ts',
  'src/lib/brand.ts',
  'src/components/auth/login-page.tsx',
  'src/components/auth/create-organization-screen.tsx',
  'src/components/layout/app-sidebar.tsx',
  'src/components/layout/mobile-sidebar.tsx',
  'src/components/settings/settings-page.tsx',
  'src/components/ai-provider/ai-provider-page.tsx',
  'src/components/reports/daily-report.tsx',
  'src/app/api/reports/[id]/pdf/route.ts',
  'src/app/api/reports/pdf/audit/route.ts',
  'src/app/api/reports/pdf/activity/route.ts',
  'src/app/api/reports/pdf/dashboard/route.ts',
  'src/app/api/reports/pdf/project/route.ts',
  'src/app/api/reports/pdf/employee/route.ts',
  'src/app/api/reports/daily/ai-summary/route.ts',
  'src/app/api/export/[type]/route.ts',
  'omnisight-agent/src/renderer/index.html',
  'omnisight-agent/src/renderer/renderer.ts',
  'omnisight-agent/src/main/main.ts',
  'omnisight-agent/src/auth/auth-service.ts',
  'omnisight-agent/src/services/agent-orchestrator.ts',
  'omnisight-agent/installer/electron-builder.yml',
  'omnisight-agent/package.json',
  'browser-extension/manifest.json',
];

// Technical identifiers that MUST keep the legacy token (backward compatibility).
const TECHNICAL_CONTRACTS = [
  ['src/lib/auth.ts', 'worklens_token'],
  ['mini-services/live-updates/index.ts', 'worklens_token'],
  ['src/lib/crypto.ts', '.worklens'],
  ['src/lib/agent-process.ts', 'worklensaiagent.exe'],
  ['src/lib/policies/constants.ts', 'worklensai-agent.exe'],
  ['omnisight-agent/src/lib/internal-process.ts', 'worklensaiagent.exe'],
  ['omnisight-agent/src/collectors/policy-enforcer.ts', 'worklensai-agent.exe'],
  ['omnisight-agent/src/config/server-url.ts', 'WORKLENSAI_SERVER_URL'],
  ['omnisight-agent/src/main/main.ts', 'worklensai-agent'],
  ['omnisight-agent/native-host/launcher.c', 'worklensai-agent'],
  ['omnisight-agent/native-host-manifests/chrome.json', 'com.worklensai.website'],
  ['browser-extension/manifest.json', 'website-tracker@worklens.ai'],
];

agentTest('BRAND-1: no legacy brand in user-facing surfaces', () => {
  const misses: string[] = [];
  for (const rel of USER_FACING) {
    const abs = resolvePath(rel);
    if (!existsSync(abs)) {
      misses.push(`${rel}: FILE MISSING`);
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    for (const [line, content] of text.split('\n').entries()) {
      if (!content.includes('WorkLensAI')) continue;
      // brand.ts carries the intentional previousName reference.
      if (rel === 'src/lib/brand.ts' && (content.includes('previousName') || content.includes('previously branded'))) continue;
      // main.ts: the userData pin comment references the legacy directory
      // (technical contract — the path itself is the payload).
      if (rel === 'omnisight-agent/src/main/main.ts' && (content.includes('worklensai-agent') || content.includes('OmniSight'))) continue;
      // electron-builder.yml: launcher resolution comment mentions the exe — allow legacy mention only if paired with the new name.
      if (rel === 'omnisight-agent/installer/electron-builder.yml' && content.includes('WorkLensAI') && content.includes('OmniSight')) continue;
      misses.push(`${rel}:${line + 1}: ${content.trim()}`);
    }
  }
  assert.deepEqual(misses, [], `legacy brand leaked into user-facing surface:\n${misses.join('\n')}`);
});

test('BRAND-2: new brand present in canonical surfaces', () => {
  const abs = join(ROOT, 'src/lib/brand.ts');
  const brand = readFileSync(abs, 'utf8');
  assert.ok(brand.includes("name: 'OmniSight'"), 'BRAND.name must be OmniSight');
  assert.ok(brand.includes("previousName: 'WorkLensAI'"), 'previousName must document the legacy brand');
});

agentTest('BRAND-3: technical identifiers preserved (backward compatibility)', () => {
  const missing: string[] = [];
  for (const [rel, token] of TECHNICAL_CONTRACTS) {
    const abs = resolvePath(rel);
    if (!existsSync(abs)) {
      missing.push(`${rel}: FILE MISSING`);
      continue;
    }
    if (!readFileSync(abs, 'utf8').includes(token)) missing.push(`${rel} lost ${token}`);
  }
  assert.deepEqual(missing, [], `technical contract broken:\n${missing.join('\n')}`);
});

agentTest('BRAND-4: agent exclusions carry BOTH legacy and new binary names', () => {
  const admin = readFileSync(join(ROOT, 'src/lib/agent-process.ts'), 'utf8');
  assert.ok(admin.includes('omnisightagent.exe'), 'admin list must exclude omnisightagent.exe');
  assert.ok(admin.includes('worklensaiagent.exe'), 'admin list must keep legacy exclusion');
  const agent = readFileSync(join(AGENT_ROOT, 'src/lib/internal-process.ts'), 'utf8');
  assert.ok(agent.includes('omnisightagent.exe'), 'agent list must exclude omnisightagent.exe');
  assert.ok(agent.includes('worklensaiagent.exe'), 'agent list must keep legacy exclusion');
});

agentTest('BRAND-5: server-url supports new primary and legacy alias', () => {
  const src = readFileSync(join(AGENT_ROOT, 'src/config/server-url.ts'), 'utf8');
  assert.ok(src.includes("'OMNISIGHT_SERVER_URL'"), 'primary env key must exist');
  assert.ok(src.includes("'WORKLENSAI_SERVER_URL'"), 'legacy env alias must remain');
});

agentTest('BRAND-6: official brand assets present and referenced (no legacy artwork)', () => {
  const canonical = readFileSync(join(ROOT, 'public/logos/omnisight.svg'), 'utf8');
  for (const token of ['grad1', '<ellipse', 'M 190,250', 'OS', 'viewBox="0 0 500 500"']) {
    assert.ok(canonical.includes(token), `canonical SVG missing ${token}`);
  }
  assert.ok(!canonical.includes('<rect'), 'canonical SVG must not carry a background rect');
  for (const asset of ['public/logos/omnisight.svg', 'public/favicon.svg', 'public/favicon.ico', 'public/favicon.png', 'public/apple-touch-icon.png', 'omnisight-agent/assets/icon.ico']) {
    assert.ok(existsSync(resolvePath(asset)), `${asset} must exist`);
  }
  const faviconSvg = readFileSync(join(ROOT, 'public/favicon.svg'), 'utf8');
  assert.ok(faviconSvg.includes('viewBox="110 110 280 280"'), 'favicon SVG must use the tight-crop viewBox');
  assert.ok(faviconSvg.includes('grad1'), 'favicon SVG must carry the canonical artwork');
  assert.ok(!faviconSvg.includes('<rect'), 'favicon SVG must not add a background');
  const layout = readFileSync(join(ROOT, 'src/app/layout.tsx'), 'utf8');
  assert.ok(layout.includes('"/favicon.svg"'), 'layout must reference the SVG favicon');
  assert.ok(layout.includes('"/favicon.ico"'), 'layout must reference the ICO fallback');
  assert.ok(layout.includes('"/apple-touch-icon.png"'), 'layout must reference apple-touch icon');
  const agentMain = readFileSync(join(AGENT_ROOT, 'src/main/main.ts'), 'utf8');
  assert.ok(agentMain.includes('assets/icon.ico'), 'agent must load the branded .ico');
  const builder = readFileSync(join(AGENT_ROOT, 'installer/electron-builder.yml'), 'utf8');
  assert.ok(builder.includes('icon: assets/icon.ico'), 'installer must use the branded .ico');
  const stale = ['public/worklens-logo.png', 'public/logo.svg', 'public/branding'];
  for (const path of stale) {
    assert.ok(!existsSync(join(ROOT, path)), `${path} must be removed (legacy/duplicate artwork)`);
  }
  const legacyRefs = ['/worklens-logo.png', '/logo.svg', '/branding/', 'omnisight-mark.png'];
  for (const rel of USER_FACING) {
    const text = readFileSync(resolvePath(rel), 'utf8');
    for (const ref of legacyRefs) {
      assert.ok(!text.includes(ref), `${rel} must not reference stale artwork (${ref})`);
    }
  }
  const renderer = readFileSync(join(AGENT_ROOT, 'src/renderer/index.html'), 'utf8');
  assert.ok(renderer.includes('omnisight-mark.svg'), 'agent renderer must use the presentation derivative');
});

agentTest('BRAND-8: desktop agent logo uses the tight-crop derivative + responsive contain sizing', () => {
  const renderer = readFileSync(join(AGENT_ROOT, 'src/renderer/index.html'), 'utf8');
  assert.ok(renderer.includes('src="omnisight-mark.svg"'), 'agent header must use the presentation derivative');
  const css = readFileSync(join(AGENT_ROOT, 'src/renderer/styles.css'), 'utf8');
  assert.ok(css.includes('object-fit: contain'), 'logo must use contain rendering');
  assert.ok(css.includes('object-position: center'), 'logo must center its mark');
  assert.ok(css.includes('aspect-ratio: 1 / 1'), 'logo box must stay square (no distortion)');
  const clamp = css.match(/clamp\(\s*(\d+)px/);
  assert.ok(clamp, 'logo sizing must be responsive via clamp');
  assert.ok(Number(clamp[1]) >= 36, `clamp floor must be >= 36px (got ${clamp[1]}px)`);
  assert.ok(css.includes('flex: none'), 'logo must not shrink inside the flex header');
  const markBlock = css.slice(css.indexOf('.brand-mark'), css.indexOf('.brand h1'));
  for (const forbidden of ['background', 'border', 'box-shadow', 'border-radius']) {
    assert.ok(!markBlock.includes(forbidden), `.brand-mark must not carry ${forbidden}`);
  }
  const derivative = readFileSync(join(AGENT_ROOT, 'src/renderer/omnisight-mark.svg'), 'utf8');
  assert.ok(derivative.includes('viewBox="110 110 280 280"'), 'derivative must use the tight-crop viewBox');
  assert.ok(derivative.includes('grad1') && !derivative.includes('<rect'), 'derivative must keep artwork + transparency');
});

test('BRAND-7: brand images are displayed LARGE (no tiny-icon regressions)', () => {
  const login = readFileSync(join(ROOT, 'src/components/auth/login-page.tsx'), 'utf8');
  assert.ok(login.includes('width={112}') && login.includes('height={112}'), 'login logo must be 112px');
  const orgCreate = readFileSync(join(ROOT, 'src/components/auth/create-organization-screen.tsx'), 'utf8');
  assert.ok(orgCreate.includes('width={112}') && orgCreate.includes('height={112}'), 'org-create logo must be 112px');
  const sidebar = readFileSync(join(ROOT, 'src/components/layout/app-sidebar.tsx'), 'utf8');
  assert.ok(sidebar.includes('width={64}') && sidebar.includes('height={64}'), 'sidebar logo must be 64px');
  assert.ok(sidebar.includes('text-lg'), 'sidebar brand name must be text-lg');
  assert.ok(sidebar.includes('w-12 h-12'), 'collapsed sidebar mark must stay 48px');
  assert.ok(!sidebar.includes('w-7 h-7'), 'tiny 28px logo container must be gone');
  const mobile = readFileSync(join(ROOT, 'src/components/layout/mobile-sidebar.tsx'), 'utf8');
  assert.ok(mobile.includes('width={48}') && mobile.includes('height={48}'), 'mobile logo must be 48px');
  const loading = readFileSync(join(ROOT, 'src/app/loading.tsx'), 'utf8');
  assert.ok(loading.includes('width={96}') && loading.includes('height={96}'), 'loading mark must be 96px');
});