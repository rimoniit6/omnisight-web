'use server';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { authError, requireSuperAdmin } from '@/lib/api';
import { encryptSecret, decryptSecretWithMeta, maskSecret } from '@/lib/crypto';
import { safeFetch, isSafeTarget } from '@/lib/ssrf';
import { validateProviderConfig, apiEndpoint } from '@/lib/ai-provider-helper';

// ─── SSRF protection ────────────────────────────────────────────────────────
// Delegates to the shared SSRF-safe client (src/lib/ssrf.ts): rejects
// internal/private targets including octal/hex/short-form IP literals and
// IPv4-mapped IPv6, performs DNS resolution + revalidation before connecting,
// and never follows redirects.

// Plain fetch used only for Ollama's localhost default (documented
// self-hosted endpoint). Returns the same shape as safeFetch's result.
async function plainFetch(
  url: string,
  provider: string
): Promise<{ ok: boolean; status: number; statusText: string; headers: Headers; text: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
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
  } finally {
    clearTimeout(timer);
  }
}

// Default endpoint for each provider — the only place a connection is ever
// attempted without user-supplied baseUrl validation.
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
    // P1-7: this route PERSISTS instance-global AI configuration
    // (ai_provider / ai_api_key / ai_base_url in SystemSetting). Org-bound
    // admins must never change global AI config consumed by every tenant —
    // only the platform super_admin may test + persist. (The proxy's admin
    // gate remains as defense-in-depth; the handler requires super_admin.)
    const superAdmin = await requireSuperAdmin(req);
    if (!superAdmin.ok) return authError(superAdmin);

    const body = await req.json();
    const { provider, apiKey, baseUrl } = body;

    if (!provider) {
      return NextResponse.json({ error: 'Provider is required' }, { status: 400 });
    }

    // If no apiKey was supplied but one exists for this provider, load it
    // (decrypted) so a stored key can be re-tested without re-entry.
    let effectiveKey = apiKey || '';
    if (!effectiveKey && provider !== 'ollama') {
      const stored = await db.systemSetting.findUnique({ where: { key: 'ai_api_key' } });
      effectiveKey = stored?.value ? decryptSecretWithMeta(stored.value).plaintext : '';
    }

    // Custom provider requires baseUrl; others require apiKey (except ollama)
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

    // Provider-aware compatibility: reject a provider/baseUrl combination that
    // can never make a valid request (e.g. google + OpenAI-compatible gateway)
    // BEFORE testing or persisting anything.
    const configError = validateProviderConfig({
      provider,
      baseUrl: baseUrl || undefined,
    });
    if (configError) {
      return NextResponse.json({ error: configError }, { status: 400 });
    }

    // SSRF guard: any user-supplied URL (baseUrl override, custom provider)
    // must resolve to public IPs. Trusted defaults are allowed because they
    // are hardcoded constants, not user input. Ollama's localhost default is
    // exempt: it is the documented self-hosted endpoint.
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
              // The google provider speaks the NATIVE generateContent REST API
              // ({base}/v1/models/{model}:generateContent). Test the same
              // native surface — never the OpenAI-compatible gateway, which
              // has a different protocol and would give a false positive.
              ? apiEndpoint(targetUrl, '/v1/models')
              : provider === 'custom'
                ? `${targetUrl}/models`
                : `${targetUrl}/api/tags`; // Ollama

    const headers: Record<string, string> = {};
    if (effectiveKey) {
      if (provider === 'anthropic') {
        headers['x-api-key'] = effectiveKey;
        headers['anthropic-version'] = '2023-06-01';
      } else if (provider === 'google') {
        // Google's native API authenticates with x-goog-api-key (matching
        // callAIProvider's google branch) — Authorization: Bearer is the
        // OpenAI-compatible protocol and would test the WRONG surface.
        headers['x-goog-api-key'] = effectiveKey;
      } else {
        headers['Authorization'] = `Bearer ${effectiveKey}`;
      }
    }

    let status = 'connected';
    let message = '';

    try {
      // Ollama's localhost default is the documented self-hosted endpoint and
      // is exempt from the SSRF gate (matching ai-provider-helper). Any other
      // target goes through the hardened safeFetch client.
      const isOllamaLocal = provider === 'ollama' && !baseUrl;
      const response = isOllamaLocal
        ? await plainFetch(testUrl, provider)
        : await safeFetch(
            testUrl,
            {
              method: provider === 'anthropic' ? 'POST' : 'GET',
              headers: {
                ...headers,
                'Content-Type': 'application/json',
              },
              // Never follow redirects: a redirect could point at an internal host
              redirect: 'manual',
              // For Anthropic, we need a body
              ...(provider === 'anthropic' ? {
                body: JSON.stringify({ model: 'claude-3-haiku-20240307', max_tokens: 1, messages: [{ role: 'user', content: 'test' }] }),
              } : {}),
            },
            10000
          );

      if (!response) {
        status = 'error';
        message = isOllamaLocal
          ? 'Connection failed: cannot reach local Ollama instance'
          : 'Connection failed: target rejected as unsafe or unreachable';
      } else if (response.ok) {
        status = 'connected';
        message = 'Connection successful';
      } else if (response.status === 400) {
        // DS-P3-2: 400 means the request itself was rejected — for google with
        // a mismatched protocol/base URL this is exactly the failure the
        // generation path hits. Never report it as connected.
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

    // Only persist settings when the connection test passed. All three keys
    // are written in one transaction with the audit row so a partial write is
    // impossible and the change is attributed to the verified super_admin.
    if (status === 'connected') {
      await db.$transaction(async (tx) => {
        const providerRow = await tx.systemSetting.upsert({
          where: { key: 'ai_provider' },
          update: { value: provider },
          create: { key: 'ai_provider', value: provider, category: 'ai' },
        });

        if (apiKey) {
          // Encrypt at rest — never store the plaintext API key.
          const encrypted = encryptSecret(apiKey);
          await tx.systemSetting.upsert({
            where: { key: 'ai_api_key' },
            update: { value: encrypted },
            create: { key: 'ai_api_key', value: encrypted, category: 'ai' },
          });
          console.info(`[ai-provider] API key stored (${maskSecret(apiKey)})`);
        }

        if (baseUrl) {
          await tx.systemSetting.upsert({
            where: { key: 'ai_base_url' },
            update: { value: baseUrl },
            create: { key: 'ai_base_url', value: baseUrl, category: 'ai' },
          });
        }

        await tx.auditLog.create({
          data: {
            action: 'configure',
            resource: 'settings',
            resourceId: providerRow.id,
            description: `AI provider connection tested and persisted (${provider}) by ${superAdmin.email}`,
            userId: superAdmin.userId,
            organizationId: null,
          },
        });
      });
    }

    return NextResponse.json({ status, message, provider, url: testUrl });
  } catch (error) {
    console.error('AI Provider test error:', error);
    return NextResponse.json({ error: 'Test failed' }, { status: 500 });
  }
}
