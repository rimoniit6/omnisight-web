/**
 * Phase 3 — Automated Vision Task Detection + PII Redaction.
 *
 * Drives `processScreenshotRow` end-to-end with an INJECTED vision provider
 * (the same seam the production job uses) so every AI outcome — happy path,
 * PII-found, provider failure, unparseable output, injected throw — is
 * exercised deterministically with ZERO network egress.
 *
 * Covers:
 *   AI-01  Gate fail-close via org toggle (ai_insights_enabled=false) → row
 *          processed, ZERO AI work, nothing flagged as analysisFailed.
 *   AI-02  Gate fail-close via missing config (no provider) → same zero-AI pass.
 *   AI-03  Empty PII array → task classification runs on the ORIGINAL image,
 *          stored object byte-identical, aiAnalysis persisted.
 *   AI-04  PII boxes → main object overwritten with the blurred render, task
 *          classification runs on the BLURRED image, piiRedacted recorded.
 *   AI-05  PII call error → original untouched, analysisFailed=true, no task call.
 *   AI-06  Unparseable PII output → same as AI-05 (short-circuit).
 *   AI-07  Task call error AFTER a successful blur → blurred image still
 *          stored (privacy win never undone), analysisFailed=true.
 *   AI-08  Task output with an invalid category AFTER blur → same as AI-07.
 *   AI-09  Injected provider throw → row still processes, analysisFailed=true,
 *          original untouched.
 *   AI-10  parsePiiBoxes: bare array / {boxes} / {pii} / fenced JSON / skips
 *          malformed entries / rejects non-list payloads.
 *   AI-11  parseTaskAnalysis: case-insensitive, confidence clamp, rejects
 *          unknown categories.
 *   AI-12  Batch run with the REAL provider against an SSRF-blocked endpoint —
 *          rows complete with analysisFailed=true, no egress, no crash.
 *
 * Run: npx tsx --test tests/screenshot-ai-processing.test.ts
 * (requires regenerated Prisma client — the schema gained piiRedacted /
 *  analysisFailed columns).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import sharp from 'sharp';
import type { AIProviderResult, ImageInput } from '../src/lib/ai-provider-helper';

// ─── Test DB isolation (set BEFORE any app module import) ──────────────────
const PG_TEST_BASE = process.env.PG_TEST_BASE_URL || 'postgresql://postgres:123456@localhost:5432';
const TEST_DB_NAME = 'workai_test_shotai';
const TEST_DB_URL = `${PG_TEST_BASE}/${TEST_DB_NAME}?schema=public`;

process.env.DATABASE_URL = TEST_DB_URL;
process.env.DIRECT_URL = TEST_DB_URL;
process.env.JWT_SECRET = 'shotai-test-jwt-secret-0123456789abcdef';
process.env.STORAGE_DRIVER = 'local';
(process.env as Record<string, string>).NODE_ENV = 'test';

const SHOT_DIR = join(process.cwd(), 'uploads', 'screenshots');

const CODING_ANALYSIS = '{"category":"Coding","confidence":0.9}';

type DbModule = typeof import('../src/lib/db');
type ProcessingModule = typeof import('../src/lib/screenshots/processing');
type StorageModule = typeof import('../src/lib/storage');

let db: DbModule['db'];
let processing: ProcessingModule;
let storage: StorageModule;

/** Shape mirrors ScreenshotAiVisionCall — structurally compatible. */
type VisionCall = ProcessingModule['ScreenshotAiVisionCall'];

let orgOn: { id: string }; // ai_insights_enabled unset + ollama config → gate ON
let orgToggleOff: { id: string }; // ai_insights_enabled=false + config → gate OFF
let orgNoConfig: { id: string }; // no settings → gate OFF
let orgBlocked: { id: string }; // custom provider → http://127.0.0.1:1 (SSRF-blocked)
let empOn: { id: string };
let empToggleOff: { id: string };
let empNoConfig: { id: string };
let empBlocked: { id: string };

