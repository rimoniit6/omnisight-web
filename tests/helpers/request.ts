import { NextRequest } from 'next/server';

/**
 * Shared test request helper for in-process route invocation.
 *
 * Next.js 16 / undici enforce the fetch spec: constructing a Request with a
 * GET/HEAD method AND a body throws `TypeError: Request with GET/HEAD method
 * cannot have body.` The old per-file helpers defaulted to GET whenever
 * `method` was omitted, so any call that supplied a `body` without an explicit
 * method crashed during test setup.
 *
 * Fixed semantics (explicit method always wins):
 *   - `body` present and `method` omitted → POST
 *   - no `body` and `method` omitted → GET (unchanged read behavior)
 *   - `method` explicitly supplied → used verbatim (caller's responsibility)
 */
export interface TestRequestOpts {
  method?: string;
  body?: unknown;
  url?: string;
  ip?: string;
  ua?: string;
}

export function req(token: string | null, opts: TestRequestOpts = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  if (opts.ua) headers['user-agent'] = opts.ua;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';

  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');

  return new NextRequest(opts.url || 'http://localhost:3000/api/test', {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}