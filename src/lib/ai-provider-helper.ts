import { db } from '@/lib/db';
import { decryptSecretWithMeta, encryptSecret, isEncryptedSecret } from '@/lib/crypto';
import { safeFetch } from '@/lib/ssrf';

// ── SSRF-safe provider transport ───────────────────────────────────────────
// Every outbound provider call runs through the shared hardened client.
// The only exception is Ollama's documented self-hosted localhost default
// (http://localhost:11434), which is the local inference endpoint admins
// explicitly configure; user-supplied URLs always go through SSRF checks.

async function providerFetch(
  url: string,
  init?: RequestInit,
  allowOllamaLocalhost = false
): Promise<Response | null> {
  const isOllamaDefault =
    allowOllamaLocalhost && url.startsWith('http://localhost:11434');
  if (isOllamaDefault) {
    try {
      return await fetch(url, init);
    } catch {
      return null;
    }
  }
  const safe = await safeFetch(url, init, 30000);
  if (!safe) return null;
  return new Response(safe.text, {
    status: safe.status,
    statusText: safe.statusText,
    headers: safe.headers,
  });
}

// ── Versioned endpoint builder ──────────────────────────────────────────────
// OpenAI-style providers (openai/mistral/custom) are called at
//   {baseUrl}/v1/chat/completions
// but several providers (e.g. OpenRouter) document their base URL as already
// ending in /v1 (https://openrouter.ai/api/v1). Blindly appending /v1 again
// would produce .../v1/v1/chat/completions → 404. The same applies to the
// Anthropic (/v1/messages) and Google (/v1/models/...) endpoints. Normalize so
// the version segment is never duplicated: if the configured base URL already
// ends with /v1, use it as-is; otherwise append /v1.
export function apiEndpoint(baseUrl: string, versionedPath: string): string {
  const clean = baseUrl.replace(/\/+$/, '');
  const pathWithoutVersion = versionedPath.replace(/^\/v1\//, '');
  return /\/v1$/i.test(clean)
    ? `${clean}/${pathWithoutVersion}`
    : `${clean}/v1/${pathWithoutVersion}`;
}

// ── Provider Defaults ───────────────────────────────────────────────────────

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
  mistral: 'https://api.mistral.ai',
  ollama: 'http://localhost:11434',
  custom: '', // user must provide
};

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-haiku-20240307',
  // gemini-1.5-pro was retired for new API keys (HTTP 404 on generateContent
  // for accounts provisioned after the 2.x/3.x cutoff). gemini-3.5-flash is
  // the verified-working default for new keys.
  google: 'gemini-3.5-flash',
  mistral: 'mistral-small-latest',
  ollama: 'llama3',
  custom: '', // user must provide
};

// Google model prefix: only Gemini models speak the generateContent API.
const GOOGLE_GEMINI_PREFIX = 'gemini';

/**
 * Provider-aware configuration validation (finding: google + gpt-4o + an
 * OpenAI-compatible base URL is an invalid combination that can never make a
 * real request). Returns a human-readable error message, or null when the
 * combination is valid.
 *
 * Rules:
 *  - custom   requires baseUrl + model (already enforced, kept here too)
 *  - google   requires a gemini-* model; baseUrl (when set) must not point at
 *             a non-Google endpoint (OpenAI-style gateways 404 on the
 *             generateContent path)
 *  - anthropic requires a claude-* model
 *  - openai / mistral accept any model (names are not enumerable)
 *  - ollama   any model, localhost default
 */
