"use client";

import { useToast } from '@/hooks/use-toast';
import { getPermissionDeniedMessage, getRoleLabelFromPermissions } from '@/lib/permissions';

export interface AuthorizationErrorResponse {
  error: string;
  code: string;
  message: string;
  requiredPermission?: string;
  requiredRoles?: string[];
  allowedRoleLabels?: string;
  userRole?: string;
  userRoleLabel?: string;
}

/**
 * Check if a response is a structured authorization error.
 */
export function isAuthorizationError(error: unknown): error is AuthorizationErrorResponse {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as any).code === 'INSUFFICIENT_PERMISSION'
  );
}

/**
 * Parse an error from a fetch response and return a structured authorization error if available.
 */
export async function parseAuthorizationError(response: Response): Promise<AuthorizationErrorResponse | null> {
  if (response.status !== 403) return null;

  try {
    const data = await response.json();
    if (isAuthorizationError(data)) {
      return data;
    }
    // Legacy format: { error: "Insufficient permissions" }
    if (data.error && typeof data.error === 'string') {
      return {
        error: data.error,
        code: 'INSUFFICIENT_PERMISSION',
        message: data.error,
      };
    }
  } catch {
    // Failed to parse JSON
  }
  return null;
}

/**
 * Get the current user's effective role from the auth store.
 * This should be called in a client component context.
 */
export function getCurrentUserRole(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    // The auth store is in zustand, we can't directly access it here
    // This will be passed from the component
    return null;
  } catch {
    return null;
  }
}

/**
 * Generate a human-readable permission denied message.
 * Uses the centralized permission definitions.
 */
export function getPermissionDeniedToast(
  authError: AuthorizationErrorResponse,
  userRole?: string
): { title: string; description: string; variant: 'destructive' } {
  const permission = authError.requiredPermission;
  const effectiveRole = userRole || authError.userRole || 'Unknown';
  const userRoleLabel = getRoleLabelFromPermissions(effectiveRole);

  if (permission) {
    const { title, message } = getPermissionDeniedMessage(permission as any, effectiveRole);
    return { title, description: message, variant: 'destructive' };
  }

  // Fallback for legacy errors
  return {
    title: 'Permission Denied',
    description: `Your role: ${userRoleLabel}\nRequired: Unknown\nAction: Unknown`,
    variant: 'destructive',
  };
}

/**
 * Hook for handling API errors with proper authorization error display.
 * Usage:
 *   const { handleApiError } = useApiErrorHandler();
 *   try {
 *     const res = await fetch('/api/...');
 *     if (!res.ok) {
 *       const authError = await parseAuthorizationError(res);
 *       if (authError) handleApiError(authError);
 *       else throw new Error('Request failed');
 *     }
 *   } catch (e) {
 *     handleApiError(e);
 *   }
 */
export function useApiErrorHandler() {
  const { toast } = useToast();

  return {
    handleApiError: (error: unknown, userRole?: string) => {
      if (isAuthorizationError(error)) {
        const toastOptions = getPermissionDeniedToast(error, userRole);
        toast(toastOptions);
        return;
      }

      // Handle other error types
      if (error instanceof Response) {
        error.text().then((text) => {
          try {
            const data = JSON.parse(text);
            if (isAuthorizationError(data)) {
              const toastOptions = getPermissionDeniedToast(data, userRole);
              toast(toastOptions);
              return;
            }
          } catch {
            // Not JSON
          }
        });
        toast({ title: 'Request failed', description: 'An unexpected error occurred', variant: 'destructive' });
        return;
      }

      if (error instanceof Error) {
        toast({ title: 'Error', description: error.message, variant: 'destructive' });
        return;
      }

      toast({ title: 'Error', description: 'An unexpected error occurred', variant: 'destructive' });
    },

    parseAuthorizationError,
    isAuthorizationError,
    getPermissionDeniedToast,
  };
}

/**
 * Wrapper for fetch that automatically handles authorization errors.
 * Usage:
 *   const data = await apiFetch('/api/...');
 */
export async function apiFetch<T>(
  url: string,
  options?: RequestInit,
  userRole?: string
): Promise<T> {
  const response = await fetch(url, options);

  if (!response.ok) {
    const authError = await parseAuthorizationError(response);
    if (authError) {
      // Throw a special error that can be caught by the component
      const error = new Error('Authorization failed') as Error & { authError: AuthorizationErrorResponse };
      error.authError = authError;
      throw error;
    }

    // For other errors, try to get the error message
    let message = `Request failed with status ${response.status}`;
    try {
      const data = await response.json();
      if (data.error) message = data.error;
    } catch {
      // Ignore JSON parse errors
    }
    throw new Error(message);
  }

  return response.json();
}