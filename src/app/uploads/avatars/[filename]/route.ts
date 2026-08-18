import { NextResponse } from 'next/server';
import { basename } from 'path';
import { getAvatar, isNotFound } from '@/lib/storage';

// GET /uploads/avatars/<filename>
// Serves stored avatar images through the active storage driver.
//
// WHY THIS ROUTE EXISTS:
//   Avatars have always been stored at the URL scheme /uploads/avatars/<id>.png
//   (written by POST /api/upload/avatar). On a self-hosted box the local driver
//   writes those files under public/uploads/avatars/ and the static server
//   serves them directly. On Vercel the filesystem is read-only, so the object
//   goes to Supabase Storage (public "avatars" bucket) — and this route serves
//   it back under the SAME URL scheme. No UI or DB change was required; the
//   route only ever handles requests the static layer did not already satisfy
//   (on self-hosted hosts the existing static file wins, bytes are identical).
//
// SECURITY:
//   - The filename is reduced to its basename (never used as a path) — no
//     traversal.
//   - Only *.png objects are served (avatars are always processed to PNG by
//     sharp before storage).
//   - The physical bytes must carry a real PNG signature — anything else is
//     served as a 404, so a tampered object can never be interpreted as HTML,
//     SVG or another executable content type.
//   - Avatars are deliberately NOT behind the /api auth proxy (matching the
//     legacy public/static behavior — the URL is not sensitive and is used in
//     <img> tags by many pages).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const name = basename(filename || '');

  // Only bare *.png names are ever served (avatar uploads are always
  // "<uuid-or-id>.png"). A missing, non-PNG, or traversal-shaped filename is
  // indistinguishable from a missing avatar.
  if (!name || !/^[A-Za-z0-9._-]+\.png$/i.test(name)) {
    return new NextResponse('Not found', { status: 404 });
  }

  let bytes: Buffer;
  try {
    bytes = await getAvatar(name);
  } catch (error) {
    if (isNotFound(error)) {
      return new NextResponse('Not found', { status: 404 });
    }
    throw error;
  }

  // Physical signature check — never trust the object name alone.
  if (
    bytes.length < 8 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return new NextResponse('Not found', { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.length),
      'X-Content-Type-Options': 'nosniff',
      // Avatar URLs are content-addressed by id and the client appends a
      // cache-buster (?t=) on upload, so long-lived caching is safe.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