// ─── Fixtures ───────────────────────────────────────────────────────────────

/**
 * 200x200 white PNG with a 20x20 dark square at (90,90) — an ISOLATED dark
 * island on white. The detection stub reports a box LARGER than the square
 * ([40,40,120,120]) so the blur crop contains bright surround; after a heavy
 * gaussian blur the anchor's dark core visibly lightens (a uniformly dark box
 * would stay uniform and prove nothing). Sample point: exact center (100,100).
 */
async function piiFixture(): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="200" height="200" fill="#ffffff"/>` +
      `<rect x="90" y="90" width="20" height="20" fill="#111111"/>` +
      `</svg>`
  );
  return sharp(svg).png().toBuffer();
}

const PII_BOX = '[{"x":40,"y":40,"w":120,"h":120}]';

/** Decode-and-compare two image buffers (PNG re-encode is not byte-stable — pixels are). */
async function assertSamePixels(a: Buffer, b: Buffer) {
  const ra = await sharp(a).raw().toBuffer({ resolveWithObject: true });
  const rb = await sharp(b).raw().toBuffer({ resolveWithObject: true });
  assert.equal(ra.info.width, rb.info.width, 'width mismatch');
  assert.equal(ra.info.height, rb.info.height, 'height mismatch');
  assert.ok(ra.data.equals(rb.data), 'pixel data must match');
}

async function solidFixture(color = '#3c78d8'): Promise<Buffer> {
  const svg = Buffer.from(
    `<svg width="160" height="120" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="160" height="120" fill="${color}"/>` +
      `</svg>`
  );
  return sharp(svg).png().toBuffer();
}

async function rgbAt(buffer: Buffer, x: number, y: number): Promise<{ r: number; g: number; b: number }> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const idx = (y * info.width + x) * info.channels;
  return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
}

/**
 * Programmable vision stub. Records every call (PII vs task + the image it
 * received) and returns what each handler yields. An absent handler resolves
 * to a provider-style ERROR result — exactly what a real failed provider call
 * returns — so unhandled-but-invoked calls surface as analysisFailed, never
 * as text. `throwOn` makes the provider throw (crash-style, not error-style).
 */
function visionStub(opts: {
  pii?: (image: ImageInput) => string | AIProviderResult | null;
  task?: (image: ImageInput) => string | AIProviderResult | null;
  throwOn?: 'pii' | 'task';
}): { fn: VisionCall; calls: Array<{ kind: 'pii' | 'task'; image: ImageInput }> } {
  const calls: Array<{ kind: 'pii' | 'task'; image: ImageInput }> = [];
  const fn: VisionCall = async (system, _user, image) => {
    const kind = system.includes('PII') ? 'pii' : 'task';
    calls.push({ kind, image });
    if (opts.throwOn === kind) throw new Error('stub provider crashed');
    const handler = kind === 'pii' ? opts.pii : opts.task;
    if (!handler) return { text: null, provider: 'stub', model: 'stub', error: 'STUB_UNHANDLED' };
    const result = handler(image);
    return typeof result === 'string' ? { text: result, provider: 'stub', model: 'stub' } : result;
  };
  return { fn, calls };
}

// ─── Test helpers ───────────────────────────────────────────────────────────

async function seedRow(
  orgId: string,
  empId: string,
  name: string,
  bytes: Buffer,
  mime = 'image/png'
): Promise<{ id: string; filePath: string; name: string }> {
  await storage.putScreenshot(orgId, name, bytes, mime);
  const row = await db.screenshot.create({
    data: {
      organizationId: orgId,
      employeeId: empId,
      fileName: name,
      filePath: `/uploads/screenshots/${name}`,
      fileSize: bytes.length,
      mimeType: mime,
      processingStatus: 'uploaded',
      processingAttempts: 0,
      width: null,
      height: null,
    },
  });
  return { id: row.id, filePath: row.filePath, name };
}

/** Seed a row and run processScreenshotRow with the given stub end-to-end. */
async function runRow(
  orgId: string,
  empId: string,
  name: string,
  bytes: Buffer,
  stub: ReturnType<typeof visionStub>,
  mime = 'image/png'
) {
  const row = await seedRow(orgId, empId, name, bytes, mime);
  const outcome = await processing.processScreenshotRow(
    {
      id: row.id,
      organizationId: orgId,
      employeeId: empId,
      filePath: row.filePath,
      mimeType: mime,
      processingAttempts: 0,
      width: null,
    },
    db,
    { aiVision: stub.fn }
  );
  const stored = await storage.getScreenshot(orgId, row.filePath);
  return { row, outcome, stored, calls: stub.calls };
}

async function seedOrgSettings(orgId: string, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    await db.organizationSetting.create({ data: { organizationId: orgId, key, value, category: 'ai' } });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Setup
// ═══════════════════════════════════════════════════════════════════════════
before(() => {
  execSync(`node scripts/pg-test-db.mjs ensure ${TEST_DB_NAME}`, {
    env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
    stdio: 'pipe',
  });
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  });
  rmSync(SHOT_DIR, { recursive: true, force: true });
});

before(async () => {
  db = (await import('../src/lib/db')).db;
  processing = await import('../src/lib/screenshots/processing');
  storage = await import('../src/lib/storage');

  orgOn = await db.organization.create({ data: { name: 'Shot AI On', slug: 'shot-ai-on', status: 'active' } });
  orgToggleOff = await db.organization.create({ data: { name: 'Shot AI Toggle Off', slug: 'shot-ai-toggle-off', status: 'active' } });
  orgNoConfig = await db.organization.create({ data: { name: 'Shot AI No Config', slug: 'shot-ai-no-config', status: 'active' } });
  orgBlocked = await db.organization.create({ data: { name: 'Shot AI Blocked', slug: 'shot-ai-blocked', status: 'active' } });

  empOn = await db.employee.create({ data: { employeeId: 'SHOT-AI-EMP-ON', firstName: 'AI', lastName: 'On', email: 'ai-on@p3.test', organizationId: orgOn.id } });
  empToggleOff = await db.employee.create({ data: { employeeId: 'SHOT-AI-EMP-TOGGLE', firstName: 'AI', lastName: 'Toggle', email: 'ai-toggle@p3.test', organizationId: orgToggleOff.id } });
  empNoConfig = await db.employee.create({ data: { employeeId: 'SHOT-AI-EMP-NOCFG', firstName: 'AI', lastName: 'NoCfg', email: 'ai-nocfg@p3.test', organizationId: orgNoConfig.id } });
  empBlocked = await db.employee.create({ data: { employeeId: 'SHOT-AI-EMP-BLOCKED', firstName: 'AI', lastName: 'Blocked', email: 'ai-blocked@p3.test', organizationId: orgBlocked.id } });

  // Gate passes (ollama needs no API key) for orgOn / orgToggleOff.
  await seedOrgSettings(orgOn.id, { ai_provider: 'ollama', ai_model: 'llama3' });
  await seedOrgSettings(orgToggleOff.id, { ai_insights_enabled: 'false', ai_provider: 'ollama', ai_model: 'llama3' });
  // orgBlocked resolves (custom needs no key) but every call is SSRF-blocked.
  await seedOrgSettings(orgBlocked.id, {
    ai_provider: 'custom',
    ai_base_url: 'http://127.0.0.1:1',
    ai_model: 'x',
  });
  // orgNoConfig intentionally has NO settings.
});

after(async () => {
  await db.$disconnect();
  try {
    execSync(`node scripts/pg-test-db.mjs drop ${TEST_DB_NAME}`, {
      env: { ...process.env, PG_TEST_BASE_URL: PG_TEST_BASE },
      stdio: 'pipe',
    });
  } catch {
    /* best-effort cleanup */
  }
});

const ALL_DISABLED = {
  piiRedacted: false,
  aiAnalysis: null,
  analysisFailed: false,
  processingStatus: 'processed',
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// AI-01 / AI-02 — fail-closed gate: zero AI work when disabled
// ═══════════════════════════════════════════════════════════════════════════
test('AI-01: ai_insights_enabled=false → row processes with ZERO AI work (no vision calls)', async () => {
  const bytes = await piiFixture();
  const stub = visionStub({
    pii: () => PII_BOX,
    task: () => CODING_ANALYSIS,
  });
  const { outcome, row, stored, calls } = await runRow(orgToggleOff.id, empToggleOff.id, 'ai-01.png', bytes, stub);

  assert.equal(outcome, 'processed');
  assert.equal(calls.length, 0, 'the AI gate must prevent BOTH vision calls');
  const meta = await db.screenshot.findUnique({ where: { id: row.id } });
  assert.deepEqual(
    { piiRedacted: meta?.piiRedacted, aiAnalysis: meta?.aiAnalysis, analysisFailed: meta?.analysisFailed, processingStatus: meta?.processingStatus },
    ALL_DISABLED,
    'by-design skip is NOT a failure: nothing flagged, nothing annotated'
  );
  assert.ok(stored.equals(bytes), 'original object must be byte-identical');
  assert.ok(meta?.thumbnailPath, 'thumbnail still generated');
});

test('AI-02: no AI config resolved → row processes with ZERO AI work', async () => {
  const bytes = await piiFixture();
  const stub = visionStub({
    pii: () => PII_BOX,
    task: () => CODING_ANALYSIS,
  });
  const { outcome, row, stored, calls } = await runRow(orgNoConfig.id, empNoConfig.id, 'ai-02.png', bytes, stub);

  assert.equal(outcome, 'processed');
  assert.equal(calls.length, 0);
  const meta = await db.screenshot.findUnique({ where: { id: row.id } });
  assert.deepEqual(
    { piiRedacted: meta?.piiRedacted, aiAnalysis: meta?.aiAnalysis, analysisFailed: meta?.analysisFailed, processingStatus: meta?.processingStatus },
    ALL_DISABLED
  );
  assert.ok(stored.equals(bytes));
});

// ═══════════════════════════════════════════════════════════════════════════
// AI-03 — no PII found
// ═══════════════════════════════════════════════════════════════════════════
test('AI-03: empty PII → task runs on the ORIGINAL image, stored object untouched, analysis persisted', async () => {
  const bytes = await piiFixture();
  const stub = visionStub({ pii: () => '[]', task: () => CODING_ANALYSIS });
  const { outcome, row, stored, calls } = await runRow(orgOn.id, empOn.id, 'ai-03.png', bytes, stub);

  assert.equal(outcome, 'processed');
  assert.equal(calls.length, 2, 'both vision steps must run when PII is empty');
  assert.equal(calls[0].kind, 'pii');
  assert.equal(calls[1].kind, 'task');
  assert.equal(calls[1].image.type, 'base64');
  const taskImage = Buffer.from(calls[1].image.base64 as string, 'base64');
  await assertSamePixels(taskImage, bytes); // with no PII the classifier must receive the ORIGINAL pixels

  const meta = await db.screenshot.findUnique({ where: { id: row.id } });
  assert.equal(meta?.piiRedacted, false);
  assert.equal(meta?.aiAnalysis, CODING_ANALYSIS);
  assert.equal(meta?.analysisFailed, false);
  assert.equal(meta?.processingStatus, 'processed');
  assert.ok(meta?.thumbnailPath);

  assert.ok(stored.equals(bytes), 'no PII → main object must never be rewritten');
  const thumbMeta = await sharp(join(SHOT_DIR, meta!.thumbnailPath!.split('/').pop()!)).metadata();
  assert.ok((thumbMeta.width ?? 0) <= 320, 'thumbnail policy honored');
});

// ═══════════════════════════════════════════════════════════════════════════
// AI-04 — PII found: blur + overwrite + classify blurred render
// ═══════════════════════════════════════════════════════════════════════════
test('AI-04: PII boxes → main object overwritten with blurred render; task runs on BLURRED image', async () => {
  const bytes = await piiFixture();
  const stub = visionStub({
    pii: () => PII_BOX,
    task: () => CODING_ANALYSIS,
  });
  const { outcome, row, stored, calls } = await runRow(orgOn.id, empOn.id, 'ai-04.png', bytes, stub);

  assert.equal(outcome, 'processed');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].image.base64, bytes.toString('base64'), 'task must NOT see the original pixels');

  const meta = await db.screenshot.findUnique({ where: { id: row.id } });
  assert.equal(meta?.piiRedacted, true);
  assert.equal(meta?.aiAnalysis, CODING_ANALYSIS);
  assert.equal(meta?.analysisFailed, false);

  assert.ok(!stored.equals(bytes), 'main object must be replaced when PII was found');
  assert.equal(stored.toString('base64'), calls[1].image.base64 as string, 'the STORED bytes are the exact pixels the classifier saw');
  // The PII region is now heavily blurred: the dark square's core turned light.
  const beforePx = await rgbAt(bytes, 100, 100);
  const afterPx = await rgbAt(stored, 100, 100);
  assert.ok(beforePx.r < 60 && beforePx.g < 60 && beforePx.b < 60, `precondition: dark square at center (${JSON.stringify(beforePx)})`);
  assert.ok(afterPx.r > 120 && afterPx.g > 120 && afterPx.b > 120, `blur must obliterate the dark square (${JSON.stringify(afterPx)})`);

  // Thumbnail is derived from the redacted render and still decodes as PNG.
  const thumbName = meta!.thumbnailPath!.split('/').pop()!;
  const thumbBytes = await sharp(join(SHOT_DIR, thumbName)).toBuffer();
  const thumbMeta = await sharp(thumbBytes).metadata();
  assert.equal(thumbMeta.format, 'png');
  assert.notEqual(thumbBytes.toString('base64'), '');
  const thumbPx = await rgbAt(thumbBytes, 100, 100);
  assert.ok(thumbPx.r > 120, 'thumbnail itself must not contain the unblurred dark square');
});

// ═══════════════════════════════════════════════════════════════════════════
// AI-05 / AI-06 — PII step fails → original preserved, no task call
// ═══════════════════════════════════════════════════════════════════════════
test('AI-05: PII call error → original untouched, analysisFailed=true, task never runs', async () => {
  const bytes = await piiFixture();
  const stub = visionStub({
    pii: () => ({ text: null, provider: 'stub', model: 'stub', error: 'AI_HTTP_500' }),
    task: () => CODING_ANALYSIS,
  });
  const { outcome, row, stored, calls } = await runRow(orgOn.id, empOn.id, 'ai-05.png', bytes, stub);

  assert.equal(outcome, 'processed');
  assert.equal(calls.length, 1, 'no task call after a PII failure (short-circuit)');
  const meta = await db.screenshot.findUnique({ where: { id: row.id } });
  assert.equal(meta?.piiRedacted, false);
  assert.equal(meta?.aiAnalysis, null);
  assert.equal(meta?.analysisFailed, true);
  assert.equal(meta?.processingStatus, 'processed', 'an AI miss is never a row failure');
  assert.ok(stored.equals(bytes), 'original must be preserved');
});

test('AI-06: unparseable PII output → original untouched, analysisFailed=true, no task call', async () => {
  const bytes = await piiFixture();
  const stub = visionStub({ pii: () => 'I can see a credit card near the top right corner', task: () => CODING_ANALYSIS });
  const { outcome, row, stored, calls } = await runRow(orgOn.id, empOn.id, 'ai-06.png', bytes, stub);

  assert.equal(outcome, 'processed');
  assert.equal(calls.length, 1);
  const meta = await db.screenshot.findUnique({ where: { id: row.id } });
  assert.equal(meta?.piiRedacted, false);
  assert.equal(meta?.analysisFailed, true);
  assert.equal(meta?.aiAnalysis, null);
  assert.ok(stored.equals(bytes));
});

// ═══════════════════════════════════════════════════════════════════════════
// AI-07 / AI-08 — task step fails AFTER a successful blur → blur retained
// ═══════════════════════════════════════════════════════════════════════════
test('AI-07: task call error after a successful blur → blurred image STILL stored (privacy win never undone)', async () => {
  const bytes = await piiFixture();
  const stub = visionStub({
    pii: () => PII_BOX,
    task: () => ({ text: null, provider: 'stub', model: 'stub', error: 'AI_HTTP_429' }),
  });
  const { outcome, row, stored, calls } = await runRow(orgOn.id, empOn.id, 'ai-07.png', bytes, stub);

  assert.equal(outcome, 'processed');
  assert.equal(calls.length, 2);
  const meta = await db.screenshot.findUnique({ where: { id: row.id } });
  assert.equal(meta?.piiRedacted, true, 'the redaction happened and must never be rolled back');
  assert.equal(meta?.analysisFailed, true,
    'track classification failure explicitly so admins can spot undetected-task rows');
  assert.equal(meta?.aiAnalysis, null);
  assert.ok(!stored.equals(bytes), 'the blurred render must be the stored main object');
  const afterPx = await rgbAt(stored, 100, 100);
  assert.ok(afterPx.r > 120, 'stored region must actually be blurred');
});

test('AI-08: task output with invalid category after blur → blurred stored, analysisFailed=true', async () => {
  const bytes = await piiFixture();
  const stub = visionStub({
    pii: () => PII_BOX,
    task: () => '{"category":"Gaming","confidence":0.9}',
  });
  const { outcome, row, stored, calls } = await runRow(orgOn.id, empOn.id, 'ai-08.png', bytes, stub);

  assert.equal(outcome, 'processed');
  assert.equal(calls.length, 2);
  const meta = await db.screenshot.findUnique({ where: { id: row.id } });
  assert.equal(meta?.piiRedacted, true);
  assert.equal(meta?.analysisFailed, true, 'invalid category = unparseable classification');
  assert.equal(meta?.aiAnalysis, null);
  assert.ok(!stored.equals(bytes));
});

// ═══════════════════════════════════════════════════════════════════════════
// AI-09 — injected provider crash
// ═══════════════════════════════════════════════════════════════════════════
test('AI-09: provider throws → row still processes, analysisFailed=true, original untouched', async () => {
  const bytes = await piiFixture();
  const stub = visionStub({ throwOn: 'pii', task: () => CODING_ANALYSIS });
  const { outcome, row, stored, calls } = await runRow(orgOn.id, empOn.id, 'ai-09.png', bytes, stub);

  assert.equal(outcome, 'processed', 'an unexpected provider crash must not lose the screenshot');
  assert.equal(calls.length, 1);
  const meta = await db.screenshot.findUnique({ where: { id: row.id } });
  assert.equal(meta?.piiRedacted, false);
  assert.equal(meta?.analysisFailed, true);
  assert.equal(meta?.aiAnalysis, null);
  assert.equal(meta?.processingStatus, 'processed');
  assert.ok(stored.equals(bytes));
});

// ═══════════════════════════════════════════════════════════════════════════
// AI-10 / AI-11 — pure parser units
// ═══════════════════════════════════════════════════════════════════════════
test('AI-10: parsePiiBoxes accepts array / {boxes} / {pii} / fenced JSON, skips malformed entries', () => {
  const { parsePiiBoxes } = processing;
  assert.deepEqual(parsePiiBoxes('[{"x":1,"y":2,"w":10,"h":5}]'), [{ x: 1, y: 2, w: 10, h: 5 }]);
  assert.deepEqual(parsePiiBoxes('```json\n[{"x":1,"y":2,"w":10,"h":5}]\n```'), [{ x: 1, y: 2, w: 10, h: 5 }]);
  assert.deepEqual(parsePiiBoxes('{"boxes":[{"x":1,"y":2,"w":10,"h":5}]}'), [{ x: 1, y: 2, w: 10, h: 5 }]);
  assert.deepEqual(parsePiiBoxes('{"pii":[{"x":1,"y":2,"w":10,"h":5}]}'), [{ x: 1, y: 2, w: 10, h: 5 }]);
  // Malformed entry skipped, healthy ones kept; list-shaped → no-PII, not failure.
  assert.deepEqual(parsePiiBoxes('[{"x":1,"y":2,"w":10,"h":5},{"nope":true},{"w":0,"h":0,"x":1,"y":1}]'), [
    { x: 1, y: 2, w: 10, h: 5 },
  ]);
  assert.deepEqual(parsePiiBoxes('[{"bogus":1}]'), []);
  assert.deepEqual(parsePiiBoxes('[]'), []);
  // Unparseable / wrong shape → null (treatment: analysisFailed).
  assert.equal(parsePiiBoxes('no boxes here'), null);
  assert.equal(parsePiiBoxes('{"text":"PII detected"}'), null);
  assert.equal(parsePiiBoxes('42'), null);
});

test('AI-11: parseTaskAnalysis is case-insensitive, clamps confidence, rejects unknown categories', () => {
  const { parseTaskAnalysis } = processing;
  assert.deepEqual(parseTaskAnalysis('{"category":"Coding","confidence":0.9}'), { category: 'Coding', confidence: 0.9 });
  assert.deepEqual(parseTaskAnalysis('{"category":"coding","confidence":0.9}'), { category: 'Coding', confidence: 0.9 });
  assert.deepEqual(parseTaskAnalysis('{"category":"SOCIAL MEDIA","confidence":1.7}'), {
    category: 'Social Media',
    confidence: 1,
  });
  assert.deepEqual(parseTaskAnalysis('{"category":"Meeting","confidence":-2}'), { category: 'Meeting', confidence: 0 });
  assert.deepEqual(parseTaskAnalysis('{"category":"Emailing"}'), { category: 'Emailing', confidence: null });
  assert.deepEqual(parseTaskAnalysis('```json\n{"category":"Documentation","confidence":0.5}\n```'), {
    category: 'Documentation',
    confidence: 0.5,
  });
  assert.equal(parseTaskAnalysis('{"category":"Gaming","confidence":0.9}'), null);
  assert.equal(parseTaskAnalysis('{"category":"Coding"'), null);
  assert.equal(parseTaskAnalysis('Coding'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// AI-12 — batch run, real provider, SSRF-blocked endpoint: no egress, no crash
// ═══════════════════════════════════════════════════════════════════════════
test('AI-12: batch run with the REAL provider against an SSRF-blocked endpoint completes rows without egress', async () => {
  // No leftover uploaded rows from earlier tests (they all terminated 'processed').
  assert.equal(await db.screenshot.count({ where: { processingStatus: 'uploaded' } }), 0);

  const bytes = await piiFixture();
  const a = await seedRow(orgBlocked.id, empBlocked.id, 'ai-12a.png', bytes);
  const b = await seedRow(orgBlocked.id, empBlocked.id, 'ai-12b.png', await solidFixture());

  const result = await processing.processPendingScreenshots(10);
  assert.equal(result.processed, 2);
  assert.equal(result.failed, 0, 'blocked AI must never fail a row');

  for (const id of [a.id, b.id]) {
    const meta = await db.screenshot.findUnique({ where: { id } });
    assert.equal(meta?.processingStatus, 'processed');
    assert.equal(meta?.analysisFailed, true, `AI was attempted (real provider) and blocked — ${id}`);
    assert.equal(meta?.aiAnalysis, null);
    assert.equal(meta?.piiRedacted, false, 'nothing could be detected; nothing was blurred');
    assert.ok(meta?.thumbnailPath, 'thumbnail still produced');
  }
  // Originals preserved byte-for-byte (no blur, no rewrite).
  assert.ok((await storage.getScreenshot(orgBlocked.id, a.filePath)).equals(bytes));
});