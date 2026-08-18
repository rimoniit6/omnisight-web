import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { db } from '@/lib/db';
import { getRequestToken, verifyJWT, hasRolePermission } from '@/lib/auth';
import { getClientIpFromHeaders, UNKNOWN_CLIENT_IP } from '@/lib/client-ip';
import { putAvatar } from '@/lib/storage';

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const AVATAR_SIZE = 128;

export async function POST(request: NextRequest) {
  try {
    // ─── Auth check ──────────────────────────────────────────────────────
    const token = getRequestToken(request);
    if (!token) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 });
    }

    const payload = await verifyJWT(token);
    if (!payload) {
      return NextResponse.json({ success: false, error: 'Invalid or expired token' }, { status: 401 });
    }

    // ─── Parse query params ──────────────────────────────────────────────
    const { searchParams } = new URL(request.url);
    const type = searchParams.get('type') as 'employee' | 'user' | null ?? 'employee';
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ success: false, error: 'Missing required query param: id' }, { status: 400 });
    }

    if (type !== 'employee' && type !== 'user') {
      return NextResponse.json({ success: false, error: "type must be 'employee' or 'user'" }, { status: 400 });
    }

    // ─── Ownership / authorization check (IDOR protection) ──────────────
    const isAdmin = hasRolePermission(payload.role, 'admin');
    if (type === 'user') {
      // Users may only change their own avatar, or admins any user's
      if (id !== payload.userId && !isAdmin) {
        return NextResponse.json({ success: false, error: 'You can only update your own avatar' }, { status: 403 });
      }
    } else {
      // Employee avatars require admin, and the employee must be in the
      // caller's organization (tenant isolation)
      if (!isAdmin) {
        return NextResponse.json({ success: false, error: 'Admin access required' }, { status: 403 });
      }
      if (payload.organizationId) {
        const employee = await db.employee.findUnique({
          where: { id },
          select: { organizationId: true },
        });
        if (!employee || employee.organizationId !== payload.organizationId) {
          return NextResponse.json({ success: false, error: 'Employee not found in your organization' }, { status: 404 });
        }
      }
    }

    // ─── Parse multipart form ────────────────────────────────────────────
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'No file provided or invalid file' }, { status: 400 });
    }

    // ─── Validate file ───────────────────────────────────────────────────
    if (!ALLOWED_MIME_TYPES.includes(file.type)) {
      return NextResponse.json(
        { success: false, error: `Invalid file type: ${file.type}. Allowed: jpeg, png, webp, gif` },
        { status: 400 },
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { success: false, error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Max: 5MB` },
        { status: 400 },
      );
    }

    // ─── Process image with sharp ────────────────────────────────────────
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const processedBuffer = await sharp(fileBuffer)
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
      .png()
      .toBuffer();

    // ─── Store the processed avatar ─────────────────────────────
    // The object goes to the active storage driver (local filesystem under
    // public/uploads/avatars, or the public Supabase avatars bucket on
    // Vercel). The stored URL scheme stays /uploads/avatars/<id>.png so
    // existing UI and DB values keep working.
    const avatarFilename = `${id}.png`;
    await putAvatar(avatarFilename, processedBuffer);

    const avatarUrl = `/uploads/avatars/${avatarFilename}`;

    // ─── Update database + audit log ──────────────────────────────────────
    await db.$transaction(async (tx) => {
      if (type === 'employee') {
        await tx.employee.update({
          where: { id },
          data: { avatar: avatarUrl },
        });
      } else {
        await tx.appUser.update({
          where: { id },
          data: { avatar: avatarUrl },
        });
      }

      // ─── Audit log ─────────────────────────────────────────────────────
      const orgId = payload.organizationId;
      if (orgId) {
        await tx.auditLog.create({
          data: {
            action: 'update',
            resource: type,
            resourceId: id,
            description: `Avatar updated for ${type} ${id}`,
            userId: payload.userId,
            // Canonical spoof-resistant client IP (same resolver as rate
            // limiting / other audit logs) — never the raw left-most XFF entry.
            ipAddress: (() => {
              const ip = getClientIpFromHeaders(request.headers);
              return ip === UNKNOWN_CLIENT_IP ? null : ip;
            })(),
            organizationId: orgId,
          },
        });
      }
    });

    // ─── Response ────────────────────────────────────────────────────────
    return NextResponse.json({ success: true, avatar: avatarUrl });
  } catch (error) {
    console.error('[Avatar Upload Error]', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 },
    );
  }
}