export function validateProviderConfig(opts: {
  provider: string;
  baseUrl?: string;
  model?: string;
}): string | null {
  const provider = opts.provider;
  const model = (opts.model || '').trim();
  const baseUrl = (opts.baseUrl || '').trim();

  if (provider === 'custom') {
    if (!baseUrl) return 'Custom provider requires a base URL.';
    if (!model) return 'Custom provider requires a model.';
    return null;
  }

  if (!DEFAULT_BASE_URLS[provider]) {
    return `Unknown provider: ${provider}`;
  }

  if (provider === 'google') {
    if (model && !model.toLowerCase().startsWith(GOOGLE_GEMINI_PREFIX)) {
      return `Google provider requires a Gemini model (e.g. gemini-2.5-flash). Configured model "${model}" is incompatible.`;
    }
    if (baseUrl) {
      let host: string;
      let pathname: string;
      try {
        const u = new URL(baseUrl);
        host = u.hostname.toLowerCase();
        pathname = u.pathname.replace(/\/+$/, '');
      } catch {
        return `Invalid base URL for Google provider: ${baseUrl}`;
      }
      const googleHost = new URL(DEFAULT_BASE_URLS.google).hostname;
      if (host !== googleHost) {
        return `Google provider must use the Google Gemini endpoint (${DEFAULT_BASE_URLS.google}). "${baseUrl}" is an OpenAI-compatible or foreign endpoint — use the Custom provider for gateways.`;
      }
      // The google branch calls the NATIVE generateContent REST API at
      // {baseUrl}/v1/models/{model}:generateContent with x-goog-api-key.
      // Only native roots (empty, /v1, /v1beta) are compatible. Paths like
      // /v1beta/openai are Google's OpenAI-COMPATIBLE gateway (different
      // protocol: chat/completions + Bearer) — combining it with the google
      // provider produces a URL that always 404s (DS-P1-1). Such gateways
      // belong to the `custom` provider.
      if (pathname !== '' && pathname !== '/v1' && pathname !== '/v1beta') {
        return `Google provider must use the native Gemini endpoint (${DEFAULT_BASE_URLS.google}). "${baseUrl}" is an OpenAI-compatible gateway — use the Custom provider for OpenAI-compatible base URLs.`;
      }
    }
  }

  if (provider === 'anthropic' && model && !model.toLowerCase().startsWith('claude')) {
    return `Anthropic provider requires a Claude model (e.g. claude-3-5-haiku). Configured model "${model}" is incompatible.`;
  }

  return null;
}

// ── Image Input Types ────────────────────────────────────────────────────────

export interface ImageInput {
  /** 'url' for publicly accessible HTTP URLs, 'base64' for local file data */
  type: 'url' | 'base64';
  /** HTTP URL when type is 'url' */
  url?: string;
  /** Base64 encoded image data (without data: prefix) when type is 'base64' */
  base64?: string;
  /** MIME type e.g. 'image/png' — required for base64 */
  mimeType?: string;
}

// ── Settings Loader ─────────────────────────────────────────────────────────
// Returns either a resolved provider config or a SAFE diagnostic error code
// (never the API key). Codes:
//   AI_PROVIDER_NOT_CONFIGURED — no provider selected
//   AI_KEY_MISSING             — provider requires a key but none stored
//   AI_KEY_DECRYPT_FAILED      — stored envelope could not be decrypted
//   AI_INVALID_BASE_URL        — custom provider has no base URL
//   AI_MODEL_MISSING           — custom provider has no model
//   AI_UNKNOWN_PROVIDER        — provider name not recognized

type SettingsError =
  | 'AI_PROVIDER_NOT_CONFIGURED'
  | 'AI_KEY_MISSING'
  | 'AI_KEY_DECRYPT_FAILED'
  | 'AI_INVALID_BASE_URL'
  | 'AI_MODEL_MISSING'
  | 'AI_UNKNOWN_PROVIDER'
  | 'AI_CONFIG_INCOMPATIBLE';

type SettingsResult =
  | { settings: { provider: string; apiKey: string; baseUrl: string; model: string } }
  | { error: SettingsError };

