'use client';

import { UserManagement } from '@/components/users/user-management';

/**
 * Users / Members page — primary organization section for user management.
 *
 * This replaces the old Settings → User Management location.
 * User management is an organization-administration capability, not a
 * settings subsection.
 */
export function UsersPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Users &amp; Members</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage organization members, roles, and access permissions.
        </p>
      </div>
      <UserManagement />
    </div>
  );
}
