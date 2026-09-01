/**
 * OmniSight — Centralized Permission Definitions (RBAC)
 *
 * SINGLE SOURCE OF TRUTH for all permission checks. API routes, frontend
 * navigation, and UI components MUST reference these definitions instead of
 * scattering hardcoded role checks.
 *
 * Roles:
 *   super_admin  — Platform-level authority (AppUser.role)
 *   org_admin    — Organization-level admin (OrganizationMembership.role)
 *   manager      — Organization-level operational (OrganizationMembership.role)
 *   viewer       — Organization-level read-only (OrganizationMembership.role)
 */

// ─── Permission Types ──────────────────────────────────────────────────────

export type PlatformPermission =
  | 'platform.organizations.read'
  | 'platform.organizations.create'
  | 'platform.organizations.update'
  | 'platform.organizations.delete'
  | 'platform.settings.read'
  | 'platform.settings.update'
  | 'platform.audit.read'
  | 'platform.members.read'
  | 'platform.members.manage';

export type OrganizationPermission =
  | 'organization.read'
  | 'organization.update'
  | 'organization.settings.read'
  | 'organization.settings.update'
  | 'organization.members.read'
  | 'organization.members.create'
  | 'organization.members.update'
  | 'organization.members.delete'
  | 'employees.read'
  | 'employees.create'
  | 'employees.update'
  | 'employees.delete'
  | 'devices.read'
  | 'devices.create'
  | 'devices.update'
  | 'devices.delete'
  | 'projects.read'
  | 'projects.create'
  | 'projects.update'
  | 'projects.delete'
  | 'reports.read'
  | 'reports.create'
  | 'audit.read'
  | 'agents.read'
  | 'agents.manage'
  | 'audio.read'
  | 'audio.manage'
  | 'consent.read'
  | 'consent.manage'
  | 'policies.read'
  | 'policies.manage'
  | 'alerts.read'
  | 'alerts.manage'
  | 'anomalies.read'
  | 'anomalies.manage'
  | 'notifications.read'
  | 'notifications.manage'
  | 'dashboard.read'
  | 'analytics.read'
  | 'insights.read'
  | 'sentiment.read';

export type Permission = PlatformPermission | OrganizationPermission;

// ─── Role → Permission Mapping ──────────────────────────────────────────────

const PLATFORM_PERMISSIONS: PlatformPermission[] = [
  'platform.organizations.read',
  'platform.organizations.create',
  'platform.organizations.update',
  'platform.organizations.delete',
  'platform.settings.read',
  'platform.settings.update',
  'platform.audit.read',
  'platform.members.read',
  'platform.members.manage',
];

const ORG_ADMIN_PERMISSIONS: OrganizationPermission[] = [
  'organization.read',
  'organization.update',
  'organization.settings.read',
  'organization.settings.update',
  'organization.members.read',
  'organization.members.create',
  'organization.members.update',
  'organization.members.delete',
  'employees.read',
  'employees.create',
  'employees.update',
  'employees.delete',
  'devices.read',
  'devices.create',
  'devices.update',
  'devices.delete',
  'projects.read',
  'projects.create',
  'projects.update',
  'projects.delete',
  'reports.read',
  'reports.create',
  'audit.read',
  'agents.read',
  'agents.manage',
  'audio.read',
  'audio.manage',
  'consent.read',
  'consent.manage',
  'policies.read',
  'policies.manage',
  'alerts.read',
  'alerts.manage',
  'anomalies.read',
  'anomalies.manage',
  'notifications.read',
  'notifications.manage',
  'dashboard.read',
  'analytics.read',
  'insights.read',
  'sentiment.read',
];

const MANAGER_PERMISSIONS: OrganizationPermission[] = [
  'organization.read',
  'organization.settings.read',
  'employees.read',
  'employees.create',
  'employees.update',
  'devices.read',
  'projects.read',
  'projects.create',
  'projects.update',
  'reports.read',
  'audit.read',
  'agents.read',
  'audio.read',
  'consent.read',
  'policies.read',
  'alerts.read',
  'anomalies.read',
  'notifications.read',
  'dashboard.read',
  'analytics.read',
  'insights.read',
  'sentiment.read',
];

const VIEWER_PERMISSIONS: OrganizationPermission[] = [
  'organization.read',
  'organization.settings.read',
  'employees.read',
  'devices.read',
  'projects.read',
  'reports.read',
  'agents.read',
  'audio.read',
  'consent.read',
  'policies.read',
  'alerts.read',
  'notifications.read',
  'dashboard.read',
  'analytics.read',
  'insights.read',
  'sentiment.read',
];

// ─── Permission Set by Role ─────────────────────────────────────────────────

export const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  super_admin: [...PLATFORM_PERMISSIONS, ...ORG_ADMIN_PERMISSIONS],
  org_admin: ORG_ADMIN_PERMISSIONS,
  manager: MANAGER_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};

// ─── Permission Helpers ─────────────────────────────────────────────────────

/**
 * Check if a role has a specific permission.
 * Platform permissions are only granted to super_admin.
 * Organization permissions are granted based on the role hierarchy.
 */
export function hasPermission(role: string, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  return perms.includes(permission);
}

/**
 * Check if a role has ALL of the specified permissions.
 */
export function hasAllPermissions(role: string, permissions: Permission[]): boolean {
  return permissions.every((p) => hasPermission(role, p));
}

/**
 * Check if a role has ANY of the specified permissions.
 */
export function hasAnyPermission(role: string, permissions: Permission[]): boolean {
  return permissions.some((p) => hasPermission(role, p));
}

/**
 * Get all permissions for a role.
 */
export function getPermissionsForRole(role: string): Permission[] {
  return ROLE_PERMISSIONS[role] || [];
}

