'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Building2, Package, Globe, Plus, ScrollText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KpiCard, PageHeader, PageTransition, ErrorState, LoadingBlock, StatusPill } from './ui';
import { useAppStore } from '@/lib/store';

interface MetricsResponse {
  organizations: {
    total: number;
    managed: number;
    customerDb: number;
    private: number;
    byStatus: Record<string, number>;
    unresolvedModes: number;
    pendingDeployments: number;
  };
}

interface AuditEvent {
  id: string;
  action: string;
  resource: string;
  description: string;
  actorName: string | null;
  actorEmail: string | null;
  organization: { id: string; name: string; deploymentMode: string } | null;
  createdAt: string;
}

const fetchMetrics = async (): Promise<MetricsResponse> => {
  const res = await fetch('/api/super-admin/metrics', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`metrics ${res.status}`);
  const json = await res.json();
  return json.data ?? json;
};

// Real control-plane audit events — never generated/fake data. The shared
// /api/super-admin/audit endpoint is Super Admin-gated and returns control-
// plane metadata only (no payloads/secrets).
const fetchRecentActivity = async (): Promise<AuditEvent[]> => {
  const res = await fetch('/api/super-admin/audit?page=1&pageSize=6', { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`audit ${res.status}`);
  const json = await res.json();
  return (json.data?.data ?? json.data ?? []) as AuditEvent[];
};

/** Short human label for an audit event (only actions that actually exist). */
function activityLabel(e: AuditEvent): string {
  const resource = e.resource.replace(/_/g, ' ');
  switch (`${e.action}:${e.resource}`) {
    case 'create:organization': return 'Organization Created';
    case 'update:organization': return 'Organization Updated';
    case 'create:invoice': return 'Manual Payment Recorded';
    case 'update:invoice': return 'Manual Payment Updated';
    case 'create:license_key': return 'License Issued';
    case 'revoke:license_key': return 'License Revoked';
    case 'create:package': return 'Package Created';
    case 'update:package': return 'Package Updated';
    case 'create:user': return 'Owner/Admin Created';
    default: return `${e.action.charAt(0).toUpperCase()}${e.action.slice(1)} ${resource.charAt(0).toUpperCase()}${resource.slice(1)}`;
  }
}

/**
 * Control Center — Overview.
 *
 * A lightweight control-center landing screen: platform-level organization
 * KPIs (real /api/super-admin/metrics data), Quick Actions into the four
 * primary surfaces, and Recent Control-Plane Activity backed by the real
 * audit log (empty state when no records exist). It deliberately does NOT
 * duplicate the Organizations list or render operational analytics.
 */
export function SuperAdminOverviewPage() {
  const { setCurrentPage, setPageContext, setPageContextLabel } = useAppStore();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['sa-metrics'],
    queryFn: fetchMetrics,
    staleTime: 60_000,
  });
  const { data: activity, isLoading: activityLoading, isError: activityError } = useQuery({
    queryKey: ['sa-recent-activity'],
    queryFn: fetchRecentActivity,
    staleTime: 30_000,
  });

  if (isLoading) return <LoadingBlock label="Loading platform summary…" />;
  if (isError || !data) return <ErrorState onRetry={() => refetch()} />;

  const org = data.organizations;
  const statusCounts = org.byStatus;

  const openOrg = (e: AuditEvent) => {
    if (!e.organization) return;
    setCurrentPage('super-admin-organization-detail');
    setPageContext(e.organization.id);
    setPageContextLabel(e.organization.name);
  };

  return (
    <PageTransition>
      <PageHeader
        eyebrow="Control Center"
        title="Overview"
        description="Manage your OmniSight organizations, packages, and public website."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Total Organizations" value={org.total} sub="All organizations" />
        <KpiCard label="Active" value={statusCounts.active ?? 0} tone="ok" sub="Currently active" />
        <KpiCard label="Pending" value={statusCounts.pending ?? 0} tone="warn" sub="Awaiting activation" />
        <KpiCard label="Suspended" value={statusCounts.suspended ?? 0} tone="danger" sub="Currently suspended" />
      </div>

      {/* Quick Actions */}
      <section className="mt-8">
        <h2 className="tech-font text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Quick Actions</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button
            onClick={() => setCurrentPage('sa-create-organization')}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Plus className="h-5 w-5 text-primary" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Provision Organization</span>
              <span className="block text-xs text-muted-foreground">Create a customer workspace</span>
            </span>
          </button>
          <button
            onClick={() => setCurrentPage('super-admin-organizations')}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Building2 className="h-5 w-5 text-primary" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Manage Organizations</span>
              <span className="block text-xs text-muted-foreground">Lifecycle, payments, control plane</span>
            </span>
          </button>
          <button
            onClick={() => setCurrentPage('sa-packages-pricing')}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Package className="h-5 w-5 text-primary" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Manage Packages</span>
              <span className="block text-xs text-muted-foreground">Reusable plan catalog</span>
            </span>
          </button>
          <button
            onClick={() => setCurrentPage('sa-landing')}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Globe className="h-5 w-5 text-primary" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">Edit Landing Page</span>
              <span className="block text-xs text-muted-foreground">Public website copy</span>
            </span>
          </button>
        </div>
      </section>

      {/* Recent Control-Plane Activity — real audit records */}
      <section className="mt-8">
        <div className="flex items-center justify-between gap-3">
          <h2 className="tech-font text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Recent Activity</h2>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurrentPage('sa-audit')}
            className="h-8 text-xs"
          >
            <ScrollText className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            View Audit Logs
          </Button>
        </div>
        <div className="mt-3 rounded-xl border border-border bg-card">
          {activityLoading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading activity…
            </div>
          ) : activityError ? (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">
              Unable to load activity.
            </div>
          ) : !activity || activity.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
              <ScrollText className="h-8 w-8 text-muted-foreground/40" aria-hidden />
              <p className="mt-2 text-sm font-medium text-foreground/80">No control-plane activity yet.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Actions like provisioning organizations, recording payments and issuing access credentials will appear here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/70">
              {activity.map((e) => (
                <li
                  key={e.id}
                  className={e.organization ? 'cursor-pointer transition-colors hover:bg-muted/40' : undefined}
                  onClick={() => openOrg(e)}
                >
                  <div className="flex items-start gap-3 px-5 py-3.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-foreground">{activityLabel(e)}</p>
                        {e.organization && <StatusPill label={e.organization.deploymentMode} tone="neutral" />}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {e.organization ? e.organization.name : e.description}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-xs text-muted-foreground">
                        {new Date(e.createdAt).toLocaleDateString()}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                        {e.actorName || e.actorEmail || 'System'}
                      </p>
                    </div>
                    {e.organization && (
                      <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </PageTransition>
  );
}