async function getSettings(): Promise<SettingsResult> {
  const [providerSetting, apiKeySetting, baseUrlSetting, modelSetting] =
    await Promise.all([
      db.systemSetting.findUnique({ where: { key: 'ai_provider' } }),
      db.systemSetting.findUnique({ where: { key: 'ai_api_key' } }),
      db.systemSetting.findUnique({ where: { key: 'ai_base_url' } }),
      db.systemSetting.findUnique({ where: { key: 'ai_model' } }),
    ]);

  const provider = providerSetting?.value || '';
  if (!provider) return { error: 'AI_PROVIDER_NOT_CONFIGURED' };

  // Decrypt the stored API key (encrypted at rest since Phase 3). Legacy
  // plaintext values from older installs are upgraded to encrypted in place;
  // legacy JWT_SECRET-derived envelopes are migrated to the dedicated key.
  let apiKey = apiKeySetting?.value || '';
  if (apiKey) {
    if (isEncryptedSecret(apiKey)) {
      const { plaintext, migrated } = decryptSecretWithMeta(apiKey);
      if (!plaintext && !migrated) {
        return { error: 'AI_KEY_DECRYPT_FAILED' };
      }
      apiKey = plaintext;
      if (migrated) {
        try {
          await db.systemSetting.update({
            where: { id: apiKeySetting!.id },
            data: { value: encryptSecret(apiKey) },
          });
        } catch {
          // Non-fatal: continue with the plaintext for this request.
        }
      }
    } else if (provider !== 'ollama') {
      // Legacy plaintext — upgrade to encryption at rest.
      const upgraded = encryptSecret(apiKey);
      try {
        await db.systemSetting.update({
          where: { id: apiKeySetting!.id },
          data: { value: upgraded },
        });
      } catch {
        // Non-fatal: continue with the plaintext for this request.
      }
    }
  }

  // Custom provider requires baseUrl and model to be set
  if (provider === 'custom') {
    const baseUrl = baseUrlSetting?.value || '';
    const model = modelSetting?.value || '';
    if (!baseUrl) return { error: 'AI_INVALID_BASE_URL' };
    if (!model) return { error: 'AI_MODEL_MISSING' };
    return { settings: { provider, apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), model } };
  }

  // Known providers
  if (!DEFAULT_BASE_URLS[provider]) return { error: 'AI_UNKNOWN_PROVIDER' };

  if (provider !== 'ollama' && !apiKey) return { error: 'AI_KEY_MISSING' };

  const baseUrl = (baseUrlSetting?.value || DEFAULT_BASE_URLS[provider]).replace(/\/+$/, '');
  const model = modelSetting?.value || DEFAULT_MODELS[provider];

  // Provider-aware compatibility check (e.g. google + gpt-4o or google + an
  // OpenAI-compatible gateway is invalid and would silently 404). Fail closed
  // with a diagnostic code so callers fall back to rules — never fake AI.
  const configError = validateProviderConfig({ provider, baseUrl, model });
  if (configError) return { error: 'AI_CONFIG_INCOMPATIBLE' };

  return { settings: { provider, apiKey, baseUrl, model } };
}

// ── Response Extractors (Text-only) ─────────────────────────────────────────

function extractOpenAIResponse(data: unknown): string | null {
  const d = data as Record<string, unknown>;
  const choices = d.choices as Array<Record<string, unknown>> | undefined;
  if (choices && choices.length > 0) {
    const msg = choices[0].message as Record<string, unknown> | undefined;
    return (msg?.content as string) || null;
  }
  return null;
}

function extractAnthropicResponse(data: unknown): string | null {
  const d = data as Record<string, unknown>;
  const content = d.content as Array<Record<string, unknown>> | undefined;
  if (content && content.length > 0) {
    return (content[0].text as string) || null;
  }
  return null;
}

function extractGoogleResponse(data: unknown): string | null {
  const d = data as Record<string, unknown>;
  const candidates = d.candidates as Array<Record<string, unknown>> | undefined;
  if (candidates && candidates.length > 0) {
    const parts = (candidates[0].content as Record<string, unknown>)?.parts as
      | Array<Record<string, unknown>>
      | undefined;
    if (parts && parts.length > 0) {
      return (parts[0].text as string) || null;
    }
  }
  return null;
}

function extractOllamaResponse(data: unknown): string | null {
  const d = data as Record<string, unknown>;
  const msg = d.message as Record<string, unknown> | undefined;
  return (msg?.content as string) || null;
}

// ── Helper: is OpenAI-compatible? ──────────────────────────────────────────

