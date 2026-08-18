/**
 * PNG dimension extraction — pure unit tests (no DB).
 *
 * parsePngDimensions reads width/height from the PNG IHDR chunk (big-endian
 * bytes 16–23) and returns null for anything that is not a well-formed PNG.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let parsePngDimensions: (bytes: Buffer) => { width: number; height: number } | null;

test('PD-setup: load parsePngDimensions', async () => {
  parsePngDimensions = (await import('../src/lib/screenshots/storage')).parsePngDimensions;
});

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

/** Build a minimal PNG-like buffer with the given width/height in IHDR. */
function makePng(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  PNG_SIGNATURE.copy(header, 0);
  header.writeUInt32BE(13, 8); // IHDR chunk length
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

test('PD-1: extracts width/height from a valid PNG IHDR', () => {
  const dims = parsePngDimensions(makePng(1938, 1038));
  assert.deepEqual(dims, { width: 1938, height: 1038 });
});

test('PD-2: extracts 1x1 dimensions', () => {
  assert.deepEqual(parsePngDimensions(makePng(1, 1)), { width: 1, height: 1 });
});

test('PD-3: returns null for a buffer that is not a PNG (bad signature)', () => {
  const bytes = Buffer.from('89504e470d0a1a00', 'hex'); // last signature byte wrong
  assert.equal(parsePngDimensions(bytes), null);
});

test('PD-4: returns null for an empty / truncated buffer', () => {
  assert.equal(parsePngDimensions(Buffer.alloc(0)), null);
  assert.equal(parsePngDimensions(Buffer.alloc(16)), null);
  assert.equal(parsePngDimensions(PNG_SIGNATURE), null); // signature only, no IHDR
});

test('PD-5: returns null when the first chunk is not IHDR', () => {
  const bytes = makePng(100, 100);
  bytes.write('ABCD', 12, 'ascii'); // corrupt the chunk type
  assert.equal(parsePngDimensions(bytes), null);
});

test('PD-6: returns null for zero or absurd dimensions (never trust malformed content)', () => {
  assert.equal(parsePngDimensions(makePng(0, 100)), null);
  assert.equal(parsePngDimensions(makePng(100, 0)), null);
  assert.equal(parsePngDimensions(makePng(70_000, 100)), null); // > 65535
});

test('PD-7: returns null for JPEG/WebP content (dimensions stay NULL server-side)', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(48, 0x11)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WEBP'), Buffer.alloc(48, 0x22)]);
  assert.equal(parsePngDimensions(jpeg), null);
  assert.equal(parsePngDimensions(webp), null);
});
