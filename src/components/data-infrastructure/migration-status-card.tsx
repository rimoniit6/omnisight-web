'use client';

// OmniSight — org-side data-migration status card (Data Infrastructure page).
//
// Shows the REAL progress of the organization's infrastructure data migration
// (records/objects/bytes copied, per-table snapshot, failure reason). All data
// comes from GET /api/organizations/[orgId]/settings/infrastructure/migration,
// whose counters are written by the migration runner from actual copy work —
// nothing here is simulated. The card never claims success before the backend
// reports verified/ready_to_activate/activated, and on failure it states that
// the current infrastructure remains active.
//
// transferState renders the org-side "Transfer Organization Data" flow:
//   pending  — connection validated, migration not started yet → Transfer Data
//   in-flight/failed/success states map 1:1 to the backend's migration row.
// State always comes from the backend (status API + change requests), so a
// refresh restores the true progress; the UI never restarts or fakes it.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, Clock, Loader2, AlertTriangle, HardDrive, ArrowDown } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface TableProgressEntry {
  done: number;
  total: number;
}

interface MigrationView {
  id: string;
  kind: string;
  status: string;
  request?: { id: string; requestNo: number; kind: string; status: string };
  recordsDone: number;
  recordsTotal: number;
  recordsPct: number | null;
  objectsDone: number;
  objectsTotal: number;
  objectsPct: number | null;
  bytesDone: string;
  bytesTotal: string;
  currentTable: string | null;
  tableProgress: Record<string, TableProgressEntry> | null;
  errorStage: string | null;
  errorMessage: string | null;
  createdAt: string;
}