function isOpenAICompatible(provider: string): boolean {
  return provider === 'openai' || provider === 'mistral' || provider === 'custom';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  callAIProvider — Text-only generation (no images)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProviderTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface AIProviderResult {
  text: string | null;
  provider: string;
  model: string;
  /** SAFE diagnostic code — never includes the API key or any secret. */
  error?: string;
  /** Provider-reported token usage (Phase 5 metering). Absent when the provider reports none. */
  usage?: ProviderTokenUsage | null;
}

/**
 * Extract provider-reported token counts from a raw provider response.
 * Returns null when the provider did not report usage for this call.
 * Never fabricates counts: totals are summed only from reported parts.
 */
function parseProviderUsage(provider: string, data: unknown): ProviderTokenUsage | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;

  if (isOpenAICompatible(provider)) {
    const u = d.usage as Record<string, unknown> | undefined;
    if (!u || typeof u !== 'object') return null;
    const input = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null;
    const output = typeof u.completion_tokens === 'number' ? u.completion_tokens : null;
    const total = typeof u.total_tokens === 'number' ? u.total_tokens : input !== null && output !== null ? input + output : null;
    if (input === null && output === null && total === null) return null;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  }

  if (provider === 'anthropic') {
    const u = d.usage as Record<string, unknown> | undefined;
    if (!u || typeof u !== 'object') return null;
    const input = typeof u.input_tokens === 'number' ? u.input_tokens : null;
    const output = typeof u.output_tokens === 'number' ? u.output_tokens : null;
    const total = input !== null && output !== null ? input + output : null;
    if (input === null && output === null) return null;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  }

  if (provider === 'google') {
    const u = d.usageMetadata as Record<string, unknown> | undefined;
    if (!u || typeof u !== 'object') return null;
    const input = typeof u.promptTokenCount === 'number' ? u.promptTokenCount : null;
    const output = typeof u.candidatesTokenCount === 'number' ? u.candidatesTokenCount : null;
    const total = typeof u.totalTokenCount === 'number' ? u.totalTokenCount : input !== null && output !== null ? input + output : null;
    if (input === null && output === null && total === null) return null;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  }

  if (provider === 'ollama') {
    const input = typeof d.prompt_eval_count === 'number' ? d.prompt_eval_count : null;
    const output = typeof d.eval_count === 'number' ? d.eval_count : null;
    const total = input !== null && output !== null ? input + output : null;
    if (input === null && output === null) return null;
    return { inputTokens: input, outputTokens: output, totalTokens: total };
  }

  return null;
}

