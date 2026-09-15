#!/usr/bin/env node
// Minimal secret scanner (zero dependencies).
//
// Scans TRACKED files only (via `git ls-files`), so intentionally-ignored
// local `.env` files never produce false positives. Fails (exit 1) when a
// real-looking secret is committed to the repo:
//
//   1. Template guard: any tracked `*.example` / `*.sample` / `*.template`
//      file must carry a `CHANGE_ME_*` placeholder in every secret slot and
//      must not lose a required slot.
//   2. Generic guard: any tracked file that assigns a random-shaped, high-
//      entropy value to a sensitive variable (JWT_SECRET, ENCRYPTION_KEY,
//      *_KEY, *_TOKEN, *_PASSWORD, DATABASE_URL, ...) is flagged.
//
// Deterministic dev/test/CI fixture values (test-, ci-, 0000..., localhost,
// CHANGE_ME_, example...) are skipped by design — the repo is full of them
// and they are not secrets.
//
// Secret values are NEVER printed — findings report the variable name and
// `[REDACTED]` so CI logs stay clean.
//
// Run: node scripts/secret-scan.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const ROOT = process.cwd();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REQUIRED_TEMPLATE_KEYS = [
  'JWT_SECRET',
  'ENCRYPTION_KEY',
  'SUPER_ADMIN_PASSWORD',
  'SUPER_ADMIN_EMAIL',
];

const TEMPLATE_PLACEHOLDER_RE = /^CHANGE_ME_/;

// Sensitive first-tokens for UPPER_SNAKE env-style names.
const SENSITIVE_WORDS = [
  'JWT',
  'ENCRYPTION',
  'AUTH',
  'NEXTAUTH',
  'API',
  'ACCESS',
  'REFRESH',
  'SECRET',
  'SERVICE',
  'PRIVATE',
  'SESSION',
  'DATABASE',
  'POSTGRES',
  'DB',
  'DIRECT',
  'SUPABASE',
  'METRICS',
  'TRANSCRIPTION',
  'WHISPER',
  'SMTP',
  'RESEND',
  'DEVICE',
  'AGENT',
  'SUPER_ADMIN',
];

const NAME_RE = new RegExp(
  '^(?:' +
    SENSITIVE_WORDS.join('|') +
    ')(?:_(?:SECRETS?|KEYS?|TOKENS?|PASSWORDS?|CREDENTIALS?|URL|DSN))?$' +
    '|^[A-Z][A-Z0-9_]{1,24}_(?:API_)?(?:KEY|TOKEN|SECRET)$' +
    '|^SECRET$',
  'i',
);

// camelCase sibling names (jwtSecret, encryptionKey, superAdminPassword, ...).
const CAMEL_WORDS = [
  'jwt',
  'encryption',
  'auth',
  'nextauth',
  'api',
  'access',
  'refresh',
  'secret',
  'service',
  'private',
  'session',
  'database',
  'db',
  'direct',
  'supabase',
  'metrics',
  'transcription',
  'whisper',
  'smtp',
  'resend',
  'device',
  'agent',
  'superAdmin',
];
const CAMEL_RE = new RegExp(
  '^(?:' + CAMEL_WORDS.join('|') + ')(?:Secret|Key|Token|Password)$',
);

