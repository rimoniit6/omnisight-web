'use client';

import { useState, useEffect } from 'react';
import { useAuthStore } from '@/lib/store';
import { Building2, Check, ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';

interface Organization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  status: string;
  role: string;
  membershipId: string;
}

/**
 * Organization Switcher — allows users with multiple organization memberships
 * to switch their active organization without logging out.
 *
 * SECURITY: The switch is purely a UX mechanism. Every API/database query
 * continues to derive organization scope from authenticated server-side context.
 * The switcher calls POST /api/me/organization/switch which verifies the
 * user's ACTIVE membership before issuing a new JWT.
 */
export function OrgSwitcher() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);

  const authOrganization = useAuthStore((s) => s.organization);
  const authUser = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);

  // Don't show for super admins without org membership
  const isSuperAdmin = authUser?.role === 'super_admin';

  // Fetch user's organizations on mount
  useEffect(() => {
    if (!token) return;

    const fetchOrganizations = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/me/organizations', {
          credentials: 'same-origin',
        });
        if (res.ok) {
          const data = await res.json();
          setOrganizations(data.organizations || []);
          setActiveOrgId(data.activeOrganizationId || authOrganization?.id || null);
        }
      } catch {
        // Non-fatal — org switcher just won't appear
      } finally {
        setLoading(false);
      }
    };

    fetchOrganizations();
  }, [token, authOrganization?.id]);

  // Don't show if:
  // - No token (not authenticated)
  // - No organizations loaded
  // - Only one organization (no need to switch)
  // - Still loading
  if (!token || loading || organizations.length <= 1) {
    return null;
  }

  const activeOrg = organizations.find((o) => o.id === activeOrgId) || organizations[0];

  const handleSwitch = async (orgId: string) => {
    if (orgId === activeOrgId || switching) return;

    setSwitching(true);
    try {
      const res = await fetch('/api/me/organization/switch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        credentials: 'same-origin',
        body: JSON.stringify({ organizationId: orgId }),
      });

      if (res.ok) {
        const data = await res.json();
        setActiveOrgId(orgId);
        setOpen(false);

        // Reload the page to refresh all data from the new organization
        // This ensures no stale data from the previous organization appears
        window.location.reload();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to switch organization');
      }
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSwitching(false);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          disabled={switching}
        >
          {switching ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Building2 className="w-3.5 h-3.5" />
          )}
          <span className="hidden xl:inline max-w-[120px] truncate">
            {activeOrg?.name || 'Organization'}
          </span>
          <ChevronDown className="w-3 h-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Switch Organization
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {organizations.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onClick={() => handleSwitch(org.id)}
            disabled={switching}
            className="flex items-center gap-2"
          >
            <Building2 className="w-4 h-4 text-muted-foreground" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">{org.name}</div>
              <div className="text-xs text-muted-foreground capitalize">{org.role}</div>
            </div>
            {org.id === activeOrgId && (
              <Check className="w-4 h-4 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
