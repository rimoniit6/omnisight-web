'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg, parseJsonBody, BodyParseError } from '@/lib/api';
import { encryptSecret } from '@/lib/crypto';
import { validateProviderConfig } from '@/lib/ai-provider-helper';
import { log, requestContext } from '@/lib/logger';

// AI settings keys that are stored per-organization in OrganizationSetting.
const AI_SETTING_KEYS = [
  'ai_provider',
  'ai_api_key',
  'ai_base_url',
  'ai_model',
  'ai_temperature',
  'ai_max_tokens',
  'ai_top_p',
  'ai_frequency_penalty',
  'ai_presence_penalty',
  'ai_insights_enabled',
  'ai_auto_reports',
  'ai_anomaly_detection',
  'ai_realtime_analysis',
  'ai_response_caching',
  'ai_system_prompt',
] as const;

type AiSettingKey = (typeof AI_SETTING_KEYS)[number];

const AI_SETTINGS_SET = new Set<string>(AI_SETTING_KEYS);

// Secret keys — values are encrypted at rest and redacted in responses.
const SECRET_KEYS = new Set(['ai_api_key']);
const REDACTED = 'REDACTED';

function redact(value: string, key: string): string {
  return SECRET_KEYS.has(key) && value ? REDACTED : value;
}

// ─── GET /api/organization/ai-settings ─────────────────────────────────────
// Returns AI settings for the caller's organization.
// Reads from OrganizationSetting first (per-org values), then falls back to
// SystemSetting for global defaults (backward compat during migration).
// Requires admin-level role (org_admin or super_admin with an active org).

export async function GET(req: NextRequest) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const orgId = admin.organizationId;

    // Load org-scoped AI settings
    const orgSettings = await db.organizationSetting.findMany({
      where: {
        organizationId: orgId,
        key: { in: [...AI_SETTINGS_SET] },
      },
    });

    // Build the settings map: org values take precedence, SystemSetting as fallback
    const settingsMap: Record<string, string> = {};
    const orgKeys = new Set(orgSettings.map((s) => s.key));

    for (const key of AI_SETTING_KEYS) {
      const orgVal = orgSettings.find((s) => s.key === key);
      if (orgVal) {
        settingsMap[key] = redact(orgVal.value, key);
      } else {
        // Fallback to global SystemSetting for backward compat
        const globalSetting = await db.systemSetting.findUnique({ where: { key } });
        if (globalSetting) {
          settingsMap[key] = redact(globalSetting.value, key);
        }
      }
    }

    const data = Object.entries(settingsMap).map(([key, value]) => ({
      key,
      value,
      category: 'ai',
    }));

    return NextResponse.json({ data, grouped: { ai: data } });
  } catch (error) {
    log.error('api.org.ai-settings.GET', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to fetch AI settings' }, { status: 500 });
  }
}

// ─── PUT /api/organization/ai-settings ─────────────────────────────────────
// Saves an AI setting for the caller's organization.
// Writes to OrganizationSetting (per-org). The organization is derived
// strictly from the authenticated session — never from client input.
// Requires admin-level role (org_admin or super_admin with an active org).

export async function PUT(req: NextRequest) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const orgId = admin.organizationId;

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
    if (!key || typeof key !== 'string') {
      return NextResponse.json({ error: 'Key is required' }, { status: 400 });
    }
    if (typeof value !== 'string') {
      return NextResponse.json({ error: 'Value must be a string' }, { status: 422 });
    }

    // Only allow AI setting keys
    if (!AI_SETTINGS_SET.has(key)) {
      return NextResponse.json({ error: `Unsupported setting key: ${key}` }, { status: 400 });
    }

    // Never overwrite a real secret with the redaction sentinel
    if (SECRET_KEYS.has(key)) {
      if (!value || value === REDACTED) {
        // Return the existing value (redacted) without overwriting
        const existing = await db.organizationSetting.findUnique({
          where: { organizationId_key: { organizationId: orgId, key } },
        });
        return NextResponse.json({
          data: { key, value: existing ? redact(existing.value, key) : '', category: 'ai' },
        });
      }
    }

    // Provider-aware validation for AI configuration keys
    if (key === 'ai_provider' || key === 'ai_model' || key === 'ai_base_url') {
      const [storedProvider, storedModel, storedBaseUrl] = await Promise.all([
        getAiSetting(orgId, 'ai_provider'),
        getAiSetting(orgId, 'ai_model'),
        getAiSetting(orgId, 'ai_base_url'),
      ]);
      const provider = key === 'ai_provider' ? value : storedProvider;
      const model = key === 'ai_model' ? value : storedModel;
      const baseUrl = key === 'ai_base_url' ? value : storedBaseUrl;
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

    // Encrypt secrets at rest
    const storedValue = SECRET_KEYS.has(key) && value ? encryptSecret(value) : value;

    // Upsert into OrganizationSetting (per-org)
    const { setting } = await db.$transaction(async (tx) => {
      const upserted = await tx.organizationSetting.upsert({
        where: { organizationId_key: { organizationId: orgId, key } },
        update: { value: storedValue },
        create: { organizationId: orgId, key, value: storedValue, category: 'ai' },
      });

      await tx.auditLog.create({
        data: {
          action: 'configure',
          resource: 'ai_settings',
          resourceId: upserted.id,
          description: `AI setting ${key} updated by ${admin.email}`,
          userId: admin.userId,
          organizationId: orgId,
        },
      });

      return { setting: upserted };
    });

    return NextResponse.json({
      data: { ...setting, value: redact(setting.value, key) },
    });
  } catch (error) {
    log.error('api.org.ai-settings.PUT', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Failed to update AI setting' }, { status: 500 });
  }
}

// ─── Helper: read an AI setting from org scope (with SystemSetting fallback) ─

async function getAiSetting(orgId: string, key: string): Promise<string> {
  const orgSetting = await db.organizationSetting.findUnique({
    where: { organizationId_key: { organizationId: orgId, key } },
  });
  if (orgSetting) return orgSetting.value;

  const globalSetting = await db.systemSetting.findUnique({ where: { key } });
  return globalSetting?.value || '';
}
