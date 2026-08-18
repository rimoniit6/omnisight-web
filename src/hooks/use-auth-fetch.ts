'use client';

import { useCallback, useRef } from 'react';
import { redirect } from 'next/navigation';
import { useAuthStore } from '@/lib/store';

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function decodeJWTPayload(token: string): { exp?: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isTokenExpiringSoon(token: string): boolean {
  const payload = decodeJWTPayload(token);
  if (!payload || !payload.exp) return true;
  const now = Date.now() / 1000;
  const timeLeft = (payload.exp - now) * 1000;
  return timeLeft <= REFRESH_THRESHOLD_MS;
}

let refreshPromise: Promise<boolean> | null = null;

async function refreshToken(): Promise<boolean> {
  try {
    // No Authorization header: the httpOnly session cookie authenticates this
    // call (getRequestToken falls back to the cookie). Keeps the token out of
    // localStorage while allowing sliding renewal.
    const res = await fetch('/api/auth/refresh-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    });

    if (!res.ok) return false;

    const data = await res.json();
    if (data.token && data.user) {
      const state = useAuthStore.getState();
      state.login(data.token, data.user, state.organization);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

async function ensureValidToken(): Promise<string | null> {
  const token = useAuthStore.getState().token;

  // No in-memory token (fresh reload, cookie-only session): return null and
  // let authFetch fall back to the httpOnly cookie.
  if (!token) return null;

  // If token is not expiring soon, use it directly
  if (!isTokenExpiringSoon(token)) return token;

  // Deduplicate concurrent refresh calls
  if (!refreshPromise) {
    refreshPromise = refreshToken().finally(() => {
      refreshPromise = null;
    });
  }

  const refreshed = await refreshPromise;
  return refreshed ? useAuthStore.getState().token : null;
}

interface AuthFetchOptions extends RequestInit {
  skipAuth?: boolean;
}

/**
 * Custom fetch hook that wraps fetch with JWT authorization.
 *
 * - Automatically attaches the Bearer token from the Zustand auth store.
 * - Refreshes the token if it is about to expire (within 5 minutes).
 * - On a 401 response, clears the auth state so the user is redirected to login.
 *
 * Usage:
 * ```tsx
 * const authFetch = useAuthFetch();
 * const data = await authFetch('/api/auth/users');
 * ```
 */
export function useAuthFetch() {
  const logoutRef = useRef(useAuthStore.getState().logout);

  // Keep the ref in sync
  const authFetch = useCallback(
    async <T = unknown>(url: string, options: AuthFetchOptions = {}): Promise<T> => {
      const { skipAuth, ...fetchOptions } = options;

      const token = skipAuth ? useAuthStore.getState().token : await ensureValidToken();

      // No token is fine for reload sessions: the httpOnly cookie is sent
      // automatically and authenticates same-origin requests. A 401 below
      // (expired/absent cookie) triggers logout + redirect to login.
      const headers: HeadersInit = {
        ...fetchOptions.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      // Don't override Content-Type for FormData
      if (fetchOptions.body instanceof FormData) {
        // Let the browser set the Content-Type with boundary
      } else if (
        fetchOptions.method &&
        fetchOptions.method.toUpperCase() !== 'GET' &&
        fetchOptions.method.toUpperCase() !== 'HEAD'
      ) {
        (headers as Record<string, string>)['Content-Type'] =
          ((headers as Record<string, string>)['Content-Type'] as string) ||
          'application/json';
      }

      const res = await fetch(url, {
        ...fetchOptions,
        headers,
      });

      // On 401 — clear auth state and redirect
      if (res.status === 401) {
        logoutRef.current();
        // Attempt to redirect to login if not already there. redirect() (from
        // next/navigation) performs the client-side navigation; its thrown
        // NEXT_REDIRECT aborts the rest of this request.
        if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) {
          redirect('/login');
        }
        throw new Error('Authentication failed — session expired');
      }

      // Parse JSON response
      const data = (await res.json()) as T;

      if (!res.ok) {
        throw data;
      }

      return data;
    },
    [],
  );

  return authFetch;
}