export async function callAIProvider(
  systemPrompt: string,
  userPrompt: string,
  options?: { maxTokens?: number; temperature?: number }
): Promise<AIProviderResult | null> {
  try {
    const loaded = await getSettings();
    if ('error' in loaded) {
      return { text: null, provider: '', model: '', error: loaded.error };
    }

    const { provider, apiKey, baseUrl, model } = loaded.settings;
    let responseText: string | null = null;
    const maxTokens = options?.maxTokens ?? 500;
    const temperature = options?.temperature ?? 0.3;

    const fail = (error: string) => ({ text: null as string | null, provider, model, error });
    let usage: ProviderTokenUsage | null = null;

    if (isOpenAICompatible(provider)) {
      const res = await providerFetch(apiEndpoint(baseUrl, '/v1/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature,
          max_tokens: maxTokens,
        }),
      });
      if (!res) {
        console.error(`AI (${provider}) request failed or target rejected as unsafe`);
        return fail('AI_REQUEST_FAILED');
      }
      if (!res.ok) {
        console.error(`AI (${provider}) API error: ${res.status}`);
        return fail(`AI_HTTP_${res.status}`);
      }
      const data = await res.json();
      responseText = extractOpenAIResponse(data);
      usage = parseProviderUsage(provider, data);
    } else if (provider === 'anthropic') {
      const res = await providerFetch(apiEndpoint(baseUrl, '/v1/messages'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          max_tokens: maxTokens,
        }),
      });
      if (!res) {
        console.error('AI (anthropic) request failed or target rejected as unsafe');
        return fail('AI_REQUEST_FAILED');
      }
      if (!res.ok) {
        console.error(`AI (anthropic) API error: ${res.status}`);
        return fail(`AI_HTTP_${res.status}`);
      }
      const data = await res.json();
      responseText = extractAnthropicResponse(data);
      usage = parseProviderUsage(provider, data);
    } else if (provider === 'google') {
      // Key travels in the x-goog-api-key header — never in the URL.
      const res = await providerFetch(
        apiEndpoint(baseUrl, `/v1/models/${model}:generateContent`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
          },
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] },
            ],
          }),
        }
      );
      if (!res) {
        console.error('AI (google) request failed or target rejected as unsafe');
        return fail('AI_REQUEST_FAILED');
      }
      if (!res.ok) {
        console.error(`AI (google) API error: ${res.status}`);
        return fail(`AI_HTTP_${res.status}`);
      }
      const data = await res.json();
      responseText = extractGoogleResponse(data);
      usage = parseProviderUsage(provider, data);
    } else if (provider === 'ollama') {
      const res = await providerFetch(
        `${baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            stream: false,
          }),
        },
        true // allow the documented localhost default
      );
      if (!res) {
        console.error('AI (ollama) request failed or target rejected as unsafe');
        return fail('AI_REQUEST_FAILED');
      }
      if (!res.ok) {
        console.error(`AI (ollama) API error: ${res.status}`);
        return fail(`AI_HTTP_${res.status}`);
      }
      const data = await res.json();
      responseText = extractOllamaResponse(data);
      usage = parseProviderUsage(provider, data);
    }

    return responseText
      ? { text: responseText, provider, model, ...(usage ? { usage } : {}) }
      : fail('AI_RESPONSE_INVALID');
  } catch (error) {
    console.error('callAIProvider error:', error);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  callAIProviderVision — Vision + Text generation (images included)
// ═══════════════════════════════════════════════════════════════════════════════

export async function callAIProviderVision(
  systemPrompt: string,
  userPrompt: string,
  image: ImageInput,
  options?: { maxTokens?: number; temperature?: number }
): Promise<AIProviderResult | null> {
  try {
    const loaded = await getSettings();
    if ('error' in loaded) {
      return { text: null, provider: '', model: '', error: loaded.error };
    }

    const { provider, apiKey, baseUrl, model } = loaded.settings;
    let responseText: string | null = null;
    const maxTokens = options?.maxTokens ?? 1000;
    const temperature = options?.temperature ?? 0.3;

    const fail = (error: string) => ({ text: null as string | null, provider, model, error });
    let usage: ProviderTokenUsage | null = null;

    // Build image reference for OpenAI-compatible providers
    function openAIImageUrl(): string {
      if (image.type === 'url' && image.url) return image.url;
      if (image.type === 'base64' && image.base64) {
        return `data:${image.mimeType || 'image/png'};base64,${image.base64}`;
      }
      return '';
    }

    if (isOpenAICompatible(provider)) {
      const imgUrl = openAIImageUrl();
      if (!imgUrl) return fail('AI_IMAGE_INVALID');

      const res = await providerFetch(apiEndpoint(baseUrl, '/v1/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: [
                { type: 'text', text: userPrompt },
                { type: 'image_url', image_url: { url: imgUrl } },
              ],
            },
          ],
          temperature,
          max_tokens: maxTokens,
        }),
      });
      if (!res) {
        console.error(`AI Vision (${provider}) request failed or target rejected as unsafe`);
        return fail('AI_REQUEST_FAILED');
      }
      if (!res.ok) {
        console.error(`AI Vision (${provider}) API error: ${res.status}`);
        return fail(`AI_HTTP_${res.status}`);
      }
      const data = await res.json();
      responseText = extractOpenAIResponse(data);
      usage = parseProviderUsage(provider, data);
    } else if (provider === 'anthropic') {
      // Anthropic requires base64
      let base64Data = image.base64;
      let mimeType = image.mimeType || 'image/png';

      if (image.type === 'url' && image.url) {
        // Fetch the image and convert to base64 (SSRF-checked)
        try {
          const imgRes = await providerFetch(image.url);
          if (!imgRes || !imgRes.ok) {
            console.error(`Failed to fetch image for Anthropic: ${imgRes?.status ?? 'rejected'}`);
            return fail('AI_IMAGE_FETCH_FAILED');
          }
          const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
          const contentType = imgRes.headers.get('content-type') || 'image/png';
          mimeType = contentType;
          base64Data = imgBuffer.toString('base64');
        } catch {
          console.error('Failed to fetch image for Anthropic vision');
          return fail('AI_IMAGE_FETCH_FAILED');
        }
      }

      if (!base64Data) return fail('AI_IMAGE_INVALID');

      const res = await providerFetch(apiEndpoint(baseUrl, '/v1/messages'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mimeType,
                    data: base64Data,
                  },
                },
                { type: 'text', text: userPrompt },
              ],
            },
          ],
          max_tokens: maxTokens,
        }),
      });
      if (!res) {
        console.error('AI Vision (anthropic) request failed or target rejected as unsafe');
        return fail('AI_REQUEST_FAILED');
      }
      if (!res.ok) {
        console.error(`AI Vision (anthropic) API error: ${res.status}`);
        return fail(`AI_HTTP_${res.status}`);
      }
      const data = await res.json();
      responseText = extractAnthropicResponse(data);
      usage = parseProviderUsage(provider, data);
    } else if (provider === 'google') {
      // Google requires inlineData (base64)
      let base64Data = image.base64;
      let mimeType = image.mimeType || 'image/png';

      if (image.type === 'url' && image.url) {
        try {
          const imgRes = await providerFetch(image.url);
          if (!imgRes || !imgRes.ok) return fail('AI_IMAGE_FETCH_FAILED');
          const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
          mimeType = imgRes.headers.get('content-type') || 'image/png';
          base64Data = imgBuffer.toString('base64');
        } catch {
          return fail('AI_IMAGE_FETCH_FAILED');
        }
      }

      if (!base64Data) return fail('AI_IMAGE_INVALID');
      const res = await providerFetch(
        apiEndpoint(baseUrl, `/v1/models/${model}:generateContent`),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [
                  { text: `${systemPrompt}\n\n${userPrompt}` },
                  { inlineData: { mimeType, data: base64Data } },
                ],
              },
            ],
          }),
        }
      );
      if (!res) {
        console.error('AI Vision (google) request failed or target rejected as unsafe');
        return fail('AI_REQUEST_FAILED');
      }
      if (!res.ok) {
        console.error(`AI Vision (google) API error: ${res.status}`);
        return fail(`AI_HTTP_${res.status}`);
      }
      const data = await res.json();
      responseText = extractGoogleResponse(data);
      usage = parseProviderUsage(provider, data);
    } else if (provider === 'ollama') {
      // Ollama: images array (base64)
      let base64Data = image.base64;

      if (image.type === 'url' && image.url) {
        try {
          const imgRes = await providerFetch(image.url);
          if (!imgRes || !imgRes.ok) return fail('AI_IMAGE_FETCH_FAILED');
          const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
          base64Data = imgBuffer.toString('base64');
        } catch {
          return fail('AI_IMAGE_FETCH_FAILED');
        }
      }

      if (!base64Data) return fail('AI_IMAGE_INVALID');

      const res = await providerFetch(
        `${baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: userPrompt,
                images: [base64Data],
              },
            ],
            stream: false,
          }),
        },
        true // allow the documented localhost default
      );
      if (!res) {
        console.error('AI Vision (ollama) request failed or target rejected as unsafe');
        return fail('AI_REQUEST_FAILED');
      }
      if (!res.ok) {
        console.error(`AI Vision (ollama) API error: ${res.status}`);
        return fail(`AI_HTTP_${res.status}`);
      }
      const data = await res.json();
      responseText = extractOllamaResponse(data);
      usage = parseProviderUsage(provider, data);
    }

    return responseText
      ? { text: responseText, provider, model, ...(usage ? { usage } : {}) }
      : fail('AI_RESPONSE_INVALID');
  } catch (error) {
    console.error('callAIProviderVision error:', error);
    return null;
  }
}


