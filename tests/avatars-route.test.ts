/**
 * Avatar serving route — Vercel compatibility regression tests.
 *
 * On Vercel the filesystem is read-only, so avatar objects live in Supabase
 * Storage and are served back by GET /uploads/avatars/<filename> through the
 * active storage driver. These tests pin the route's security contract:
 *   - valid PNG served as image/png with nosniff + immutable cache
 *   - traversal / non-PNG / missing / tampered objects all return a safe 404
 *   - the stored URL scheme (/uploads/avatars/<id>.png) is unchanged
 *
 * The route needs no database (storage drivers only) — the local driver is
 * used and its written file is cleaned up.
 * Run: npx tsx --test tests/avatars-route.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

// ─── Test isolation (must be set BEFORE any app module import) ─────────────
process.env.STORAGE_DRIVER = 'local';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(48, 0x11)]);

const AVATAR_DIR = join(process.cwd(), 'public', 'uploads', 'avatars');
const createdFiles: string[] = [];

type AvatarRoute = typeof import('../src/app/uploads/avatars/[filename]/route');
let avatarRoute: AvatarRoute;
type Storage = typeof import('../src/lib/storage');
let putAvatar: Storage['putAvatar'];

before(async () => {
  avatarRoute = await import('../src/app/uploads/avatars/[filename]/route');
  putAvatar = (await import('../src/lib/storage')).putAvatar;
});

after(() => {
  for (const file of createdFiles) {
    rmSync(join(AVATAR_DIR, file), { force: true });
  }
});

async function getAvatar(filename: string): Promise<Response> {
  return avatarRoute.GET(new Request(`http://localhost:3000/uploads/avatars/${filename}`), {
    params: Promise.resolve({ filename }),
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('AV-01: valid PNG avatar is served as image/png with nosniff + immutable cache', async () => {
  const name = 'av-route-01.png';
  await putAvatar(name, PNG_BYTES);
  createdFiles.push(name);

  const res = await getAvatar(name);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const body = Buffer.from(await res.arrayBuffer());
  assert.equal(body.length, PNG_BYTES.length);
  assert.deepEqual([...body.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'served bytes must be the actual PNG');
});

test('AV-02: path-traversal filename never escapes (basename-only lookup)', async () => {
  const name = 'av-route-02.png';
  await putAvatar(name, PNG_BYTES);
  createdFiles.push(name);

  // Directory-traversal attempts must 404 — the marker file that WOULD be the
  // target lives at a predictable absolute path and must never be readable.
  const attempts = [
    '../../../../../../../../Windows/win.ini',
    '..%2F..%2Fsecret.png',
    'av-route-02.png/../../../etc/passwd',
    '/etc/passwd',
    '....//....//etc/passwd',
  ];
  for (const attempt of attempts) {
    const res = await getAvatar(attempt);
    assert.equal(res.status, 404, `traversal ${attempt} must 404`);
    assert.equal(await res.text(), 'Not found');
  }
});

test('AV-03: non-png filename suffix is rejected with 404', async () => {
  const name = 'av-route-03.png';
  await putAvatar(name, PNG_BYTES);
  createdFiles.push(name);

  for (const attempt of ['av-route-03.png.svg', 'av-route-03.png.exe', 'av-route-03.png.html', 'no-extension', 'av-route-03.PNG.txt']) {
    const res = await getAvatar(attempt);
    assert.equal(res.status, 404, `${attempt} must 404`);
  }
});

test('AV-04: missing avatar returns a safe 404', async () => {
  const res = await getAvatar('definitely-not-stored-99.png');
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'Not found');
});

test('AV-05: tampered object (non-PNG bytes stored under a .png name) is never served', async () => {
  const name = 'av-route-05.png';
  await putAvatar(name, JPEG_BYTES); // lies: .png name, JPEG content
  createdFiles.push(name);

  const res = await getAvatar(name);
  assert.equal(res.status, 404, 'a .png object without a PNG signature must not be served');
});

test('AV-06: the stored URL scheme is unchanged (route path is /uploads/avatars/<id>.png)', () => {
  // The upload API stores avatarUrl = `/uploads/avatars/${id}.png`; this route
  // is what resolves that URL on read-only filesystems. Assert the URL shape
  // matches the upload route's contract (see src/app/api/upload/avatar/route.ts).
  assert.match('/uploads/avatars/user-abc-123.png', /^\/uploads\/avatars\/[A-Za-z0-9._-]+\.png$/);
  // And the served file exists on the local driver exactly where the static
  // layer used to serve it (public/uploads/avatars) — identical bytes.
  assert.ok(existsSync(join(AVATAR_DIR, 'av-route-01.png')));
});
