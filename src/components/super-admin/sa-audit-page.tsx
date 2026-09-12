'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PageHeader, PageTransition, StatusPill, Pagination, LoadingBlock, ErrorState, EmptyState } from './ui';
import { useAppStore } from '@/lib/store';

interface AuditEvent {
  id: string;
  action: string;
  resource: string;
  description: string;
  actorName: string | null;
  actorEmail: string | null;
  organization: { id: string; name: string; deploymentMode: string } | null;
  ipAddress: string | null;
  createdAt: string;
}

const ACTIONS = ['', 'create', 'update', 'delete', 'revoke', 'login', 'logout', 'switch'];

/**
 * Control Center — Audit Logs (control-plane activity).
 *
 * Reached from Overview → Recent Activity → View Audit Logs. NOT a primary
 * sidebar item. Uses the existing Super Admin-gated /api/super-admin/audit
 * endpoint (paginated, control-plane metadata only). Organization-scoped
 * audit lives in Organization Detail → Audit.
 */
export function SuperAdminAuditPage() {
  const { setCurrentPage } = useAppStore();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');

  const { data, isLoading, isError, refetch } = useQuery<{
    data: { data: AuditEvent[]; pagination: { page: number; pages: number; total: number } };
  }>({
    queryKey: ['sa-audit', page, action],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (action) params.set('action', action);
      const res = await fetch(`/api/super-admin/audit?${params}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`audit ${res.status}`);
      return res.json();
    },
  });

  const events = data?.data?.data ?? [];
  const pagination = data?.data?.pagination;

  return (
    <PageTransition>
      <Button
        variant="ghost"
        size="sm"
        className="mb-4 h-8 px-2 text-xs text-muted-foreground"
        onClick={() => setCurrentPage('sa-overview')}
      >
        <ChevronLeft className="w-4 h-4 mr-1" />
        Back to Overview
      </Button>

      <PageHeader
        eyebrow="Control Center"
        title="Audit Logs"
        description="Control-plane activity: organization lifecycle, payments, packages and authentication events."
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Action
          <select
            value={action}
            onChange={(e) => { setAction(e.target.value); setPage(1); }}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {ACTIONS.map((a) => (
              <option key={a || 'all'} value={a}>{a === '' ? 'All Actions' : a.charAt(0).toUpperCase() + a.slice(1)}</option>
            ))}
          </select>
        </label>
      </div>

      {isLoading ? (
        <LoadingBlock label="Loading audit records…" />
      ) : isError ? (
        <ErrorState onRetry={() => refetch()} />
      ) : events.length === 0 ? (
        <EmptyState
          title="No audit records found."
          body="Control-plane actions will appear here as they happen."
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[760px] border-collapse text-left text-[12.5px]">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  {['Time', 'Action', 'Actor', 'Organization', 'Details'].map((h) => (
                    <th key={h} className="tech-font px-3.5 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {events.map((e) => (
                  <tr key={e.id} className="transition-colors hover:bg-muted/40">
                    <td className="whitespace-nowrap px-3.5 py-3 text-foreground/70">
                      {new Date(e.createdAt).toLocaleString()}
                    </td>
                    <td className="px-3.5 py-3">
                      <span className="tech-font text-[11px] font-bold uppercase tracking-[0.1em] text-foreground/80">
                        {e.action}
                      </span>
                      <span className="ml-1.5 text-[11px] text-muted-foreground">{e.resource.replace(/_/g, ' ')}</span>
                    </td>
                    <td className="px-3.5 py-3 text-foreground/70">
                      {e.actorName || e.actorEmail || 'System'}
                    </td>
                    <td className="px-3.5 py-3">
                      {e.organization ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-foreground/80">{e.organization.name}</span>
                          <StatusPill label={e.organization.deploymentMode} tone="neutral" />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="max-w-[380px] px-3.5 py-3 text-muted-foreground">
                      <span className="line-clamp-2">{e.description}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pagination && (
            <Pagination
              page={pagination.page}
              pages={pagination.pages}
              total={pagination.total}
              onPage={setPage}
            />
          )}
        </>
      )}
    </PageTransition>
  );
}
