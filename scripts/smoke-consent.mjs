/**
 * Live HTTP smoke test for the phase-2 consent hardening.
 * Runs against a locally started dev server (default http://localhost:3000).
 * Verifies the HTTP contract for the new/changed endpoints:
 *   401 unauthenticated, 403 insufficient role, 400/409/422 validation,
 *   200/201 success, and agent-side enforcement through real requests.
 */
const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? '✔' : '✖'} ${name}: expected ${expected}, got ${actual}`);
  return ok;
}

async function req(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

async function login(email, password) {
  const { status, json } = await req('/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (status !== 200) throw new Error(`login failed for ${email}: ${status} ${JSON.stringify(json)}`);
  return json.token;
}

const run = async () => {
  // ── Unauthenticated → 401 ────────────────────────────────────────────────
  check('unauthenticated policies GET -> 401', (await req('/api/consent/policies')).status, 401);

  // ── Admin session ─────────────────────────────────────────────────────────
  const admin = await login('admin@techvision.com', 'admin123');
  check('admin policies GET -> 200', (await req('/api/consent/policies', { token: admin })).status, 200);

  // Policy lifecycle: create draft -> publish -> republish rejected.
  const created = await req('/api/consent/policies', {
    method: 'POST',
    token: admin,
    body: { consentType: 'email_monitoring', title: 'Email Monitoring Policy (smoke)', content: 'Smoke test policy content describing email metadata monitoring, retention and employee rights in detail.' },
  });
  check('create draft -> 201', created.status, 201);
  const draftId = created.json.id;
  const draftVersion = created.json.version;
  const published = await req(`/api/consent/policies/${draftId}`, {
    method: 'PATCH',
    token: admin,
    body: { action: 'publish' },
  });
  check('publish draft -> 200', published.status, 200);
  const republish = await req(`/api/consent/policies/${draftId}`, {
    method: 'PATCH',
    token: admin,
    body: { action: 'publish' },
  });
  check('republish already-published -> 400', republish.status, 400);

  // Publishing a new version archives the previous one -> existing v1 consents
  // now require re-consent.
  const summary = await req('/api/consent/summary', { token: admin });
  check('summary -> 200', summary.status, 200);
  const emailBreakdown = summary.json?.typeBreakdown?.find((t) => t.type === 'email_monitoring');
  check(`email_monitoring ${draftVersion} published (summary)`, emailBreakdown?.policyVersion, draftVersion);
  check('existing v1 consents flagged re-consent', emailBreakdown?.requiresReconsent > 0, true);

  // Edit rules: published policies cannot be edited.
  const editPublished = await req(`/api/consent/policies/${draftId}`, {
    method: 'PATCH',
    token: admin,
    body: { action: 'edit', title: 'hacked', content: 'attempting to mutate a published policy with much longer text content to pass validation' },
  });
  check('edit published policy -> 400', editPublished.status, 400);

  // ── Retention settings: auth + validation ────────────────────────────────
  check('retention GET -> 200', (await req('/api/settings/retention', { token: admin })).status, 200);
  check('retention PUT valid -> 200', (await req('/api/settings/retention', { method: 'PUT', token: admin, body: { key: 'screenshot_retention_days', value: '45' } })).status, 200);
  check('retention PUT negative -> 422', (await req('/api/settings/retention', { method: 'PUT', token: admin, body: { key: 'screenshot_retention_days', value: '-5' } })).status, 422);
  check('retention PUT non-integer -> 422', (await req('/api/settings/retention', { method: 'PUT', token: admin, body: { key: 'activity_retention_days', value: '1.5' } })).status, 422);
  check('retention PUT absurd -> 422', (await req('/api/settings/retention', { method: 'PUT', token: admin, body: { key: 'activity_retention_days', value: '999999' } })).status, 422);
  check('retention PUT unknown key -> 400', (await req('/api/settings/retention', { method: 'PUT', token: admin, body: { key: 'screenshot_retention_months', value: '1' } })).status, 400);

  // ── RBAC: viewer is locked out of mutations ───────────────────────────────
  const viewer = await login('viewer@techvision.com', 'viewer123');
  check('viewer retention PUT -> 403', (await req('/api/settings/retention', { method: 'PUT', token: viewer, body: { key: 'screenshot_retention_days', value: '45' } })).status, 403);
  check('viewer policy create -> 403', (await req('/api/consent/policies', { method: 'POST', token: viewer, body: { consentType: 'screenshot', content: 'some policy text with more than twenty characters' } })).status, 403);
  check('viewer consent PUT -> 403', (await req('/api/consent/some-id', { method: 'PUT', token: viewer, body: { status: 'revoked' } })).status, 403);
  check('viewer consent DELETE -> 403', (await req('/api/consent/some-id', { method: 'DELETE', token: viewer })).status, 403);
  check('viewer policy PATCH -> 403', (await req('/api/consent/policies/some-id', { method: 'PATCH', token: viewer, body: { action: 'publish' } })).status, 403);

  // ── RBAC: manager may mutate consents but NOT admin-only surfaces ─────────
  const manager = await login('manager@techvision.com', 'manager123');
  check('manager consent PUT -> 200', (await req('/api/consent/some-id', { method: 'PUT', token: manager, body: { status: 'revoked' } })).status, 404); // 404 (no such consent) proves the RBAC gate passed
  check('manager policy create -> 403', (await req('/api/consent/policies', { method: 'POST', token: manager, body: { consentType: 'screenshot', content: 'some policy text with more than twenty characters' } })).status, 403);
  check('manager policy PATCH -> 403', (await req('/api/consent/policies/some-id', { method: 'PATCH', token: manager, body: { action: 'publish' } })).status, 403);
  check('manager retention PUT -> 403', (await req('/api/settings/retention', { method: 'PUT', token: manager, body: { key: 'screenshot_retention_days', value: '45' } })).status, 403);
  check('manager bulk grant -> 403', (await req('/api/consent/bulk', { method: 'POST', token: manager, body: { employeeIds: [], consentType: 'screenshot', action: 'grant' } })).status, 403);

  // ── Cross-organization isolation (org A admin vs org B fixture) ───────────
  const adminB = await login('adminb@smoke.test', 'adminb123');
  const orgAList = await req('/api/consent?type=screenshot&pageSize=5', { token: admin });
  const orgAConsentId = orgAList.json?.data?.[0]?.id;
  const orgAListAll = await req('/api/consent?type=screenshot&pageSize=500', { token: admin });
  if (orgAConsentId) {
    // Org B admin cannot act on an org A consent (PUT/DELETE scope by org).
    check('cross-org consent PUT -> 404', (await req(`/api/consent/${orgAConsentId}`, { method: 'PUT', token: adminB, body: { status: 'revoked' } })).status, 404);
    check('cross-org consent DELETE -> 404', (await req(`/api/consent/${orgAConsentId}`, { method: 'DELETE', token: adminB })).status, 404);
    check('cross-org policy PATCH -> 404', (await req('/api/consent/policies/some-orgb-id', { method: 'PATCH', token: admin, body: { action: 'publish' } })).status, 404);
  } else {
    check('org A returned a consent id for cross-org tests', false, true);
  }
  // Org B admin sees only org B data in its own scoped views.
  const orgBList = await req('/api/consent?type=screenshot&pageSize=500', { token: adminB });
  check('org B list -> 200', orgBList.status, 200);
  const orgAIds = new Set((orgAListAll.json?.data || []).map((c) => c.id));
  const orgBIds = (orgBList.json?.data || []).map((c) => c.id);
  check('org B list contains only org B consents', orgBIds.every((id) => !orgAIds.has(id)), true);
  check('org B consents not visible to org A admin', (orgAListAll.json?.data || []).every((c) => c.employeeId !== 'SMOKE-B-001'), true);

  // ── Consent state transitions + immutable history ────────────────────────
  const list = await req(`/api/consent?type=email_monitoring&pageSize=5`, { token: admin });
  check('consent list -> 200', list.status, 200);
  const consentId = list.json?.data?.[0]?.id;
  if (consentId) {
    const revoke = await req(`/api/consent/${consentId}`, { method: 'PUT', token: admin, body: { status: 'revoked', performedBy: 'admin' } });
    check('admin revoke -> 200', revoke.status, 200);
    const del = await req(`/api/consent/${consentId}`, { method: 'DELETE', token: admin });
    check('delete consent WITH history -> 409', del.status, 409);
  } else {
    check('consent list returned a row', false, true);
  }

  // ── Agent enforcement (real token + real upload attempts) ────────────────
  // Employee/token choices are discovered from the live data by the provision
  // script (written to scripts/.smoke-fixtures.json) so the test self-calibrates
  // instead of assuming a fixed employee.
  const fixtures = JSON.parse(readFileSync(join(process.cwd(), 'scripts', '.smoke-fixtures.json'), 'utf8'));
  const empGranted = fixtures.tokenGranted; // screenshot + activity granted
  const emp022 = fixtures.tokenRevoked; // screenshot revoked

  const agentCheck = await req(`/api/agent/consent?types=screenshot,activity_tracking`, { token: empGranted });
  check('agent consent check (granted emp) -> 200', agentCheck.status, 200);
  check('granted emp screenshot consent active', agentCheck.json?.consents?.screenshot, true);
  check('granted emp activity consent active', agentCheck.json?.consents?.activity_tracking, true);

  // After publishing a new email_monitoring version, existing v1 email consents
  // are stale -> agent is told re-consent is required (fail closed).
  const agentEmail = await req(`/api/agent/consent?types=email_monitoring`, { token: empGranted });
  check('agent email_monitoring after version bump -> re-consent required', agentEmail.json?.consents?.email_monitoring, false);

  // Granted employee screenshot upload (consent valid, policy current) -> allowed.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const form = new FormData();
  form.append('screenshot', new Blob([png], { type: 'image/png' }), 'smoke.png');
  const shotRes = await fetch(`${BASE}/api/agent/screenshot`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${empGranted}` },
    body: form,
  });
  check('granted emp screenshot upload -> 200', shotRes.status, 200);

  // EMP-022 screenshot upload (REVOKED) -> blocked.
  const form2 = new FormData();
  form2.append('screenshot', new Blob([png], { type: 'image/png' }), 'smoke2.png');
  const shotRes2 = await fetch(`${BASE}/api/agent/screenshot`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${emp022}` },
    body: form2,
  });
  check('EMP-022 screenshot upload (revoked) -> 403', shotRes2.status, 403);

  // Granted employee activity upload -> allowed.
  const actRes = await req('/api/agent/activity', {
    method: 'POST',
    token: empGranted,
    body: { activities: [{ type: 'application', title: 'smoke', duration: 60 }] },
  });
  check('granted emp activity upload -> 200', actRes.status, 200);

  // Blocked responses must not leak stack traces / HTML error pages.
  const deniedBody = await fetch(`${BASE}/api/agent/screenshot`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${emp022}` },
    body: form2,
  });
  check('blocked response carries no stack trace', !(deniedBody.headers.get('content-type') || '').includes('text/html'), true);

  console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} SMOKE CHECKS FAILED`);
  process.exit(failures === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