// ─── Role Display Labels ────────────────────────────────────────────────────

export const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  user: 'User',
  org_admin: 'Organization Admin',
  admin: 'Organization Admin',  // legacy alias
  owner: 'Organization Admin',  // legacy alias
  manager: 'Manager',
  viewer: 'Viewer',
};

/**
 * Get human-readable label for a role.
 * Returns 'Unknown Role' for unrecognized roles instead of falling back to Super Admin.
 */
export function getRoleLabelFromPermissions(role: string): string {
  return ROLE_LABELS[role] || 'Unknown Role';
}

// ─── Authorization Error Format ─────────────────────────────────────────────

export interface AuthorizationError {
  error: string;
  code: string;
  message: string;
  requiredPermission?: string;
  requiredRole?: string;
}

/**
 * Create a standardized 403 Forbidden response.
 */
export function forbiddenError(
  message: string,
  opts: { permission?: Permission; requiredRole?: string } = {}
): Response {
  const body: AuthorizationError = {
    error: 'FORBIDDEN',
    code: 'PERMISSION_DENIED',
    message,
    ...(opts.permission && { requiredPermission: opts.permission }),
    ...(opts.requiredRole && { requiredRole: opts.requiredRole }),
  };
  return new Response(JSON.stringify(body), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Create a standardized 401 Unauthorized response.
 */
export function unauthorizedError(message = 'Authentication required'): Response {
  return new Response(
    JSON.stringify({
      error: 'UNAUTHORIZED',
      code: 'AUTHENTICATION_REQUIRED',
      message,
    }),
    {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

// ─── Human-Readable Permission Messages ─────────────────────────────────────

/**
 * Get all roles that have a specific permission.
 */
export function getRolesWithPermission(permission: Permission): string[] {
  const roles: string[] = [];
  for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
    if (perms.includes(permission)) {
      roles.push(role);
    }
  }
  return roles;
}

/**
 * Map a permission + role to a user-friendly toast message.
 * Used by the frontend when a 403 is received.
 */
export function getPermissionDeniedMessage(
  permission: Permission,
  userRole: string
): { title: string; message: string } {
  const allowedRoles = getRolesWithPermission(permission);
  const allowedRoleLabels = allowedRoles.map(getRoleLabelFromPermissions).join(', ');
  const userRoleLabel = getRoleLabelFromPermissions(userRole);

  // Platform settings
  if (permission === 'platform.settings.update') {
    return {
      title: 'Permission Denied',
      message: `Your role: ${userRoleLabel}\nRequired: Super Admin\nAction: Manage Platform Settings`,
    };
  }
  if (permission === 'platform.settings.read') {
    return {
      title: 'Permission Denied',
      message: `Your role: ${userRoleLabel}\nRequired: Super Admin\nAction: View Platform Settings`,
    };
  }

  // Organization settings
  if (permission === 'organization.settings.update') {
    if (userRole === 'manager') {
      return {
        title: 'Permission Denied',
        message: `Your role: ${userRoleLabel}\nRequired: Organization Admin\nAction: Manage Organization Settings`,
      };
    }
    if (userRole === 'viewer') {
      return {
        title: 'Permission Denied',
        message: `Your role: ${userRoleLabel}\nRequired: Organization Admin\nAction: Manage Organization Settings`,
      };
    }
    return {
      title: 'Permission Denied',
      message: `Your role: ${userRoleLabel}\nRequired: Organization Admin\nAction: Manage Organization Settings`,
    };
  }

  // Members management
  if (permission === 'organization.members.create' || permission === 'organization.members.update' || permission === 'organization.members.delete') {
    return {
      title: 'Permission Denied',
      message: `Your role: ${userRoleLabel}\nRequired: Organization Admin\nAction: Manage Organization Memberships`,
    };
  }

  // Employee mutations
  if (permission === 'employees.create' || permission === 'employees.update' || permission === 'employees.delete') {
    if (userRole === 'viewer') {
      return {
        title: 'Permission Denied',
        message: `Your role: ${userRoleLabel}\nRequired: Organization Admin or Manager\nAction: Manage Employee Records`,
      };
    }
    return {
      title: 'Permission Denied',
      message: `Your role: ${userRoleLabel}\nRequired: Organization Admin or Manager\nAction: Manage Employee Records`,
    };
  }

  // Device management
  if (permission === 'devices.create' || permission === 'devices.update' || permission === 'devices.delete') {
    return {
      title: 'Permission Denied',
      message: `Your role: ${userRoleLabel}\nRequired: Organization Admin\nAction: Manage Devices`,
    };
  }

  // Project management
  if (permission === 'projects.create' || permission === 'projects.update' || permission === 'projects.delete') {
    return {
      title: 'Permission Denied',
      message: `Your role: ${userRoleLabel}\nRequired: Organization Admin or Manager\nAction: Manage Projects`,
    };
  }

  // Super Admin APIs
  if (permission.startsWith('platform.')) {
    return {
      title: 'Permission Denied',
      message: `Your role: ${userRoleLabel}\nRequired: Super Admin\nAction: Platform Administration`,
    };
  }

  // Generic fallback
  return {
    title: 'Permission Denied',
    message: `Your role: ${userRoleLabel}\nRequired: ${allowedRoleLabels || 'Unknown'}\nAction: ${permission.replace(/\./g, ' ').replace(/_/g, ' ')}`,
  };
}

// ─── Convenience Re-exports ─────────────────────────────────────────────────
// Re-export role helpers from auth.ts for convenience, so the permissions
// module is a single import point for authorization logic.

export { getRoleLabel } from '@/lib/auth';
export { hasRolePermission } from '@/lib/auth';
