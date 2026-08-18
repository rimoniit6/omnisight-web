/**
 * Consent Management seed — regression tests for the realistic seeded policies
 * (src/lib/consent.ts POLICY_TEXT, consumed by the dev seed and by
 * GET /api/consent/policies as the per-type published policy source).
 *
 * Product-truthfulness guard: the seeded policy text must describe the ACTUAL
 * WorkLensAI implementation. It must NOT claim collection the product does not
 * perform (full URLs/query strings, continuous screenshots, always-on USB
 * monitoring, etc.) and must mark availability-gated features honestly.
 *
 * Run: npx tsx --test tests/consent-seed.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPolicyText } from '../src/lib/consent';

const EXPECTED_TITLES: Record<string, string> = {
  monitoring: 'Employee Monitoring & Activity Collection Policy',
  screenshot: 'Screenshot Monitoring Policy',
  activity_tracking: 'Website & Application Monitoring Policy',
  keystroke: 'Keystroke Logging Policy',
  usb_monitoring: 'USB Device Monitoring Policy',
  webcam_access: 'Webcam Access Policy',
  location: 'Location Tracking Policy',
  email_monitoring: 'Email Monitoring Policy',
};

test('CS-01: every consent type has a realistic, non-generic policy', () => {
  for (const [type, title] of Object.entries(EXPECTED_TITLES)) {
    const p = defaultPolicyText(type);
    assert.equal(p.title, title, `title for ${type}`);
    assert.ok(p.content.length > 250, `${type} content is substantive (got ${p.content.length} chars)`);
    // No placeholder/generic fallback content.
    assert.ok(!p.content.includes('This policy describes how'), `${type} is not the generic fallback`);
  }
});

test('CS-02: monitoring policy covers agent activity collection without unsupported claims', () => {
  const p = defaultPolicyText('monitoring').content;
  for (const term of ['Desktop Agent', 'consent', 'productivity']) {
    assert.ok(p.includes(term), `monitoring mentions ${term}`);
  }
});

test('CS-03: screenshot policy is honest about configured/periodic capture', () => {
  const p = defaultPolicyText('screenshot').content;
  assert.ok(/not continuous/.test(p), 'explicitly not continuous capture');
  assert.ok(/configuration/.test(p), 'capture gated by organization configuration');
  assert.ok(/consent/.test(p), 'capture gated by consent');
});

test('CS-04: activity/website policy preserves URL privacy (no full-URL collection claim)', () => {
  const p = defaultPolicyText('activity_tracking').content;
  assert.ok(/domain/i.test(p), 'domain-based tracking');
  assert.ok(/never stored/i.test(p), 'full URLs/query strings never stored');
  assert.ok(!/collects full URLs|stores full URLs|query strings are collected|full URLs are collected/i.test(p),
    'never claims full-URL collection');
});

test('CS-05: availability-gated features are marked honestly (no false claims)', () => {
  // USB monitoring, webcam, location, email, keystroke are all availability-
  // gated ("subject to the deployed Agent version and organization
  // configuration") — the product must not claim they are active by default.
  for (const type of ['usb_monitoring', 'webcam_access', 'location', 'email_monitoring', 'keystroke']) {
    const p = defaultPolicyText(type).content;
    assert.ok(/subject to the deployed Agent version and organization configuration/i.test(p),
      `${type} marks availability honestly`);
  }
  // Break/privacy controls: only describe as subject to availability.
  assert.ok(/subject to availability/.test(defaultPolicyText('screenshot').content),
    'screenshot policy marks break/privacy controls as availability-gated');
});

test('CS-06: no unsupported legal-compliance certifications are claimed', () => {
  for (const type of Object.keys(EXPECTED_TITLES)) {
    const content = defaultPolicyText(type).content;
    assert.ok(!/GDPR[- ]certif|CCPA[- ]certif|legally certified|compliant with GDPR and CCPA/i.test(content),
      `${type} does not claim legal certification`);
  }
});

test('CS-07: consent withdrawal and retention are described without overclaiming deletion', () => {
  // The consent lifecycle supports revocation (see Consent model statuses and
  // the hardening audit); the seeded policy text must not promise automatic
  // historical-data deletion, which the product does not perform.
  const monitoring = defaultPolicyText('monitoring').content;
  assert.ok(!/automatically deleted|historical data is deleted/i.test(monitoring),
    'no automatic-deletion overclaim');
  assert.ok(/retention configuration/i.test(monitoring), 'retention described as configured');
});