const ASSIGN_RE =
  /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{0,63}_?(?:SECRET|_KEY|_TOKEN|_PASSWORD|_CREDENTIAL|_CREDENTIALS|_URL)?[A-Z0-9_]*)\s*[:=]\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`|([^"'\s][^"\s]*))/g;

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

const PLACEHOLDER_MARKER_RE =
  /(^|[^a-z0-9])(change_me|changeme|example|your[-_]|sample|dummy|placeholder|replace|mock|fake|xxx+|0000+|e2e[-_]|test[-_0-9]?|ci[-_]|dev[-_0-9]?|local|localhost|127\.0\.0\.1|omnisight|generate)/i;

const DENSE_HEX_RE = /^[0-9a-fA-F]{40,64}$/;
const BASE64ISH_RE = /^[A-Za-z0-9+/_-]{24,}={0,2}$/;

const ALLOWED_EXTERNAL_HOSTS = [
  'localhost',
  '127.0.0.1',
  '::1',
  '0.0.0.0',
  'example.com',
  'www.example.com',
  'example.org',
  'example.net',
  'example.invalid',
  'example.test',
];

function uniqueCount(str) {
  return new Set(str).size;
}

function isRandomish(value) {
  if (!value || value.length < 16 || value.length > 200) return false;
  const lo = value.toLowerCase();
  if (PLACEHOLDER_MARKER_RE.test(lo)) return false;
  if (uniqueCount(value) < 4) return false;
  if (DENSE_HEX_RE.test(value)) return true;
  if (BASE64ISH_RE.test(value) && uniqueCount(value) >= 14) return true;
  if (value.length >= 32 && uniqueCount(value) / value.length >= 0.45) return true;
  return false;
}

function isExternalDbUrl(value, name) {
  const lower = name.toUpperCase();
  const isUrlish =
    /^(DATABASE|POSTGRES|DB|DIRECT).*_?URL$/.test(lower) ||
    /^(postgres(ql)?|mongodb|redis|amqp):\/\//i.test(value);
  if (!isUrlish || !/\S+@\S+/.test(value)) return false;
  let hostname = '';
  try {
    hostname = new URL(value).hostname;
  } catch {
    const m = value.match(/@([^/:#]+)/);
    hostname = m ? m[1] : '';
  }
  if (!hostname) return false;
  if (ALLOWED_EXTERNAL_HOSTS.includes(hostname)) return false;
  if (!hostname.includes('.') && !/^[\d.]+$/.test(hostname)) return false;
  return true;
}

function looksSensitive(name) {
  if (NAME_RE.test(name)) return true;
  if (name.length <= 64 && CAMEL_RE.test(name)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

const findings = [];

function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

function scanFile(relPath) {
  let abs;
  try {
    abs = join(ROOT, relPath);
    const stat = statSync(abs);
    if (stat.size === 0 || stat.size > 1024 * 1024) return;
  } catch {
    return;
  }

  let content;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    return;
  }
  if (content.includes('\u0000')) return; // binary

  const isTemplate =
    /\.(example|sample|template)$/i.test(relPath) || /\.env/i.test(basename(relPath));

  // Template guard: secret slots must be CHANGE_ME_* placeholders.
  if (isTemplate && /\.(example|sample|template)$/i.test(relPath)) {
    const lines = content.split('\n');
    for (const key of REQUIRED_TEMPLATE_KEYS) {
      const idx = lines.findIndex((l) => new RegExp(`^${key}=`).test(l));
      if (idx === -1) {
        findings.push(
          `${relPath}: MISSING required template slot ${key} (add ${key}=CHANGE_ME_...)`,
        );
        continue;
      }
      const value = lines[idx].slice(lines[idx].indexOf('=') + 1).trim();
      if (!TEMPLATE_PLACEHOLDER_RE.test(value)) {
        findings.push(
          `${relPath}:${idx + 1}: template slot ${key} must hold a CHANGE_ME_* placeholder, found [${
            isRandomish(value) ? 'real-looking value' : 'non-placeholder'
          }] \u2192 [REDACTED]`,
        );
      }
    }
  }

  // Generic guard: assignment of a random-shaped secret to a sensitive var.
  for (const m of content.matchAll(ASSIGN_RE)) {
    const name = m[1];
    if (!looksSensitive(name)) continue;
    const value = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? '').trim().replace(/;+$/, '');

    // Documentation placeholder slots: <generate with: ...>, <your-...>.
    if (/^<.+>$/.test(value)) continue;
    // JS property chain (process.env.X, CREDENTIALS.a.b, localEnv.X) - not a secret.
    if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)) continue;
    // URLs are assessed by host, not by token entropy.
    if (value.includes('://')) {
      if (isExternalDbUrl(value, name)) {
        findings.push(
          `${relPath}:${lineNumber(content, m.index)}: ${name} points to external host -> [REDACTED]`,
        );
      }
      continue;
    }

    if (isRandomish(value)) {
      findings.push(`${relPath}:${lineNumber(content, m.index)}: ${name} = [REDACTED]`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let files;
try {
  const ls = execFileSync('git', ['ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  files = ls.split(/\r?\n/).filter(Boolean);
} catch (err) {
  console.error(`secret-scan: unable to list tracked files (${err.message})`);
  process.exit(2);
}

for (const file of files) {
  try {
    scanFile(file);
  } catch {
    // ignore unreadable
  }
}

if (findings.length > 0) {
  console.error('Secret scan FAILED - commit guard:');
  for (const f of findings) console.error(`  - ${f}`);
  console.error('');
  console.error(
    'If a finding is a deliberate dev/test/CI fixture, extend the marker skip rules',
    'in scripts/secret-scan.mjs or use a CHANGE_ME_/test-/ci- value.',
  );
  process.exit(1);
}

console.log(`secret-scan: OK (${files.length} tracked files, no real-looking secrets)`);