/**
 * Supabase Storage DRIVER — focused regression tests (forensic fix follow-up).
 *
 *   SSD-01  New-style sb_secret_ credential is presented through BOTH
 *           `apikey` and `Authorization: Bearer` (the connection-test
 *           presentation). The credential value is never logged.
 *   SSD-02  authHeaders(extra) preserves caller-provided headers
 *           (Content-Type, x-upsert) alongside apikey/Authorization.
 *   SSD-03  An authentication rejection (403 "Invalid Compact JWS") is
 *           surfaced as an UNAVAILABLE error — never classified as not_found.
 *   SSD-04  The Storage API's genuine not-found responses (404; and the legacy
 *           400 "The resource was not found" body) remain classified as
 *           not_found — not-found detection is NOT weakened.
 *   SSD-05  An unexpected 400 with a NON-not-found body is an error, not
 *           not_found.
 *   SSD-06  put() propagates the same dual-header presentation.
 *   SSD-07  No error message ever contains the credential value.
 *
 * Run: npx tsx --test tests/supabase-storage-driver.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

// App modules are imported lazily inside the tests (tsx transforms this suite
// as CJS, so top-level await is unavailable — mirrors tests/full-org-cutover).
type SupabaseDriverModule = typeof import('../src/lib/storage/supabase');
let driverMod: SupabaseDriverModule | null = null;
async function loadDriver(): Promise<SupabaseDriverModule> {
  if (!driverMod) driverMod = await import('../src/lib/storage/supabase');
  return driverMod;
}

/** The credential under test — an sb_secret_ style opaque key (NOT a JWT). */
const SB_SECRET_KEY = 'sb_secret_test_key_0123456789abcdefghijklmnopqrstuv';

interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** Boot a local capture server that records every request and replies per-callsite. */
async function startCapture(
  handler: (req: CapturedRequest) => { status: number; body?: string | Buffer; contentType?: string }
): Promise<{ server: Server; port: number; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        path: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(captured);
      const out = handler(captured);
      res.writeHead(out.status, { 'content-type': out.contentType ?? 'application/json' });
      res.end(out.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { server, port, requests };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const AUTH_FAILURE_BODY = JSON.stringify({
  statusCode: '403',
  error: 'Unauthorized',
  message: 'Invalid Compact JWS',
  code: 'AccessDenied',
});

/** Mirror of src/lib/storage/index.ts isNotFound(): true ONLY for code 'not_found'. */
const isNotFound = (err: unknown): boolean =>
  Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'not_found');

describe('Supabase Storage driver — authentication presentation', () => {
  test('SSD-01: sb_secret_ credential is sent as apikey AND Authorization Bearer', async () => {
    const { SupabaseStorageDriver } = await loadDriver();
    const { server, port, requests } = await startCapture(() => ({ status: 200, body: 'png-bytes' }));
    try {
      const driver = new SupabaseStorageDriver(`http://127.0.0.1:${port}`, SB_SECRET_KEY);
      const buf = await driver.get('screenshots/org-1/abc.png');

      assert.equal(requests.length, 1);
      const sent = requests[0];
      assert.equal(sent.headers['apikey'], SB_SECRET_KEY);
      assert.equal(sent.headers['authorization'], `Bearer ${SB_SECRET_KEY}`);
      assert.deepEqual([...buf], [...Buffer.from('png-bytes')]);
    } finally {
      await close(server);
    }
  });

  test('SSD-02: extra headers (Content-Type, x-upsert) are preserved alongside apikey/Authorization', async () => {
    const { SupabaseStorageDriver } = await loadDriver();
    const { server, port, requests } = await startCapture(() => ({ status: 200, body: '{"Key":"x"}' }));
    try {
      const driver = new SupabaseStorageDriver(`http://127.0.0.1:${port}`, SB_SECRET_KEY);
      await driver.put('screenshots/org-1/abc.png', { bytes: Buffer.from('x'), contentType: 'image/png' });

      const sent = requests[0];
      assert.equal(sent.method, 'POST');
      assert.equal(sent.headers['apikey'], SB_SECRET_KEY);
      assert.equal(sent.headers['authorization'], `Bearer ${SB_SECRET_KEY}`);
      assert.equal(sent.headers['content-type'], 'image/png');
      assert.equal(sent.headers['x-upsert'], 'true');
    } finally {
      await close(server);
    }
  });

  test('SSD-06: put() uses the same dual-header presentation as every other operation', async () => {
    const { SupabaseStorageDriver } = await loadDriver();
    const { server, port, requests } = await startCapture(() => ({ status: 200, body: '{}' }));
    try {
      const driver = new SupabaseStorageDriver(`http://127.0.0.1:${port}`, SB_SECRET_KEY);
      await driver.put('screenshots/org-1/abc.png', { bytes: Buffer.from('x'), contentType: 'image/png' });

      assert.equal(requests[0].headers['apikey'], SB_SECRET_KEY);
      assert.equal(requests[0].headers['authorization'], `Bearer ${SB_SECRET_KEY}`);
    } finally {
      await close(server);
    }
  });
});

describe('Supabase Storage driver — error classification', () => {
  test('SSD-03: 403 "Invalid Compact JWS" is an UNAVAILABLE error, never not_found', async () => {
    const { SupabaseStorageDriver } = await loadDriver();
    const { server, port, requests } = await startCapture(() => ({ status: 403, body: AUTH_FAILURE_BODY }));
    try {
      const driver = new SupabaseStorageDriver(`http://127.0.0.1:${port}`, SB_SECRET_KEY);

      await assert.rejects(
        () => driver.get('screenshots/org-1/missing.png'),
        (err: { code?: string; message?: string }) => {
          assert.equal(err.code, 'unavailable');
          assert.ok(!isNotFound(err), 'an auth failure must NOT be classified as not_found');
          assert.match(err.message ?? '', /403/);
          assert.match(err.message ?? '', /authentication rejected/i);
          return true;
        }
      );
      // The failing request still presented both headers (so the message can name the cause).
      assert.equal(requests[0].headers['apikey'], SB_SECRET_KEY);
    } finally {
      await close(server);
    }
  });

  test('SSD-03b: 401 authentication failure on upload is an error with an actionable message', async () => {
    const { SupabaseStorageDriver } = await loadDriver();
    const { server, port } = await startCapture(() => ({ status: 401, body: AUTH_FAILURE_BODY }));
    try {
      const driver = new SupabaseStorageDriver(`http://127.0.0.1:${port}`, SB_SECRET_KEY);
      await assert.rejects(
        () => driver.put('screenshots/org-1/abc.png', { bytes: Buffer.from('x'), contentType: 'image/png' }),
        (err: { code?: string; message?: string }) => {
          assert.equal(err.code, 'unavailable');
          assert.ok(!isNotFound(err));
          assert.match(err.message ?? '', /authentication rejected/i);
          return true;
        }
      );
    } finally {
      await close(server);
    }
  });

  test('SSD-04a: HTTP 404 remains classified as not_found', async () => {
    const { SupabaseStorageDriver } = await loadDriver();
    const { server, port } = await startCapture(() => ({ status: 404, body: 'not found' }));
    try {
      const driver = new SupabaseStorageDriver(`http://127.0.0.1:${port}`, SB_SECRET_KEY);
      await assert.rejects(
        () => driver.get('screenshots/org-1/missing.png'),
        (err: { code?: string }) => {
          assert.equal(err.code, 'not_found');
          assert.ok(isNotFound(err));
          return true;
        }
      );
    } finally {
      await close(server);
    }
  });

  test('SSD-04b: legacy Storage 400 "The resource was not found" remains not_found', async () => {
    const { SupabaseStorageDriver } = await loadDriver();
    const { server, port } = await startCapture(() => ({ status: 400, body: 'The resource was not found' }));
    try {
      const driver = new SupabaseStorageDriver(`http://127.0.0.1:${port}`, SB_SECRET_KEY);
      await assert.rejects(
        () => driver.get('screenshots/org-1/missing.png'),
        (err: { code?: string }) => {
          assert.equal(err.code, 'not_found');
          assert.ok(isNotFound(err));
          return true;
        }
      );
    } finally {
      await close(server);
    }
  });

  test('SSD-04c: delete() still treats a genuine not-found as an idempotent no-op', async () => {
    const { SupabaseStorageDriver } = await loadDriver();
    const { server, port } = await startCapture(() => ({ status: 404, body: 'The resource was not found' }));
    try {
      const driver = new SupabaseStorageDriver(`http://127.0.0.1:${port}`, SB_SECRET_KEY);
      await driver.delete('screenshots/org-1/gone.png'); // must NOT throw
    } finally {
      await close(server);
    }
  });

  test('SSD-05: unexpected 400 with a non-not-found body is an error, not not_found', async () => {
    const { SupabaseStorageDriver } = await loadDriver();
    const { server, port } = await startCapture(() => ({ status: 400, body: '{"error":"bad_request","message":"Invalid key"}' }));
    try {
      const driver = new SupabaseStorageDriver(`http://127.0.0.1:${port}`, SB_SECRET_KEY);
      await assert.rejects(
        () => driver.get('screenshots/org-1/abc.png'),
        (err: { code?: string }) => {
          assert.equal(err.code, 'unavailable');
          assert.ok(!isNotFound(err));
          return true;
        }
      );
    } finally {
      await close(server);
    }
  });

  test('SSD-05b: 500 server failure is unavailable, not not_found', async () => {
    const { SupabaseStorageDriver } = await loadDriver();
    const { server, port } = await startCapture(() => ({ status: 500, body: 'internal error' }));
    try {
      const driver = new SupabaseStorageDriver(`http://127.0.0.1:${port}`, SB_SECRET_KEY);
      await assert.rejects(
        () => driver.get('screenshots/org-1/abc.png'),
        (err: { code?: string }) => {
          assert.equal(err.code, 'unavailable');
          assert.ok(!isNotFound(err));
          return true;
        }
      );
    } finally {
      await close(server);
    }
  });

  test('SSD-07: error messages never contain the credential value', async () => {
    const { SupabaseStorageDriver } = await loadDriver();
    const { server, port } = await startCapture(() => ({ status: 403, body: AUTH_FAILURE_BODY }));
    try {
      const driver = new SupabaseStorageDriver(`http://127.0.0.1:${port}`, SB_SECRET_KEY);
      try {
        await driver.get('screenshots/org-1/missing.png');
        assert.fail('expected rejection');
      } catch (err) {
        const msg = String((err as Error).message);
        assert.ok(!msg.includes(SB_SECRET_KEY), 'the secret key must never appear in an error message');
      }
    } finally {
      await close(server);
    }
  });
});
