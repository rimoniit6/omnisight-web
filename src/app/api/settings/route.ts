'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg, requireSuperAdmin, parseJsonBody, BodyParseError } from '@/lib/api';
import { encryptSecret } from '@/lib/crypto';
import { validateProviderConfig } from '@/lib/ai-provider-helper';
import { log, requestContext } from '@/lib/logger';

// Values of these keys are secrets — never returned to the client and stored
// encrypted at rest.
const SECRET_KEYS = new Set(['ai_api_key']);
const REDACTED = 'REDACTED';

// P3: dead security keys. No code ever consumed these (2FA is not
// implemented; admin session lifetime is governed by JWT_EXPIRES_IN; login
// brute force by the per-IP+email rate limit). They must no longer be
// exposed by GET or accepted by PUT — pretending they work would be a lie.
const DEAD_SECURITY_KEYS = new Set(['two_factor_auth', 'session_timeout_minutes', 'max_login_attempts']);

function isDeadSecurityKey(key: string): boolean {
  return DEAD_SECURITY_KEYS.has(key);
}

function redact(value: string, key: string): string {
  return SECRET_KEYS.has(key) && value ? REDACTED : value;
}

export async function GET(req: NextRequest) {
  try {
    // Defense-in-depth: proxy gates /api/settings to admin+; the handler
    // enforces it too (settings include provider config and secret envelopes).
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const settings = await db.systemSetting.findMany({
      orderBy: { key: 'asc' },
    });
    // Dead security keys are never exposed (they were removed by migration
    // 20260811153544; filtering here also protects stale/corrupt rows).
    const visible = settings.filter((s) => !isDeadSecurityKey(s.key));
    // Group by category (secrets redacted in both shapes)
    const grouped: Record<string, Array<{ id: string; key: string; value: string; category: string | null }>> = {};
    visible.forEach((s) => {
      const cat = s.category || 'general';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push({ id: s.id, key: s.key, value: redact(s.value, s.key), category: s.category });
    });
    const data = visible.map((s) => ({ ...s, value: redact(s.value, s.key) }));
    return NextResponse.json({ data, grouped });
  } catch (error) {
    log.error('api.settings.', { error: String('Settings GET error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    // P1-7: SystemSetting is INSTANCE-GLOBAL (no org column). Org-bound admins
    // must never mutate global configuration consumed by every organization —
    // only the platform super_admin may write these keys. GET stays admin+
    // (global read is intentional); writes are super_admin-only.
    const superAdmin = await requireSuperAdmin(req);
    if (!superAdmin.ok) return authError(superAdmin);

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      if (e instanceof BodyParseError) {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      throw e;
    }
    const { key, value } = body;
    if (!key || typeof key !== 'string') return NextResponse.json({ error: 'Key is required' }, { status: 400 });
    if (typeof value !== 'string') {
      return NextResponse.json({ error: 'Value must be a string' }, { status: 422 });
    }

    // P3: reject attempts to write dead security settings (400) — never
    // silently recreate them.
    if (isDeadSecurityKey(key)) {
      return NextResponse.json(
        { error: `${key} is not a supported setting` },
        { status: 400 }
      );
    }

    // Never overwrite a real secret with the redaction sentinel (or blank)
    // sent back by the UI that prefilled from GET.
    if (SECRET_KEYS.has(key)) {
      if (!value || value === REDACTED) {
        const existing = await db.systemSetting.findUnique({ where: { key } });
        return NextResponse.json({
          data: existing
            ? { ...existing, value: redact(existing.value, key) }
            : { key, value: '', category: 'general' },
        });
      }
    }

    // Empty value CLEARS a non-secret setting (e.g. ai_base_url '' → the
    // provider default is used). This is the Settings UI's documented reset
    // path (switch provider → clear base URL) — rejecting '' previously left
    // a stale OpenAI-compatible base URL in place, which broke the google
    // provider with a 404 (DS-P1-1).
    if (value === '') {
      const existing = await db.systemSetting.findUnique({ where: { key } });
      if (!existing) {
        return NextResponse.json({ data: { key, value: '', category: 'general' } });
      }
      const { setting } = await db.$transaction(async (tx) => {
        await tx.systemSetting.delete({ where: { key } });
        await tx.auditLog.create({
          data: {
            action: 'configure',
            resource: 'settings',
            resourceId: existing.id,
            description: `Global setting ${key} cleared by ${superAdmin.email}`,
            userId: superAdmin.userId,
            organizationId: null,
          },
        });
        return { setting: existing };
      });
      return NextResponse.json({ data: { ...setting, value: '' } });
    }

    // Encrypt secrets at rest (e.g. AI provider API keys).
    const storedValue = SECRET_KEYS.has(key) && value ? encryptSecret(value) : value;

    // Provider-aware validation for AI configuration keys: the stored
    // combination must be executable (e.g. google requires a gemini-* model
    // and the Google endpoint — google + gpt-4o is invalid). We read the
    // other two AI config keys (existing stored values, with the incoming key
    // taking precedence) and reject incompatible combinations with a clear
    // 400 instead of persisting a broken config that would silently fall back.
    if (key === 'ai_provider' || key === 'ai_model' || key === 'ai_base_url') {
      const [storedProvider, storedModel, storedBaseUrl] = await Promise.all([
        db.systemSetting.findUnique({ where: { key: 'ai_provider' } }),
        db.systemSetting.findUnique({ where: { key: 'ai_model' } }),
        db.systemSetting.findUnique({ where: { key: 'ai_base_url' } }),
      ]);
      const provider = key === 'ai_provider' ? value : storedProvider?.value;
      const model = key === 'ai_model' ? value : storedModel?.value;
      const baseUrl = key === 'ai_base_url' ? value : storedBaseUrl?.value;
      if (provider) {
        const configError = validateProviderConfig({ provider, model, baseUrl });
        if (configError) {
          return NextResponse.json(
            { error: `Invalid AI configuration: ${configError}` },
            { status: 400 }
          );
        }
      }
    }

    // Instance-global mutation, audited with the verified super_admin actor.
    // organizationId stays null (no org scope on SystemSetting) — the row is
    // deliberately global and the audit records that.
    const { setting } = await db.$transaction(async (tx) => {
      const upserted = await tx.systemSetting.upsert({
        where: { key },
        update: { value: storedValue },
        create: { key, value: storedValue, category: SECRET_KEYS.has(key) ? 'ai' : 'general' },
      });
      await tx.auditLog.create({
        data: {
          action: 'configure',
          resource: 'settings',
          resourceId: upserted.id,
          description: `Global setting ${key} updated by ${superAdmin.email}`,
          userId: superAdmin.userId,
          organizationId: null,
        },
      });
      return { setting: upserted };
    });
    // P3-6: never echo the ciphertext back to the client — secrets are
    // REDACTED in responses exactly like GET.
    return NextResponse.json({ data: { ...setting, value: redact(setting.value, key) } });
  } catch (error) {
    log.error('api.settings.', { error: String('Settings PUT error:') }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update setting' }, { status: 500 });
  }
}