const STATUS_META: Record<string, { label: string; className: string; active: boolean }> = {
  queued: { label: 'Queued', className: 'bg-blue-500/15 text-blue-600', active: true },
  migrating: { label: 'Migrating…', className: 'bg-violet-500/15 text-violet-600', active: true },
  reconciling: { label: 'Synchronizing…', className: 'bg-violet-500/15 text-violet-600', active: true },
  verifying: { label: 'Verifying…', className: 'bg-amber-500/15 text-amber-600', active: true },
  ready_to_activate: { label: 'Ready to activate', className: 'bg-emerald-500/15 text-emerald-600', active: false },
  activated: { label: 'Completed', className: 'bg-emerald-500/15 text-emerald-600', active: false },
  failed: { label: 'Failed', className: 'bg-rose-500/15 text-rose-600', active: false },
  cancelled: { label: 'Cancelled', className: 'bg-slate-500/15 text-slate-600', active: false },
};

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function ProgressBar({ pct }: { pct: number }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
      <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${w}%` }} />
    </div>
  );
}

export type TransferState = 'pending' | 'in-flight' | 'failed' | 'success' | 'none';

/**
 * Props:
 *   kindFilter — which infrastructure kind this tab tracks ('DATABASE' |
 *     'STORAGE'). The card renders only that kind's latest migration, so each
 *     tab shows its own lifecycle. All data is the CURRENT ORGANIZATION's —
 *     the status endpoint is org-scoped server-side.
 *   transferState — the org-side Transfer-Data lifecycle for this tab's kind:
 *     'pending'   connection validated, migration not started → Transfer Data
 *     'in-flight' migration queued/running/verifying/ready (or activated)
 *     'failed'    migration failed → Retry Transfer (server-gated)
 *     'success'   migration verified and activated
 *     'none'      nothing pending — render only an existing migration
 */
export function MigrationStatusCard({
  orgId,
  kindFilter,
  transferState = 'none',
}: {
  orgId: string;
  kindFilter: 'DATABASE' | 'STORAGE';
  transferState?: TransferState;
}) {
  const migrationQuery = useQuery<{ migration: MigrationView | null; history: MigrationView[]; preMigration?: { tablesTotal: number; recordsTotal: number; objectsTotal: number } | null }>({
    queryKey: ['infra-migration', orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings/infrastructure/migration`);
      if (!res.ok) throw new Error('Failed to load migration status');
      return (await res.json()) as { migration: MigrationView | null; history: MigrationView[] };
    },
    enabled: Boolean(orgId),
    refetchInterval: (query) => {
      const status = query.state.data?.migration?.status;
      // Poll fast while real work is in flight; idle otherwise.
      return status === 'migrating' || status === 'reconciling' || status === 'verifying' || status === 'queued' ? 4000 : 30000;
    },
    refetchIntervalInBackground: false,
  });

  const allMigrations = migrationQuery.data?.migration ? [migrationQuery.data.migration, ...(migrationQuery.data.history ?? [])] : (migrationQuery.data?.history ?? []);
  const preMigration = migrationQuery.data?.preMigration ?? null;
  // Latest migration of THIS tab's kind only (no cross-kind leakage).
  const migration = allMigrations.find((m) => m.kind === kindFilter) ?? null;

  const queryClient = useQueryClient();
  // Org-side "Transfer Data": starts (or retries) the EXISTING backend
  // migration for this org's approved change request. Idempotent — a repeat
  // click just reports the already-queued migration.
  const transferMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings/infrastructure/migration/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ kind: kindFilter }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to start the data transfer');
      return data as { migrationId: string; status: string; alreadyQueued?: boolean; retried?: boolean };
    },
    onSuccess: (data) => {
      if (data.retried) toast.success('Data transfer re-started — already-copied data is reused.');
      else if (data.alreadyQueued) toast.info('The data transfer is already in progress.');
      else toast.success('Data transfer started.');
      queryClient.invalidateQueries({ queryKey: ['infra-migration', orgId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (!migrationQuery.isSuccess || !migration || (transferState === 'pending' && ['cancelled', 'failed'].includes(migration.status))) {
    // Connection validated but the migration has not been queued yet. A stale
    // cancelled/failed row from an earlier attempt does NOT suppress the
    // "Transfer Organization Data" action — starting the transfer re-queues it.
    if (transferState === 'pending') {
      const noun = kindFilter === 'DATABASE' ? 'data' : 'files and attachments';
      return (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Transfer Organization Data</CardTitle>
              <Badge className="bg-blue-500/15 text-blue-600">Connection verified</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Your organization&apos;s existing {noun} are currently stored in OmniSight-managed infrastructure. Transfer them to your configured {kindFilter === 'DATABASE' ? 'database' : 'storage'} before switching to them.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Step indicator: connection done → transfer → verify → activate. */}
            <ol className="space-y-1.5 text-sm">
              <li className="flex items-center gap-2 text-emerald-700"><CheckCircle2 className="h-4 w-4" /> Connection successful</li>
              <li className="flex items-center gap-2 text-foreground"><ArrowDown className="h-4 w-4 text-muted-foreground" /></li>
              <li className="flex items-center gap-2 text-muted-foreground"><Clock className="h-4 w-4" /> Transfer organization data</li>
              <li className="flex items-center gap-2 text-muted-foreground"><ArrowDown className="h-4 w-4 text-muted-foreground" /></li>
              <li className="flex items-center gap-2 text-muted-foreground"><Clock className="h-4 w-4" /> Verify transferred data</li>
              <li className="flex items-center gap-2 text-muted-foreground"><ArrowDown className="h-4 w-4 text-muted-foreground" /></li>
              <li className="flex items-center gap-2 text-muted-foreground"><Clock className="h-4 w-4" /> Ready to activate</li>
            </ol>
            {/* Real, org-scoped pre-migration totals from the backend — what
                exactly will be copied. Never invented; hidden if unavailable. */}
            {preMigration && (
              <div className="rounded-lg border bg-muted/40 p-3 text-sm">
                <p className="font-medium">Data to transfer</p>
                <p className="text-muted-foreground">
                  {preMigration.tablesTotal} tables · {preMigration.recordsTotal.toLocaleString()} records
                  {kindFilter === 'STORAGE' && <> · {preMigration.objectsTotal.toLocaleString()} storage objects</>}
                </p>
              </div>
            )}
            <Button onClick={() => transferMutation.mutate()} disabled={transferMutation.isPending}>
              {transferMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <HardDrive className="mr-2 h-4 w-4" />}
              Transfer Data
            </Button>
            <p className="text-xs text-muted-foreground">
              Your current {kindFilter === 'DATABASE' ? 'database' : 'storage'} stays active during and after the transfer, until the migrated data is verified and the switch is activated.
            </p>
          </CardContent>
        </Card>
      );
    }
    return null;
  }

  const meta = STATUS_META[migration.status] ?? { label: migration.status, className: '', active: false };
  const kindLabel = migration.kind === 'DATABASE' ? 'database' : 'storage';
  // Overall progress = the union of the two independent progress axes the
  // backend actually tracks. Only the axis matching the migration's kind is
  // non-null for one migration; the total-records header line uses the same
  // real counters. There is no synthetic overall percentage.
  const overallDone = migration.kind === 'DATABASE' ? migration.recordsDone : migration.objectsDone;
  const overallTotal = migration.kind === 'DATABASE' ? migration.recordsTotal : migration.objectsTotal;
  const overallPct =
    migration.kind === 'DATABASE' ? migration.recordsPct : migration.objectsPct;
  const inFlight =
    migration.status === 'migrating' || migration.status === 'reconciling' || migration.status === 'verifying' || migration.status === 'queued';

  // State-machine consistency guard — mirrors the backend invariant, so the
  // card can never render "migrated successfully / verified / ready at 99%".
  // A ready_to_activate/activated row whose persisted counters disagree
  // (recordsDone !== recordsTotal) is a stale PRE-FIX artifact (e.g. the
  // historical 1,481 / 1,491). The migration status GET self-heals it against
  // the real verified destination counts before this renders; if it ever
  // renders stale, this guard defuses the success claims and shows a clearly
  // labeled previous-attempt state instead.
  const verifiedStatus = migration.status === 'ready_to_activate' || migration.status === 'activated';
  const countersInconsistent = verifiedStatus && migration.recordsTotal > 0 && migration.recordsDone !== migration.recordsTotal;
  const successShown = migration.status === 'ready_to_activate' && !countersInconsistent;

  // On a failed org migration the backend guarantees the previous
  // infrastructure is still active — say so explicitly (fail-safe messaging).
  const retryAllowed = migration.status === 'failed' || migration.status === 'cancelled';
  const failureBanner =
    migration.status === 'failed' ? (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Organization Data Transfer Failed</p>
            <p className="mt-1">Your current infrastructure is still active — nothing was switched.</p>
            {migration.errorMessage && <p className="mt-1 text-xs">Reason: {migration.errorMessage}</p>}
          </div>
        </div>
      </div>
    ) : null;

  // Lifecycle gate: the configured destination does NOT become the active
  // infrastructure until this migration reaches ready_to_activate → activated.
  const activationPending = transferState === 'pending' || transferState === 'in-flight';
  const activationGate = activationPending ? (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
      <div className="flex items-start gap-2">
        <Clock className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          This migration must complete and be verified before your configured {kindLabel} becomes the active infrastructure. Your current {kindLabel} keeps serving your organization until then.
        </p>
      </div>
    </div>
  ) : null;

  const dbBar =
    migration.kind === 'DATABASE' ? (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">OmniSight-managed database → your configured database</span>
          <span className="text-muted-foreground">
            {migration.recordsDone.toLocaleString()} / {migration.recordsTotal.toLocaleString()} records
            {migration.recordsPct !== null ? ` (${migration.recordsPct}%)` : ''}
          </span>
        </div>
        <ProgressBar pct={migration.recordsPct ?? 0} />
        {migration.currentTable && (migration.status === 'migrating' || migration.status === 'reconciling' || migration.status === 'verifying') && (
          <p className="text-xs text-muted-foreground">Copying: {migration.currentTable}</p>
        )}
        {migration.tableProgress && Object.keys(migration.tableProgress).length > 0 && (
          <div className="mt-2 space-y-1 border-t border-border/60 pt-2">
            {Object.entries(migration.tableProgress).map(([table, p]) => (
              <div key={table} className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{table}</span>
                <span>
                  {p.done.toLocaleString()} / {p.total.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    ) : null;

  const storageBar =
    migration.kind === 'STORAGE' ? (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1.5 font-medium">
            <HardDrive className="h-4 w-4" /> OmniSight-managed storage → your configured storage
          </span>
          <span className="text-muted-foreground">
            {migration.objectsDone.toLocaleString()} / {migration.objectsTotal.toLocaleString()} objects ·{' '}
            {formatBytes(Number(migration.bytesDone))} / {formatBytes(Number(migration.bytesTotal))}
          </span>
        </div>
        <ProgressBar pct={migration.objectsPct ?? 0} />
      </div>
    ) : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Data Migration</CardTitle>
          <Badge className={meta.className}>{meta.label}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {successShown &&
            `Organization ${kindLabel} migrated successfully — everything has been verified in your configured ${kindLabel}. Activation will cut your organization over to it.`}
          {migration.status === 'activated' && !countersInconsistent &&
            `Organization data migrated successfully. Your organization now operates on its own ${kindLabel}.`}
          {inFlight &&
            (migration.kind === 'STORAGE'
              ? `Migrating organization storage — transferring your organization's files (screenshots and recordings referenced by your data) to the new storage. Only your organization is affected, and your current storage stays active until the transfer is verified.`
              : `Migrating organization data — transferring this organization's existing data to the new ${kindLabel}. Only your organization is affected, and your current ${kindLabel} stays active until the transfer is verified.`)}
          {migration.status === 'failed' && 'The migration did not complete.'}
          {migration.status === 'cancelled' && 'This migration was cancelled before completion.'}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Step indicator — mapped 1:1 to the backend's migration states. */}
        <ol className="grid grid-cols-2 gap-1.5 text-xs sm:grid-cols-4">
          <li className={`flex items-center gap-1.5 ${migration.status !== 'queued' ? 'text-emerald-700' : 'text-muted-foreground'}`}>
            <CheckCircle2 className="h-3.5 w-3.5" /> Connection
          </li>
          <li className={`flex items-center gap-1.5 ${migration.status === 'migrating' || migration.status === 'reconciling' || migration.status === 'ready_to_activate' || migration.status === 'activated' ? 'text-foreground' : migration.status === 'verifying' ? 'text-emerald-700' : 'text-muted-foreground'}`}>
            {migration.status === 'migrating' || migration.status === 'reconciling' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />} {migration.status === 'reconciling' ? 'Synchronizing' : 'Transferring'}
          </li>
          <li className={`flex items-center gap-1.5 ${migration.status === 'verifying' ? 'text-foreground' : ['ready_to_activate', 'activated'].includes(migration.status) ? 'text-emerald-700' : 'text-muted-foreground'}`}>
            {migration.status === 'verifying' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clock className="h-3.5 w-3.5" />} Verifying
          </li>
          <li className={`flex items-center gap-1.5 ${successShown ? 'text-emerald-700' : migration.status === 'activated' && !countersInconsistent ? 'text-emerald-700' : 'text-muted-foreground'}`}>
            {migration.status === 'activated' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />} Ready to activate
          </li>
        </ol>
        {activationGate}
        {/* Overall — straight from the backend's persisted counters. */}
        {overallTotal > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">Overall progress</span>
              <span className="text-muted-foreground">
                {overallDone.toLocaleString()} / {overallTotal.toLocaleString()} {migration.kind === 'DATABASE' ? 'records' : 'objects'}
                {overallPct !== null ? ` (${overallPct}%)` : ''}
              </span>
            </div>
            <ProgressBar pct={overallPct ?? 0} />
          </div>
        )}
        {failureBanner}
        {dbBar}
        {storageBar}
        {/* Storage migrations carry byte counts alongside the object counts. */}
        {migration.kind === 'STORAGE' && migration.bytesTotal !== '0' && overallTotal > 0 && (
          <p className="text-xs text-muted-foreground">
            Bytes copied: {formatBytes(Number(migration.bytesDone))} / {formatBytes(Number(migration.bytesTotal))}
          </p>
        )}
        {migration.status === 'activated' && !countersInconsistent && (
          <div className="flex items-center gap-2 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            {migration.kind === 'STORAGE'
              ? 'All organization storage data has been verified in the new storage and activated.'
              : 'All organization data verified in the new database and activated.'}
          </div>
        )}
        {successShown && (
          <div className="flex items-center gap-2 text-sm text-emerald-700">
            <CheckCircle2 className="h-4 w-4" /> Verified — activation will switch this organization to the new infrastructure.
          </div>
        )}
        {countersInconsistent && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Previous migration attempt — progress is being reconciled</p>
                <p className="mt-1 text-xs">
                  The stored progress ({migration.recordsDone.toLocaleString()} / {migration.recordsTotal.toLocaleString()}) is
                  from an earlier migration attempt and does not match the verified destination. This page reconciles the counters
                  against the actual verified data automatically. If the destination cannot be re-verified, the transfer is re-queued.
                  Nothing has been switched — your current {kindLabel} remains active until activation.
                </p>
              </div>
            </div>
          </div>
        )}
        {(migration.status === 'migrating' || migration.status === 'reconciling' || migration.status === 'verifying') && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {migration.status === 'verifying' ? <Clock className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {migration.status === 'reconciling'
              ? 'Synchronizing new data that arrived during the transfer…'
              : migration.status === 'verifying'
                ? migration.kind === 'STORAGE'
                  ? 'Verifying the copied organization files…'
                  : 'Verifying the copied organization data…'
                : migration.kind === 'STORAGE'
                  ? 'Copying your organization files…'
                  : 'Copying your organization data…'}
          </div>
        )}
        {migration.status === 'queued' && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> Waiting for the next available migration slot…
          </div>
        )}
        {retryAllowed && (
          <div>
            <Button variant="outline" onClick={() => transferMutation.mutate()} disabled={transferMutation.isPending}>
              {transferMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Retry Transfer
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Already-transferred data is reused — nothing is duplicated.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function MigrationStatusBadges() {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <XCircle className="h-3.5 w-3.5" />
      <span>Migration status is unavailable.</span>
    </div>
  );
}
