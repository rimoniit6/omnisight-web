'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/store';
import { Building2, Check, ChevronDown, Loader2, Plus, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface Organization {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  status: string;
  role: string;
  membershipId: string | null;
}

/**
 * Organization Switcher — allows users with multiple organization memberships
 * to switch their active organization without logging out.
 *
 * For Super Admin: shows ALL organizations (no membership required).
 * For normal users: shows only organizations where user has membership.
 *
 * SECURITY: The switch is purely a UX mechanism. Every API/database query
 * continues to derive organization scope from authenticated server-side context.
 * The switcher calls POST /api/me/organization/switch which verifies the
 * user's authorization before issuing a new JWT.
 */
export function OrgSwitcher() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const authOrganization = useAuthStore((s) => s.organization);
  const authUser = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);

  const isSuperAdmin = authUser?.role === 'super_admin';

  const fetchOrganizations = useCallback(async () => {
    if (!token) return;
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
  }, [token, authOrganization?.id]);

  // Fetch user's organizations on mount and when dialog opens
  useEffect(() => {
    if (!token) return;
    fetchOrganizations();
  }, [token, fetchOrganizations]);

  // Reset search when dropdown opens and focus input after animation
  useEffect(() => {
    if (!open) return;
    setSearch('');
    const id = setTimeout(() => searchInputRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, [open]);

  // Filter organizations by search
  const filtered = organizations.filter((org) =>
    org.name.toLowerCase().includes(search.toLowerCase()) ||
    org.slug.toLowerCase().includes(search.toLowerCase())
  );

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
        setActiveOrgId(data.activeOrganizationId || orgId);
        setOpen(false);

        // Re-hydrate auth state from the fresh httpOnly cookie the server just
        // set. This replaces the stale in-memory JWT with one that matches the
        // new activeOrganizationId, preventing P2-01 mismatches on subsequent
        // /api/auth/me calls.
        await useAuthStore.getState().hydrate();

        // Invalidate all organization-scoped React Query caches so they
        // refetch with the now-synchronized auth state.
        queryClient.invalidateQueries();
        toast.success(`Switched to ${data.organization?.name || 'organization'}`);
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

  const handleCreate = async () => {
    if (!createName.trim() || createLoading) return;
    setCreateLoading(true);
    try {
      const res = await fetch('/api/super-admin/organizations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        credentials: 'same-origin',
        body: JSON.stringify({ name: createName.trim() }),
      });

      if (res.ok) {
        toast.success('Organization created');
        setCreateDialogOpen(false);
        setCreateName('');
        // Refresh organization list
        await fetchOrganizations();
        queryClient.invalidateQueries();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.error || 'Failed to create organization');
      }
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setCreateLoading(false);
    }
  };

  // Don't show if:
  // - No token (not authenticated)
  // - Only one organization and not Super Admin (no need to switch)
  // - Still loading and no organizations yet
  if (!token || (!loading && organizations.length === 0)) {
    return null;
  }

  // Super Admin always sees the switcher (even with 0 or 1 orgs, for Create button)
  if (!isSuperAdmin && organizations.length <= 1) {
    return null;
  }

  return (
    <>
      <div className="relative">
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'h-8 px-2 gap-1.5 text-xs font-medium',
            activeOrg ? 'text-foreground' : 'text-muted-foreground'
          )}
          disabled={switching}
          onClick={() => setOpen(!open)}
          aria-label={`Organization: ${activeOrg?.name || 'Select organization'}`}
          aria-expanded={open}
        >
          {switching ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Building2 className="w-3.5 h-3.5" />
          )}
          <span className="hidden xl:inline max-w-[140px] truncate">
            {activeOrg?.name || 'Select Organization'}
          </span>
          <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
        </Button>

        {/* Dropdown panel */}
        {open && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 z-40"
              onClick={() => setOpen(false)}
            />

            {/* Dropdown content */}
            <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-popover border border-border rounded-lg shadow-lg overflow-hidden">
              {/* Header */}
              <div className="px-3 py-2 border-b border-border">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Switch Organization
                </p>
              </div>

              {/* Search */}
              <div className="px-3 py-2 border-b border-border">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    ref={searchInputRef}
                    placeholder="Search organizations..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 pl-8 pr-8 text-xs"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setOpen(false);
                      } else if (e.key === 'Enter' && filtered.length === 1) {
                        handleSwitch(filtered[0].id);
                      }
                    }}
                  />
                  {search && (
                    <button
                      onClick={() => setSearch('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {/* Organization list */}
              <div className="max-h-64 overflow-y-auto py-1">
                {loading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                    <span className="ml-2 text-xs text-muted-foreground">Loading...</span>
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="px-3 py-4 text-center">
                    <p className="text-xs text-muted-foreground">
                      {search ? 'No organizations match your search' : 'No organizations available'}
                    </p>
                  </div>
                ) : (
                  filtered.map((org) => (
                    <button
                      key={org.id}
                      onClick={() => handleSwitch(org.id)}
                      disabled={switching}
                      className={cn(
                        'w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/50 transition-colors',
                        org.id === activeOrgId && 'bg-accent/30',
                        switching && 'opacity-50 cursor-not-allowed'
                      )}
                    >
                      <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                        <Building2 className="w-3.5 h-3.5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{org.name}</p>
                        <p className="text-[11px] text-muted-foreground capitalize">
                          {isSuperAdmin && org.role === 'super_admin' ? 'Super Admin' : org.role}
                          {org.status !== 'active' && (
                            <span className="ml-1.5 text-amber-600">· {org.status}</span>
                          )}
                        </p>
                      </div>
                      {org.id === activeOrgId && (
                        <Check className="w-4 h-4 text-primary shrink-0" />
                      )}
                    </button>
                  ))
                )}
              </div>

              {/* Create Organization (Super Admin only) */}
              {isSuperAdmin && (
                <>
                  <div className="border-t border-border" />
                  <button
                    onClick={() => {
                      setOpen(false);
                      setCreateDialogOpen(true);
                    }}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left hover:bg-accent/50 transition-colors text-primary"
                  >
                    <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                      <Plus className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-sm font-medium">Create Organization</span>
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Create Organization Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Organization</DialogTitle>
            <DialogDescription>
              Create a new organization for OmniSight.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-sm font-medium">Organization Name</label>
              <Input
                placeholder="e.g. Acme Corporation"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                className="mt-1"
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button disabled={createLoading || !createName.trim()} onClick={handleCreate}>
              {createLoading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Create Organization
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
