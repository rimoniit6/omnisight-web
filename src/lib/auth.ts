// OmniSight JWT Authentication Utilities
// Core auth module: signJWT, verifyJWT, hashPassword, verifyPassword, extractToken

import bcrypt from 'bcryptjs';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// ─── JWT Payload ───────────────────────────────────────────────────────────

export interface JWTPayload {
  userId: string;
  email: string;
  role: string;
  organizationId?: string;
  // The organization the user is actively working in (multi-org support).
  // Server-authoritative: set via POST /api/me/organization/switch after
  // verifying membership. Falls back to organizationId for single-org users.
  activeOrganizationId?: string;
  // Server-authoritative web session (S-04). Login/refresh always embed the
  // session id; authenticateRequest/proxy re-validate the row so logout,
  // force-logout, account disable, and password change can revoke a live
  // session. Tokens WITHOUT a sessionId are legacy stateless tokens — they
  // stay valid until natural expiry for backward compatibility.
  sessionId?: string;
  iat?: number;
  exp?: number;
}

// ─── Config from env ────────────────────────────────────────────────────────

/** Patterns that match known placeholder / default secret values. */
const PLACEHOLDER_PATTERNS = [
  /^replace_with/i,
  /^change_me/i,
  /^your_secret/i,
  /^your_/i,
  /^example/i,
  /^default/i,
  /^secret$/i,
  /^changeme/i,
  /^password$/i,
  /^admin/i,
  /^test$/i,
  /^dev$/i,
  /^localhost/i,
  /^placeholder/i,
  /^todo/i,
  /^fixme/i,
  /^xxx/i,
];

/**
 * Assert that a secret is not a known placeholder value.
 * Throws a descriptive error if the secret matches a placeholder pattern.
 * Never logs or exposes the actual secret value.
 */
export function assertProductionSecret(
  value: string,
  name: string,
  minLength = 16,
): void {
  if (!value) {
    throw new Error(`${name} must be set in the environment`);
  }
  if (value.length < minLength) {
    throw new Error(`${name} must be at least ${minLength} characters`);
  }
  for (const pattern of PLACEHOLDER_PATTERNS) {
    if (pattern.test(value)) {
      throw new Error(
        `${name} contains a known placeholder value. ` +
        'Generate a cryptographically random secret and set it in your environment.'
      );
    }
  }
}

function getJWTSecret(): string {
  const secret = process.env.JWT_SECRET;
  assertProductionSecret(secret || '', 'JWT_SECRET', 16);
  return secret!;
}

function getJWTExpiresIn(): string {
  return process.env.JWT_EXPIRES_IN || '7d';
}

// ─── Simple JWT Implementation (no external dependency) ─────────────────────
// Uses base64url encoding with HMAC-SHA256 signature

function base64urlEncode(data: string): string {
  return Buffer.from(data)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str: string): string {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf-8');
}

async function hmacSHA256(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  return Buffer.from(signature).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function verifyHMACSHA256(message: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(message);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // Convert base64url signature back to Uint8Array
  let s = signature.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const sigData = Buffer.from(s, 'base64');

  return crypto.subtle.verify('HMAC', cryptoKey, sigData, msgData);
}

function parseExpiresIn(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) return 7 * 24 * 60 * 60; // default 7 days

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 60 * 60;
    case 'd': return value * 24 * 60 * 60;
    default: return 7 * 24 * 60 * 60;
  }
}

/**
 * Effective web-JWT lifetime in seconds (from JWT_EXPIRES_IN, default 7d).
 * The server-side UserSession row expires in lockstep so the two never
 * disagree about when a session dies.
 */
export function jwtLifetimeSeconds(): number {
  return parseExpiresIn(getJWTExpiresIn());
}

// ─── Session Cookie ─────────────────────────────────────────────────────────

export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'worklens_token';

/**
 * Set the httpOnly session cookie on a response.
 * The cookie mirrors the JWT so that same-origin API calls (including plain
 * `fetch()` calls in the UI) are authenticated without JavaScript access.
 */
export function setSessionCookie(response: NextResponse, token: string, maxAgeSeconds: number): NextResponse {
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  });
  return response;
}

/**
 * Clear the session cookie (logout).
 */
export function clearSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
  return response;
}

// ─── Public Functions ───────────────────────────────────────────────────────

/**
 * Sign a JWT token with the given payload
 */
export async function signJWT(payload: Omit<JWTPayload, 'iat' | 'exp'>): Promise<string> {
  const secret = getJWTSecret();
  const expiresIn = getJWTExpiresIn();
  const expiresSeconds = parseExpiresIn(expiresIn);
  const now = Math.floor(Date.now() / 1000);

  const fullPayload: JWTPayload = {
    ...payload,
    iat: now,
    exp: now + expiresSeconds,
  };

  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64urlEncode(JSON.stringify(fullPayload));
  const signature = await hmacSHA256(`${header}.${body}`, secret);

  return `${header}.${body}.${signature}`;
}

/**
 * Verify and decode a JWT token
 * Returns the payload if valid, null if invalid/expired
 */
export async function verifyJWT(token: string): Promise<JWTPayload | null> {
  try {
    const secret = getJWTSecret();
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, signature] = parts;

    // Verify signature
    const valid = await verifyHMACSHA256(`${header}.${body}`, signature, secret);
    if (!valid) return null;

    // Restrict algorithm to HS256 (reject alg confusion / none tokens)
    const headerObj = JSON.parse(base64urlDecode(header)) as { alg?: string };
    if (headerObj.alg && headerObj.alg !== 'HS256') return null;

    // Decode payload
    const payload = JSON.parse(base64urlDecode(body)) as JWTPayload;

    // Check expiration — reject tokens without exp entirely
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return null;

    // Reject tokens with a future iat (clock-skew allowance of 60s)
    if (payload.iat && payload.iat > now + 60) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Hash a password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

/**
 * Hash a password using bcrypt (synchronous - for seed scripts)
 */
export function hashPasswordSync(password: string): string {
  return bcrypt.hashSync(password, 12);
}

/**
 * Verify a password against a bcrypt hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Extract Bearer token from Authorization header
 */
export function extractToken(req: NextRequest): string | null {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  return parts[1];
}

/**
 * Get the JWT for a request: Authorization header first, then the
 * httpOnly session cookie. Used by route handlers that re-verify the
 * token after the middleware gate.
 */
export function getRequestToken(req: NextRequest): string | null {
  const headerToken = extractToken(req);
  if (headerToken) return headerToken;
  const cookie = req.cookies.get(SESSION_COOKIE_NAME);
  return cookie?.value || null;
}

/**
 * Check if a role has the required permission level
 * Roles hierarchy: super_admin > owner > admin > manager > viewer
 */
export function hasRolePermission(userRole: string, requiredRole: string): boolean {
  const hierarchy: Record<string, number> = {
    super_admin: 50,
    owner: 40,
    org_admin: 35,
    admin: 30,
    manager: 20,
    viewer: 10,
  };

  const userLevel = hierarchy[userRole] || 0;
  const requiredLevel = hierarchy[requiredRole] || 0;

  return userLevel >= requiredLevel;
}

/**
 * Get role display label
 */
export function getRoleLabel(role: string): string {
  const labels: Record<string, string> = {
    super_admin: 'Super Admin',
    org_admin: 'Organization Admin',
    admin: 'Admin',
    owner: 'Owner',
    manager: 'Manager',
    viewer: 'Viewer',
  };
  return labels[role] || role;
}
