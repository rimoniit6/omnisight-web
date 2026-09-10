'use client';

import { ArrowLeft, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/lib/store';
import { OrganizationProvisionFlow } from './organization-provision-flow';

/**
 * Control Center — Provision Organization.
 *
 * Full create-organization provisioning UI inside the SPA shell: package +
 * org admin + temporary password (first-login badge). All authorization and
 * provisioning live in POST /api/admin/organizations/create (super_admin,
 * DB-verified); this page is pure presentation + navigation.
 */
export function SuperAdminCreateOrganizationPage() {
  const { setCurrentPage, setPageContext, setPageContextLabel } = useAppStore();

  const backToOrganizations = () => {
    setCurrentPage('super-admin-organizations');
  };

  const openOrg = (org: { id: string; name: string }) => {
    setCurrentPage('super-admin-organization-detail');
    setPageContext(org.id);
    setPageContextLabel(org.name);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <Button
            variant="ghost"
            size="sm"
            className="mb-2 h-8 px-2 text-xs text-muted-foreground"
            onClick={backToOrganizations}
          >
            <ArrowLeft className="w-3.5 h-3.5 mr-1" />
            Back to Organizations
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">Provision Organization</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Create a complete workspace with a package, org admin account,
            subscription, and credentials — ready to sign in.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <UserPlus className="w-5 h-5 text-primary" />
          </div>
        </div>
      </div>

      {/* Full-width enterprise form layout: two-column on desktop so the
          provisioning flow uses the available viewport instead of a narrow
          centered strip. */}
      <div className="w-full max-w-none">
        <OrganizationProvisionFlow onViewOrg={openOrg} />
      </div>
    </div>
  );
}
