'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireAdminOrg } from '@/lib/api';
import { encryptSecret, decryptSecretWithMeta, maskSecret } from '@/lib/crypto';
import { safeFetch, isSafeTarget } from '@/lib/ssrf';
import { validateProviderConfig, apiEndpoint } from '@/lib/ai-provider-helper';
import { log, requestContext } from '@/lib/logger';

// ─── SSRF protection (shared with /api/ai-provider/test-connection) ────────
async function plainFetch(
  url: string,
  provider: string
): Promise<{ ok: boolean; status: number; statusText: string; headers: Headers; text: string } | null> {
  try {
    const res = await fetch(url, {
      method: provider === 'anthropic' ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'manual',
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, statusText: res.statusText, headers: res.headers, text };
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') {
      return { ok: false, status: 0, statusText: 'timeout', headers: new Headers(), text: '' };
    }
    return null;
  }
}

const DEFAULT_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1',
  mistral: 'https://api.mistral.ai/v1',
  ollama: 'http://localhost:11434',
  custom: '',
};

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdminOrg(req);
    if (!admin.ok) return authError(admin);

    const orgId = admin.organizationId;

    const body = await req.json();
    const { provider, apiKey, baseUrl } = body;

    if (!provider) {
      return NextResponse.json({ error: 'Provider is required' }, { status: 400 });
    }

    // Load stored API key from org settings, falling back to global
    let effectiveKey = apiKey || '';
    if (!effectiveKey && provider !== 'ollama') {
      const orgSetting = await db.organizationSetting.findUnique({
        where: { organizationId_key: { organizationId: orgId, key: 'ai_api_key' } },
      });
      if (orgSetting) {
        effectiveKey = orgSetting.value ? decryptSecretWithMeta(orgSetting.value).plaintext : '';
      } else {
        const globalSetting = await db.systemSetting.findUnique({ where: { key: 'ai_api_key' } });
        effectiveKey = globalSetting?.value ? decryptSecretWithMeta(globalSetting.value).plaintext : '';
      }
    }

    if (provider === 'custom' && !baseUrl) {
      return NextResponse.json({ error: 'Base URL is required for Custom provider' }, { status: 400 });
    }
    if (!effectiveKey && provider !== 'ollama' && provider !== 'custom') {
      return NextResponse.json({ error: 'API key is required' }, { status: 400 });
    }

    const targetUrl = (baseUrl || DEFAULT_URLS[provider] || '').replace(/\/+$/, '');
    if (!targetUrl) {
      return NextResponse.json({ error: 'A valid base URL is required' }, { status: 400 });
    }

    const configError = validateProviderConfig({ provider, baseUrl: baseUrl || undefined });
    if (configError) {
      return NextResponse.json({ error: configError }, { status: 400 });
    }

    // SSRF guard
    const isTrustedDefault = !!DEFAULT_URLS[provider] && !baseUrl && provider !== 'ollama';
    const isOllamaLocal = provider === 'ollama' && !baseUrl;
    if (!isTrustedDefault && !isOllamaLocal && !(await isSafeTarget(targetUrl))) {
      return NextResponse.json(
        { error: 'Unsafe base URL: internal/private network addresses are not allowed' },
        { status: 400 }
      );
    }

    const testUrl =
      provider === 'openai'
        ? `${targetUrl}/models`
        : provider === 'anthropic'
          ? apiEndpoint(targetUrl, '/v1/messages')
          : provider === 'mistral'
            ? `${targetUrl}/models`
            : provider === 'google'
              ? apiEndpoint(targetUrl, '/v1/models')
              : provider === 'custom'
                ? `${targetUrl}/models`
                : `${targetUrl}/api/tags`;

    const headers: Record<string, string> = {};
    if (effectiveKey) {
      if (provider === 'anthropic') {
        headers['x-api-key'] = effectiveKey;
        headers['anthropic-version'] = '2023-06-01';
      } else if (provider === 'google') {
        headers['x-goog-api-key'] = effectiveKey;
      } else {
        headers['Authorization'] = `Bearer ${effectiveKey}`;
      }
    }

    let status = 'connected';
    let message = '';

    try {
      const isOllama = provider === 'ollama' && !baseUrl;
      const response = isOllama
        ? await plainFetch(testUrl, provider)
        : await safeFetch(
            testUrl,
            {
              method: provider === 'anthropic' ? 'POST' : 'GET',
              headers: { ...headers, 'Content-Type': 'application/json' },
              redirect: 'manual',
              ...(provider === 'anthropic' ? {
                body: JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] }),
              } : {}),
            },
            10000
          );

      if (!response) {
        status = 'error';
        message = isOllama
          ? 'Connection failed: cannot reach local Ollama instance'
          : 'Connection failed: target rejected as unsafe or unreachable';
      } else if (response.ok) {
        status = 'connected';
        message = 'Connection successful';
      } else if (response.status === 400) {
        status = 'error';
        message = 'Endpoint rejected the request (400) — check the base URL and provider protocol';
      } else if (response.status === 401) {
        status = 'error';
        message = 'Invalid API key';
      } else if (response.status === 403) {
        status = 'error';
        message = 'Access denied — check API key permissions';
      } else if (response.status === 404) {
        status = 'error';
        message = 'API endpoint not found — check base URL';
      } else {
        status = 'error';
        message = `Unexpected response: ${response.status}`;
      }
    } catch {
      status = 'error';
      message = 'Connection failed: request error';
    }

    // Persist settings for this org when connection test passed
    if (status === 'connected') {
      await db.$transaction(async (tx) => {
        await tx.organizationSetting.upsert({
          where: { organizationId_key: { organizationId: orgId, key: 'ai_provider' } },
          update: { value: provider },
          create: { organizationId: orgId, key: 'ai_provider', value: provider, category: 'ai' },
        });

        if (apiKey) {
          const encrypted = encryptSecret(apiKey);
          await tx.organizationSetting.upsert({
            where: { organizationId_key: { organizationId: orgId, key: 'ai_api_key' } },
            update: { value: encrypted },
            create: { organizationId: orgId, key: 'ai_api_key', value: encrypted, category: 'ai' },
          });
          log.info('ai-provider.key_stored', { provider, maskedKey: maskSecret(apiKey) }, requestContext(req));
        }

        if (baseUrl) {
          await tx.organizationSetting.upsert({
            where: { organizationId_key: { organizationId: orgId, key: 'ai_base_url' } },
            update: { value: baseUrl },
            create: { organizationId: orgId, key: 'ai_base_url', value: baseUrl, category: 'ai' },
          });
        }

        await tx.auditLog.create({
          data: {
            action: 'configure',
            resource: 'ai_settings',
            resourceId: orgId,
            description: `AI provider connection tested and persisted (${provider}) by ${admin.email}`,
            userId: admin.userId,
            organizationId: orgId,
          },
        });
      });
    }

    return NextResponse.json({ status, message, provider, url: testUrl });
  } catch (error) {
    log.error('api.org.ai-settings.test-connection', { error: String(error) }, requestContext(req));
    return NextResponse.json({ error: 'Test failed' }, { status: 500 });
  }
}
