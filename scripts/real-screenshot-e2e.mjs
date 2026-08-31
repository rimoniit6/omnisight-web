/**
 * REAL SCREENSHOT E2E TEST — 2026-08-29
 * 
 * Performs the complete real pipeline with an existing authenticated agent:
 *   1. Real GDI+ desktop capture via native addon
 *   2. Upload via POST /api/agent/screenshot (real agent token)
 *   3. PostgreSQL row verification
 *   4. Physical storage verification
 *   5. Image endpoint verification
 *   6. Admin Panel API verification
 * 
 * RUN: cd omnisight-web && node scripts/real-screenshot-e2e.mjs
 */

import { createRequire } from 'module';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import crypto, { randomUUID } from 'crypto';

const require_ = createRequire(import.meta.url);
const BASE_URL = process.env.OMNISIGHT_SERVER_URL || 'http://localhost:3000';
const AGENT_PATH = join(import.meta.dirname, '../../omnisight-agent');

const results = [];
function record(stage, pass, detail) {
  results.push({ stage, pass, detail });
  const mark = pass ? '✅' : '❌';
  console.log(`${mark} ${stage}: ${detail}`);
}

// ── Load existing agent token from DB ──────────────────────────────────
console.log('Loading agent token from database...');
const { PrismaClient } = await import('@prisma/client');
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });

const tokenRow = await db.agentToken.findFirst({
  where: { expiresAt: { gt: new Date() } },
  orderBy: { expiresAt: 'desc' },
  include: {
    employee: { select: { id: true, employeeId: true, firstName: true, lastName: true, organizationId: true } },
  },
});

if (!tokenRow) {
  console.error('FATAL: No active agent token found in database');
  process.exit(1);
}
const agentToken = tokenRow.token;
const employee = tokenRow.employee;
const orgId = employee.organizationId;
console.log(`Token for: ${employee.firstName} ${employee.lastName} (${employee.employeeId})`);

// ── Step 1: Real GDI+ capture ──────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log('  STEP 1: REAL GDI+ DESKTOP CAPTURE');
console.log('══════════════════════════════════════════════════════');
let native;
try {
  const candidates = [
    join(AGENT_PATH, 'native/build/Release/worklens_capture.node'),
    join(AGENT_PATH, 'native/build/Debug/worklens_capture.node'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) { native = require_(p); break; }
  }
  if (!native) throw new Error('Native addon not found');
} catch (err) {
  record('GDI+ addon load', false, err.message);
  process.exit(1);
}

record('GDI+ addon load', true, 'worklens_capture.node loaded');
record('NativeBridge.available', typeof native.foregroundWindow === 'function', 'true');

const foreground = native.foregroundWindow();
record('Foreground window', !!foreground, foreground ? `${foreground.windowTitle} (${foreground.processName})` : 'null');

const captureStart = Date.now();
const rawBytes = native.captureWindow({});
const captureMs = Date.now() - captureStart;
const bytes = Buffer.from(rawBytes);

const isPNG = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
record('Real capture', bytes.length > 1000 && isPNG, `${bytes.length} bytes (${(bytes.length / 1024).toFixed(1)} KB) in ${captureMs}ms`);

let width = 0, height = 0;
if (isPNG && bytes.length >= 24) {
  const chunkType = bytes.toString('ascii', 12, 16);
  if (chunkType === 'IHDR') {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  }
}
record('Image dimensions', width > 100 && height > 100, `${width}×${height}`);
record('Image is real (not synthetic)', bytes.length > 10000, `${bytes.length} bytes >> 33-byte fixture`);

// ── Step 2: Token validity + consent ────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log('  STEP 2: AGENT TOKEN + CONSENT');
console.log('══════════════════════════════════════════════════════');
record('Agent token present', !!agentToken, `${employee.employeeId}`);
record('Token not expired', new Date(tokenRow.expiresAt) > new Date(), tokenRow.expiresAt.toISOString());

const consentRes = await fetch(`${BASE_URL}/api/agent/consent?types=screenshot`, {
  headers: { 'Authorization': `Bearer ${agentToken}` },
});
const consentData = await consentRes.json();
record('Auth succeeds', consentRes.status === 200, `HTTP ${consentRes.status}`);
record('Screenshot consent', consentData.consents?.screenshot === true, `granted=${consentData.consents?.screenshot}`);

// ── Step 3: Config ─────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log('  STEP 3: SCREENSHOT CONFIG');
console.log('══════════════════════════════════════════════════════');
const configRes = await fetch(`${BASE_URL}/api/agent/config`, {
  headers: { 'Authorization': `Bearer ${agentToken}` },
});
const configData = await configRes.json();
record('Config fetch', configRes.status === 200, `HTTP ${configRes.status}`);
record('Screenshot enabled', configData.config?.monitoring?.screenshotEnabled === true,
  `enabled=${configData.config?.monitoring?.screenshotEnabled}`);
record('Screenshot frequency', typeof configData.config?.monitoring?.screenshotFrequency === 'number',
  `${configData.config?.monitoring?.screenshotFrequency} min`);

// ── Step 4: Real upload ────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log('  STEP 4: REAL SCREENSHOT UPLOAD');
console.log('══════════════════════════════════════════════════════');

// Count screenshots before upload
const beforeCount = await db.screenshot.count({ where: { organizationId: orgId } });
record('Screenshots before upload', true, `count=${beforeCount}`);

const form = new FormData();
form.append('screenshot', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'capture.png');
form.append('timestamp', new Date().toISOString());
form.append('appWindow', foreground?.windowTitle || 'desktop');

const uploadStart = Date.now();
const uploadRes = await fetch(`${BASE_URL}/api/agent/screenshot`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${agentToken}` },
  body: form,
});
const uploadData = await uploadRes.json();
const uploadMs = Date.now() - uploadStart;
record('Upload HTTP', uploadRes.status === 200, `HTTP ${uploadRes.status} in ${uploadMs}ms`);
record('Upload success', uploadData.success === true, `filename=${uploadData.filename}`);
record('Response has path', !!uploadData.path, uploadData.path);

const screenshotFilename = uploadData.filename;

// Count after upload
const afterCount = await db.screenshot.count({ where: { organizationId: orgId } });
record('Screenshot count increased', afterCount === beforeCount + 1, `${beforeCount} → ${afterCount}`);

// ── Step 5: Physical storage ───────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log('  STEP 5: PHYSICAL STORAGE');
console.log('══════════════════════════════════════════════════════');
const storedFile = join(process.cwd(), 'uploads', 'screenshots', screenshotFilename);
const fileExists = existsSync(storedFile);
const storedBytes = fileExists ? readFileSync(storedFile) : null;
record('Physical file exists', fileExists, storedFile);
record('File size matches original capture', storedBytes?.length === bytes.length,
  `stored=${storedBytes?.length}, captured=${bytes.length}`);
if (storedBytes) {
  const storedIsPNG = storedBytes[0] === 0x89 && storedBytes[1] === 0x50 && storedBytes[2] === 0x4e && storedBytes[3] === 0x47;
  record('Stored file is valid PNG', storedIsPNG, `magic bytes: ${Array.from(storedBytes.slice(0,4)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
}

// ── Step 6: PostgreSQL row ─────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log('  STEP 6: POSTGRESQL ROW');
console.log('══════════════════════════════════════════════════════');

const screenshotRow = await db.screenshot.findFirst({
  where: { organizationId: orgId },
  orderBy: { capturedAt: 'desc' },
  include: {
    employee: { select: { firstName: true, lastName: true, employeeId: true } },
    device: { select: { name: true } },
  },
});

if (screenshotRow) {
  record('DB row exists', true, `id=${screenshotRow.id}`);
  record('DB employee', screenshotRow.employee.employeeId === employee.employeeId,
    `${screenshotRow.employee.firstName} ${screenshotRow.employee.lastName} (${screenshotRow.employee.employeeId})`);
  record('DB device', !!screenshotRow.device?.name, screenshotRow.device?.name);
  record('DB fileSize', screenshotRow.fileSize === bytes.length, `${screenshotRow.fileSize} bytes`);
  record('DB mimeType', screenshotRow.mimeType === 'image/png', screenshotRow.mimeType);
  record('DB width', screenshotRow.width === width, `${screenshotRow.width}`);
  record('DB height', screenshotRow.height === height, `${screenshotRow.height}`);
  record('DB appWindow', !!screenshotRow.appWindow, screenshotRow.appWindow);
  record('DB filePath', screenshotRow.filePath === `/uploads/screenshots/${screenshotFilename}`, screenshotRow.filePath);
  record('DB organizationId', screenshotRow.organizationId === orgId, screenshotRow.organizationId);
  record('DB capturedAt recent', (Date.now() - new Date(screenshotRow.capturedAt).getTime()) < 60000, screenshotRow.capturedAt.toISOString());
} else {
  record('DB row exists', false, 'No screenshot row found');
  process.exit(1);
}

// ── Step 7: Image endpoint ─────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log('  STEP 7: IMAGE ENDPOINT');
console.log('══════════════════════════════════════════════════════');

// Generate a valid admin JWT with orgId using the project's signJWT
const { execSync } = await import('child_process');
const jwtToken = execSync(`npx tsx scripts/gen-admin-jwt.ts ${orgId}`, { cwd: process.cwd(), encoding: 'utf8' }).trim();
const adminAuth = { 'Authorization': `Bearer ${jwtToken}` };  const imgRes = await fetch(`${BASE_URL}/api/screenshots/${screenshotRow.id}/image`, {
    headers: adminAuth,
  });
const imgBytes = Buffer.from(await imgRes.arrayBuffer());
record('Image endpoint HTTP', imgRes.status === 200, `HTTP ${imgRes.status}`);
record('Image content-type', imgRes.headers.get('content-type')?.includes('image'), imgRes.headers.get('content-type'));
record('Image served correct size', imgBytes.length === bytes.length, `served=${imgBytes.length}, original=${bytes.length}`);
record('Image is real capture', imgBytes[0] === 0x89 && imgBytes[1] === 0x50 && imgBytes.length > 10000, `${imgBytes.length} bytes, PNG magic`);

// ── Step 8: Admin Screenshots API ──────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log('  STEP 8: ADMIN SCREENSHOTS API');
console.log('══════════════════════════════════════════════════════');
const listRes = await fetch(`${BASE_URL}/api/screenshots?page=1&pageSize=5`, {
  headers: adminAuth,
});
const listData = await listRes.json();
record('List API HTTP', listRes.status === 200, `HTTP ${listRes.status}`);
record('List has rows', listData.total > 0, `total=${listData.total}`);

const latestInList = listData.data?.find(s => s.id === screenshotRow.id);
record('Our screenshot in list', !!latestInList, latestInList ? `found: ${latestInList.id}` : 'NOT FOUND');
if (latestInList) {
  record('List employee', !!latestInList.employee?.firstName, `${latestInList.employee?.firstName} ${latestInList.employee?.lastName}`);
  record('List device', !!latestInList.device, latestInList.device?.name || 'present');
  record('List filePath', !!latestInList.filePath, latestInList.filePath);
  record('List appWindow', !!latestInList.appWindow, latestInList.appWindow);
}

// ── Cleanup ─────────────────────────────────────────────────────────────
await db.$disconnect();

// ── Final Summary ──────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log('  FINAL EVIDENCE TABLE');
console.log('══════════════════════════════════════════════════════');
const passed = results.filter(r => r.pass).length;
const failed = results.filter(r => !r.pass).length;

for (const r of results) {
  console.log(`  ${r.pass ? '✅' : '❌'} ${r.stage}: ${r.detail}`);
}

console.log(`\n${passed}/${results.length} passed, ${failed} failed`);

if (failed === 0) {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║        REAL SCREENSHOT E2E: PASS                    ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`
Real Evidence:
  Desktop:   ${foreground?.windowTitle || 'unknown'}
  Capture:   ${bytes.length} bytes (${width}×${height}) in ${captureMs}ms
  Upload:    HTTP ${uploadRes.status} in ${uploadMs}ms
  Filename:  ${screenshotFilename}
  DB Row:    ${screenshotRow?.id}
  Employee:  ${employee.firstName} ${employee.lastName} (${employee.employeeId})
  Device:    ${tokenRow.deviceId || 'n/a'}
  Org:       ${orgId}
  Token:     expires ${tokenRow.expiresAt.toISOString()}
`);
} else {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║        REAL SCREENSHOT E2E: FAIL                    ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('\nFailed stages:');
  results.filter(r => !r.pass).forEach(r => console.log(`  ❌ ${r.stage}: ${r.detail}`));
}
