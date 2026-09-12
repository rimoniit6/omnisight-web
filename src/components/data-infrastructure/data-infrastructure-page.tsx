'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Loader2, Save, Database, HardDrive, ShieldAlert, CheckCircle2, XCircle, X, Clock, AlertTriangle, HelpCircle, ChevronDown, ChevronRight, Info } from 'lucide-react';
import { toast } from 'sonner';
import { useCurrentUser } from '@/hooks/use-current-user';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { MigrationStatusCard, type TransferState } from '@/components/data-infrastructure/migration-status-card';

interface OpenChangeRequestView {
  id: string;
  kind: string;
  status: string;
}

/**
 * Per-tab Transfer-Data lifecycle wrapper. Computes the org-side transfer
 * state from the CURRENT ORGANIZATION's backend data only:
 *
 *   pending   — (a) an OPEN change request for this kind exists (submitted or
 *               approved) and its migration has not started, OR
 *               (b) this kind's custom infrastructure is CONNECTED (settings)
 *               but no completed migration exists for it — the legacy/
 *               catch-up state where the org switched infrastructure before
 *               real migration existed. Connection success is NOT migration:
 *               the Transfer action MUST appear (do not require a migration
 *               record to show it).
 *   in-flight — queued / migrating / verifying / ready_to_activate
 *   failed    — migration failed (Retry offered; server re-gates)
 *   activated — hide the card: the tab's connected/compact card is the
 *               completed state
 *   none      — nothing pending (platform infra, no open request)
 *
 * The migration status endpoint is org-scoped server-side, so a refresh
 * always restores the true state — the UI never restarts or fakes progress.
 */
function TransferGate({ orgId, kind }: { orgId: string; kind: 'DATABASE' | 'STORAGE' }) {
  const settingsQuery = useQuery<OrgSettings>({
    queryKey: ['org-settings', orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load settings');
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });

  const migrationQuery = useQuery<{ migration: unknown; history: Array<{ kind: string; status: string }> }>({
    queryKey: ['infra-migration', orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings/infrastructure/migration`);
      if (!res.ok) throw new Error('Failed to load migration status');
      return res.json();
    },
    enabled: !!orgId,
    refetchInterval: 4000,
  });

  const requestsQuery = useQuery<{ requests: OpenChangeRequestView[] }>({
    queryKey: ['infra-requests', orgId, kind],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings/${kind === 'DATABASE' ? 'database' : 'storage'}/requests`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load requests');
      return res.json();
    },
    enabled: !!orgId,
    refetchInterval: 10000,
  });

  const s = settingsQuery.data;
  const dbConnected = s?.useOwnDb === true && Boolean(s.dbHost) && s.dbTestStatus === 'success';
  const storageConnected = s?.storageDriver === 'supabase' && s.storageTestStatus === 'success';
  // The Transfer flow targets the org's OWN database AND storage; require both
  // personalized connections to be validated before offering it.
  const bothConnected = dbConnected && storageConnected;

  const migrations: Array<{ kind: string; status: string }> = [
    ...(migrationQuery.data?.migration ? [migrationQuery.data.migration as unknown as { kind: string; status: string }] : []),
    ...((migrationQuery.data?.history ?? []) as Array<{ kind: string; status: string }>),
  ];
  const latest = migrations.find((m) => m.kind === kind) ?? null;
  const openRequest = (requestsQuery.data?.requests ?? []).find(
    (r) => r.kind === kind && (r.status === 'submitted' || r.status === 'approved')
  );

  let transferState: TransferState = 'none';
  if (latest && ['queued', 'migrating', 'verifying', 'ready_to_activate'].includes(latest.status)) transferState = 'in-flight';
  else if (latest?.status === 'failed') transferState = 'failed';
  else if (latest?.status === 'activated') transferState = 'none'; // completed — the connected card is the success state
  else if (openRequest) transferState = 'pending';
  else if (bothConnected) transferState = 'pending'; // connected but never migrated → migration required

  return <MigrationStatusCard orgId={orgId} kindFilter={kind} transferState={transferState} />;
}

function DatabaseMigrationGate({ orgId }: { orgId: string }) {
  return <TransferGate orgId={orgId} kind="DATABASE" />;
}

function StorageMigrationGate({ orgId }: { orgId: string }) {
  return <TransferGate orgId={orgId} kind="STORAGE" />;
}

const KEEP_KEY = '••••••';

interface OrgSettings {
  id: string | null;
  organizationId: string;
  aiProvider: string | null;
  hasAiKey: boolean;
  aiApiKeyLast4: string | null;
  aiBaseUrl: string | null;
  aiModel: string | null;
  useOwnDb: boolean;
  dbHost: string | null;
  dbPort: number | null;
  dbName: string | null;
  dbUser: string | null;
  hasDbPassword: boolean;
  dbSsl: boolean;
  storageDriver: string | null;
  storageUrl: string | null;
  hasStorageKey: boolean;
  storageTestedAt: string | null;
  storageTestStatus: string | null;
  aiTestedAt: string | null;
  aiTestStatus: string | null;
  dbTestedAt: string | null;
  dbTestStatus: string | null;
}

interface ChangeRequest {
  id: string;
  kind: string;
  requestNo: number;
  status: string;
  config: Record<string, unknown>;
  hasSecret: boolean;
  secretLast4: string | null;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  lastTestedAt: string | null;
  requestedByEmail: string;
  requestedAt: string;
  approvedByEmail: string | null;
  approvedAt: string | null;
  rejectionReason: string | null;
  cancelledByEmail: string | null;
  cancelledAt: string | null;
  errorMessage: string | null;
  activatedAt: string | null;
  createdAt: string;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    draft: { label: 'Draft', className: 'bg-slate-500/15 text-slate-600' },
    submitted: { label: 'Pending Review', className: 'bg-amber-500/15 text-amber-600' },
    approved: { label: 'Approved', className: 'bg-blue-500/15 text-blue-600' },
    applied: { label: 'Applied', className: 'bg-violet-500/15 text-violet-600' },
    active: { label: 'Active', className: 'bg-emerald-500/15 text-emerald-600' },
    rejected: { label: 'Rejected', className: 'bg-rose-500/15 text-rose-600' },
    cancelled: { label: 'Cancelled', className: 'bg-slate-500/15 text-slate-600' },
    superseded: { label: 'Superseded', className: 'bg-slate-500/15 text-slate-600' },
  };
  const info = map[status] ?? { label: status, className: '' };
  return <Badge className={info.className}>{info.label}</Badge>;
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'active' || status === 'success' || status === 'connected') {
    return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  }
  if (status === 'failed' || status === 'rejected') {
    return <XCircle className="h-4 w-4 text-rose-500" />;
  }
  if (status === 'submitted' || status === 'approved' || status === 'applied') {
    return <Clock className="h-4 w-4 text-amber-500" />;
  }
  return <AlertTriangle className="h-4 w-4 text-muted-foreground" />;
}

function StatusDescription({ status, rejectionReason, errorMessage }: { status: string; rejectionReason?: string | null; errorMessage?: string | null }) {
  const descriptions: Record<string, string> = {
    submitted: 'Your request was submitted and is waiting for a Super Admin to review it.',
    approved: 'Your request has been approved. A Super Admin will now prepare and apply the configuration.',
    applied: 'Your configuration has been approved and is being prepared for activation.',
    active: 'This configuration is currently active for your organization.',
    rejected: 'Your request was not approved.',
    cancelled: 'You cancelled this request.',
    superseded: 'This request was replaced by a newer submission.',
    draft: 'This request is a draft and has not been submitted yet.',
  };

  const base = descriptions[status] || '';

  if (status === 'rejected' && rejectionReason) {
    return (
      <div className="mt-1">
        <p className="text-sm text-muted-foreground">{base}</p>
        <p className="text-sm text-rose-600 mt-1">Reason: {rejectionReason}</p>
      </div>
    );
  }

  if (status === 'approved' && errorMessage) {
    return (
      <div className="mt-1">
        <p className="text-sm text-muted-foreground">The configuration was approved but could not be activated. A Super Admin can retry.</p>
        <p className="text-sm text-rose-600 mt-1">Error: {errorMessage}</p>
      </div>
    );
  }

  return base ? <p className="text-sm text-muted-foreground mt-1">{base}</p> : null;
}

function RequestHistoryItem({ req, orgId }: { req: ChangeRequest; orgId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const queryClient = useQueryClient();

  const canCancel = req.status === 'submitted' || (req.status === 'approved' && Boolean(req.errorMessage));

  const cancelMutation = useMutation({
    mutationFn: async ({ reason }: { reason?: string }) => {
      const endpoint = req.kind === 'DATABASE'
        ? `/api/organizations/${orgId}/settings/database/cancel`
        : `/api/organizations/${orgId}/settings/storage/cancel`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ reason: reason || undefined }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to cancel request');
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success('Change request cancelled');
      queryClient.invalidateQueries({ queryKey: ['infra-requests', orgId, 'DATABASE'] });
      queryClient.invalidateQueries({ queryKey: ['infra-requests', orgId, 'STORAGE'] });
      setCancelDialogOpen(false);
      setCancelReason('');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="rounded-lg border border-border/60 p-3 text-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <StatusIcon status={req.status} />
            <div>
              <div className="font-medium">Request #{req.requestNo}</div>
              <div className="text-xs text-muted-foreground">
                by {req.requestedByEmail} · {new Date(req.requestedAt).toLocaleDateString()}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={req.status} />
            {canCancel && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-rose-600 hover:text-rose-700 hover:bg-rose-50"
                onClick={(e) => { e.stopPropagation(); setCancelDialogOpen(true); }}
              >
                <X className="h-3.5 w-3.5 mr-1" />
                Cancel
              </Button>
            )}
            <CollapsibleTrigger asChild>
              <button className="p-1 hover:bg-muted rounded">
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <StatusDescription
            status={req.status}
            rejectionReason={req.rejectionReason}
            errorMessage={req.errorMessage}
          />
          {req.lastTestStatus && req.lastTestMessage && (
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span>Last test:</span>
              <StatusIcon status={req.lastTestStatus} />
              <span>{req.lastTestMessage}</span>
              {req.lastTestedAt && <span>· {new Date(req.lastTestedAt).toLocaleDateString()}</span>}
            </div>
          )}
        </CollapsibleContent>
      </div>

      {/* Cancel Confirmation Dialog */}
      <Dialog open={cancelDialogOpen} onOpenChange={(open) => { if (!open) { setCancelDialogOpen(false); setCancelReason(''); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Change Request #{req.requestNo}</DialogTitle>
            <DialogDescription>
              Are you sure you want to cancel this {req.kind} change request? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Label htmlFor="cancel-reason">Reason (optional)</Label>
            <Textarea
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder="Optional reason for cancellation..."
              rows={2}
            />
          </div>
          <DialogFooter className="flex-row gap-3 justify-end pt-2">
            <Button variant="outline" onClick={() => { setCancelDialogOpen(false); setCancelReason(''); }}>
              Keep Request
            </Button>
            <Button
              variant="destructive"
              onClick={() => cancelMutation.mutate({ reason: cancelReason || undefined })}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
              Cancel Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Collapsible>
  );
}

function HelpPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <button className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <HelpCircle className="h-4 w-4" />
          <span>{title}</span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 rounded-lg border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground space-y-2">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function HowItWorks() {
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm">
      <div className="flex items-start gap-2">
        <Info className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
        <div>
          <p className="font-medium text-blue-900">How infrastructure changes work</p>
          <ol className="mt-2 space-y-1 text-blue-800 list-decimal list-inside">
            <li>Enter your database or storage details.</li>
            <li>Test the connection to make sure it works.</li>
            <li>Submit the change request.</li>
            <li>A Super Admin reviews and approves the request.</li>
            <li>OmniSight validates the configuration and makes it active.</li>
          </ol>
          <p className="mt-2 text-blue-700">
            Submitting a request does NOT immediately switch production traffic. Changes only become active after Super Admin approval and validation.
          </p>
        </div>
      </div>
    </div>
  );
}

export function DataInfrastructurePage() {
  const { user, org, isLoading: authLoading } = useCurrentUser();
  const orgId = org?.id ?? '';

  const router = useRouter();

  useEffect(() => {
    if (!authLoading && !user) router.push('/login');
  }, [authLoading, user, router]);

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background p-8">
        <Skeleton className="h-10 w-72 mb-6" />
        <Skeleton className="h-56 w-full mb-6 rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!user || !orgId) return null;

  if (!['super_admin', 'owner', 'admin', 'org_admin'].includes(user.role)) {
    return (
      <div className="p-8 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <h1 className="mt-4 text-2xl font-bold">Admin Only</h1>
        <p className="mt-2 text-muted-foreground">Only organization admins can manage data infrastructure.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="text-2xl font-bold tracking-tight">Data Infrastructure</h1>
      <p className="mt-1.5 text-muted-foreground">
        Configure your organization&apos;s database and storage destinations.
      </p>

      <HowItWorks />

      <Tabs defaultValue="database" className="mt-6">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="database" className="flex items-center gap-2">
            <Database className="h-4 w-4" /> Database
          </TabsTrigger>
          <TabsTrigger value="storage" className="flex items-center gap-2">
            <HardDrive className="h-4 w-4" /> Storage
          </TabsTrigger>
        </TabsList>
        <TabsContent value="database" className="space-y-6">
          {/* Migration lifecycle for THIS organization (kind DATABASE). The
              card itself reads the org-scoped settings, so migrationRequired
              is derived there. */}
          <DatabaseMigrationGate orgId={orgId} />
          <DatabaseConfig orgId={orgId} />
        </TabsContent>
        <TabsContent value="storage" className="space-y-6">
          {/* Migration lifecycle for THIS organization (kind STORAGE). */}
          <StorageMigrationGate orgId={orgId} />
          <StorageConfig orgId={orgId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function DatabaseConfig({ orgId }: { orgId: string }) {
  // Presentation-only: whether the user has asked to reopen the full form while
  // the database is CONNECTED. All connection state itself (connected/testing/
  // error) comes from the backend via settingsQuery — this flag never overrides
  // it, so a refresh while connected still shows the Connected card.
  const [editing, setEditing] = useState(false);
  const [useOwnDb, setUseOwnDb] = useState(false);
  const [dbHost, setDbHost] = useState('');
  const [dbPort, setDbPort] = useState('5432');
  const [dbName, setDbName] = useState('');
  const [dbUser, setDbUser] = useState('');
  const [dbPassword, setDbPassword] = useState('');
  const [dbSsl, setDbSsl] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ status: string; message: string } | null>(null);
  const [configFingerprint, setConfigFingerprint] = useState<string | null>(null);

  const settingsQuery = useQuery<OrgSettings>({
    queryKey: ['org-settings', orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load settings');
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });

  const requestsQuery = useQuery<{ requests: ChangeRequest[] }>({
    queryKey: ['infra-requests', orgId, 'DATABASE'],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings/database/requests`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load requests');
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 15_000,
  });

  useEffect(() => {
    const data = settingsQuery.data;
    if (data && !loaded) {
      setUseOwnDb(data.useOwnDb);
      setDbHost(data.dbHost ?? '');
      setDbPort(data.dbPort ? String(data.dbPort) : '5432');
      setDbName(data.dbName ?? '');
      setDbUser(data.dbUser ?? '');
      setDbPassword(data.hasDbPassword ? KEEP_KEY : '');
      setDbSsl(data.dbSsl);
      setLoaded(true);
    }
  }, [settingsQuery.data, loaded]);

  // Clear test result when any config field changes (test is no longer valid).
  // Use a ref to track the tested config snapshot so we only clear when the
  // user actually changes something after a successful test.
  const testedConfigRef = useRef<string | null>(null);

  // Watch for config changes and clear test result if config differs from tested.
  useEffect(() => {
    const currentConfig = JSON.stringify({ useOwnDb, dbHost, dbPort, dbName, dbUser, dbPassword, dbSsl });
    if (testedConfigRef.current !== null && testedConfigRef.current !== currentConfig) {
      setTestResult(null);
      setConfigFingerprint(null);
      testedConfigRef.current = null;
    }
  }, [useOwnDb, dbHost, dbPort, dbName, dbUser, dbPassword, dbSsl]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (useOwnDb) {
        if (dbHost) body.dbHost = dbHost;
        if (dbName) body.dbName = dbName;
        if (dbUser) body.dbUser = dbUser;
        if (dbPort) body.dbPort = Number(dbPort);
        if (dbPassword && dbPassword !== KEEP_KEY) body.dbPassword = dbPassword;
        body.dbSsl = dbSsl;
      }
      let res: Response;
      try {
        res = await fetch(`/api/organizations/${orgId}/settings/database/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
      } catch {
        // The API itself was unreachable — do NOT mislabel this as a DB failure.
        setTestResult({ status: 'failed', message: 'Connection test unavailable' });
        toast.error('Connection test unavailable', {
          description: 'OmniSight could not reach the server. Please check your connection and try again.',
        });
        return;
      }
      const data = await res.json().catch(() => null);
      if (!data) {
        setTestResult({ status: 'failed', message: 'Connection test unavailable' });
        toast.error('Connection test unavailable', {
          description: 'OmniSight could not reach the server. Please check your connection and try again.',
        });
        return;
      }
      if (!res.ok) {
        const message = typeof data.error === 'string' ? data.error : 'Database test failed';
        setTestResult({ status: 'failed', message });
        toast.error('Connection failed', { description: message });
        return;
      }
      const status = data.status ?? 'failed';
      const message = typeof data.message === 'string' && data.message ? data.message : 'Database test failed';
      setTestResult({ status, message });
      if (status === 'success' || status === 'connected') {
        // Store the fingerprint and config snapshot so Submit can be enabled
        // and we can detect if the user changes config after testing.
        const fp = data.configFingerprint;
        if (fp) {
          setConfigFingerprint(fp);
          testedConfigRef.current = JSON.stringify({ useOwnDb, dbHost, dbPort, dbName, dbUser, dbPassword, dbSsl });
        }
        toast.success('Connection successful', { description: 'OmniSight can connect to this database.' });
      } else if (status === 'not_configured') {
        toast.info(message);
      } else {
        toast.error('Connection failed', { description: message });
      }
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/settings/database`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          useOwnDb,
          dbHost: dbHost || null,
          dbPort: dbPort ? Number(dbPort) : null,
          dbName: dbName || null,
          dbUser: dbUser || null,
          dbPassword: dbPassword && dbPassword !== KEEP_KEY ? dbPassword : undefined,
          dbSsl,
          configFingerprint: configFingerprint ?? undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to submit change request');
        return;
      }
      if (data.unchanged) {
        toast.info(data.message || 'Configuration is already active');
      } else {
        toast.success('Change request submitted — awaiting Super Admin approval');
        requestsQuery.refetch();
      }
    } catch {
      toast.error('Network error');
    } finally {
      setSaving(false);
    }
  };

  const requests = requestsQuery.data?.requests ?? [];
  const settings = settingsQuery.data;
  const hasActiveDb = settings?.useOwnDb && settings?.dbHost;
  // Source of truth = the backend's serialized settings (GET /settings).
  // "connected" means the custom DB is active AND its last verified test
  // passed — i.e. activation already happened after a verified migration.
  // A configured-but-unverified DB never shows this card; the migration
  // lifecycle card above communicates that gate instead.
  const connected = settings?.useOwnDb === true && Boolean(settings.dbHost) && settings.dbTestStatus === 'success';

  // ── CONNECTED state: compact card, no credentials (backend never returns
  // the password; only hasDbPassword is known here). "Reconfigure" reveals the
  // full form; cancelling returns to this card.
  if (connected && !editing) {
    return (
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            Database Configuration
          </CardTitle>
          <CardDescription>
            <div className="flex items-center gap-2 mt-1">
              <Badge className="bg-emerald-500/15 text-emerald-600">Connected</Badge>
              <span className="text-sm text-muted-foreground">
                Your organization operates on its own PostgreSQL database.
              </span>
            </div>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium text-emerald-900">Using your configured database</p>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-emerald-800">
                  <dt className="text-emerald-700">Host</dt>
                  <dd className="truncate font-mono">{settings?.dbHost}{settings?.dbPort ? `:${settings.dbPort}` : ''}</dd>
                  <dt className="text-emerald-700">Database</dt>
                  <dd className="truncate font-mono">{settings?.dbName}</dd>
                  <dt className="text-emerald-700">Username</dt>
                  <dd className="truncate font-mono">{settings?.dbUser}</dd>
                  <dt className="text-emerald-700">SSL</dt>
                  <dd>{settings?.dbSsl ? 'Enabled' : 'Disabled'}</dd>
                  <dt className="text-emerald-700">Password</dt>
                  <dd>{settings?.hasDbPassword ? 'Stored securely (never displayed)' : 'Not set'}</dd>
                </dl>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => setEditing(true)}>
              Reconfigure
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Changes to the database go through a change request and Super Admin approval. Your data is migrated and verified before the new database becomes active.
          </p>
          {requests.length > 0 && (
            <div className="mt-2">
              <h3 className="text-sm font-semibold mb-3">Request History</h3>
              <div className="space-y-2">
                {requests.map((req) => (
                  <RequestHistoryItem key={req.id} req={req} orgId={orgId} />
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5 text-primary" />
          Database Configuration
        </CardTitle>
        <CardDescription>
          {hasActiveDb ? (
            <div className="flex items-center gap-2 mt-1">
              <Badge className="bg-emerald-500/15 text-emerald-600">Custom Database Active</Badge>
              <span className="text-sm text-muted-foreground">
                Your organization is using a dedicated PostgreSQL database.
              </span>
            </div>
          ) : (
            <div className="mt-1">
              <Badge variant="secondary">Platform Database</Badge>
              <p className="text-sm text-muted-foreground mt-1">
                OmniSight is using the platform-managed database. No database setup is required from you.
              </p>
            </div>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {connected && editing && (
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 p-3">
            <div className="text-sm">
              <span className="font-medium">Reconfiguring the connected database.</span>{' '}
              <span className="text-muted-foreground">The current database stays active until a new one is migrated and verified.</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        )}
        {/* Platform Database Default State */}
        {!hasActiveDb && !useOwnDb && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-emerald-900">Platform Database (Recommended)</p>
                <p className="text-sm text-emerald-800 mt-1">
                  Your organization is using OmniSight&apos;s managed database. No setup or maintenance is required from you. This is the recommended option for most organizations.
                </p>
                <p className="text-sm text-emerald-700 mt-2">
                  Want to use your own PostgreSQL database instead? Toggle the switch below.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Use My Own Database Toggle */}
        <div className="flex items-center justify-between rounded-lg border border-border/60 p-4">
          <div>
            <div className="font-medium">Use my own database</div>
            <p className="text-sm text-muted-foreground">
              Point analytics at a PostgreSQL database you control
            </p>
          </div>
          <Switch checked={useOwnDb} onCheckedChange={setUseOwnDb} />
        </div>

        {/* What You Need Checklist */}
        {useOwnDb && (
          <div className="space-y-4">
            <HelpPanel title="Before you start — what you'll need">
              <p className="font-medium text-foreground">You will need a PostgreSQL database with these details:</p>
              <ul className="mt-2 space-y-1 list-disc list-inside">
                <li><strong>Host</strong> — the server address (e.g., <code>db.example.com</code>)</li>
                <li><strong>Port</strong> — usually 5432</li>
                <li><strong>Database name</strong> — the name of the database to use</li>
                <li><strong>Username</strong> — a database user OmniSight can connect with</li>
                <li><strong>Password</strong> — the password for that user</li>
                <li><strong>SSL</strong> — whether your database requires encrypted connections</li>
              </ul>
              <div className="mt-3 pt-3 border-t border-border/60">
                <p className="font-medium text-foreground">Don&apos;t have a PostgreSQL database?</p>
                <ul className="mt-1 space-y-1 list-disc list-inside">
                  <li>You don&apos;t need one if you&apos;re happy using the Platform Database.</li>
                  <li>If your organization has an IT or infrastructure team, ask them for these details.</li>
                  <li>If you use a managed database service (e.g., AWS RDS, Google Cloud SQL, Azure Database), open that service&apos;s connection settings page.</li>
                </ul>
              </div>
            </HelpPanel>

            {/* Database Form Fields */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="db-host">Database Host</Label>
                <Input id="db-host" value={dbHost} onChange={(e) => setDbHost(e.target.value)} placeholder="db.example.com" />
                <p className="text-xs text-muted-foreground">
                  The server address where your PostgreSQL database is running.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="db-port">Port</Label>
                <Input id="db-port" value={dbPort} onChange={(e) => setDbPort(e.target.value)} placeholder="5432" inputMode="numeric" />
                <p className="text-xs text-muted-foreground">
                  PostgreSQL normally uses port 5432. Use the port provided by your database administrator.
                </p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="db-name">Database Name</Label>
                <Input id="db-name" value={dbName} onChange={(e) => setDbName(e.target.value)} placeholder="omnisight_analytics" />
                <p className="text-xs text-muted-foreground">
                  The name of the PostgreSQL database OmniSight should use.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="db-user">Username</Label>
                <Input id="db-user" value={dbUser} onChange={(e) => setDbUser(e.target.value)} placeholder="postgres" />
                <p className="text-xs text-muted-foreground">
                  A database user that OmniSight can use to connect.
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="db-password">Password</Label>
              <Input
                id="db-password"
                type="password"
                value={dbPassword}
                onChange={(e) => setDbPassword(e.target.value)}
                placeholder={settings?.hasDbPassword ? 'Stored password set' : 'Enter password'}
              />
              <p className="text-xs text-muted-foreground">
                {settings?.hasDbPassword
                  ? 'Leave as-is to keep the stored password; enter a new one to replace it.'
                  : 'Stored encrypted at rest. Never displayed after saving.'}
              </p>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-border/60 p-3">
              <div>
                <div className="text-sm font-medium">Use SSL</div>
                <p className="text-xs text-muted-foreground">
                  Use SSL when your database provider requires encrypted connections. If you&apos;re unsure, ask your database administrator.
                </p>
              </div>
              <Switch checked={dbSsl} onCheckedChange={setDbSsl} />
            </div>
          </div>
        )}

        {/* Test Connection Result */}
        {testResult && (
          <div className={`rounded-lg border p-3 text-sm ${testResult.status === 'success' || testResult.status === 'connected'
            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
            : testResult.status === 'not_configured'
              ? 'bg-slate-50 border-slate-200 text-slate-700'
              : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}>
            <div className="flex items-center gap-2">
              <StatusIcon status={testResult.status} />
              <span className="font-medium">{testResult.message}</span>
            </div>
            {testResult.status === 'failed' && (
              <p className="mt-2 text-xs">
                Please check your connection details, or ask your database administrator to verify that the database allows connections from OmniSight.
              </p>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          <Button onClick={handleSubmit} disabled={saving || !configFingerprint}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Submit Change Request
          </Button>
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Test Connection
          </Button>
        </div>

        {/* Test Connection Explanation */}
        {useOwnDb && (
          <p className="text-xs text-muted-foreground">
            {configFingerprint
              ? 'Connection tested successfully. You can now submit this configuration for Super Admin approval.'
              : 'Test Connection checks whether OmniSight can securely connect to the database using the details you provided. You must test before submitting.'}
          </p>
        )}

        {/* Request History */}
        {requests.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold mb-3">Request History</h3>
            <div className="space-y-2">
              {requests.map((req) => (
                <RequestHistoryItem key={req.id} req={req} orgId={orgId} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StorageConfig({ orgId }: { orgId: string }) {
  // Presentation-only: whether the user asked to reopen the full form while
  // custom storage is CONNECTED. Connection state itself comes from the
  // backend via settingsQuery; this flag never overrides it, so a refresh
  // while connected still shows the Connected card.
  const [editing, setEditing] = useState(false);
  const [driver, setDriver] = useState<'local' | 'supabase'>('local');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ status: string; message: string } | null>(null);
  const [configFingerprint, setConfigFingerprint] = useState<string | null>(null);

  const settingsQuery = useQuery<OrgSettings>({
    queryKey: ['org-settings', orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load settings');
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 30_000,
  });

  const requestsQuery = useQuery<{ requests: ChangeRequest[] }>({
    queryKey: ['infra-requests', orgId, 'STORAGE'],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings/storage/requests`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load requests');
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 15_000,
  });

  useEffect(() => {
    const data = settingsQuery.data;
    if (data && !loaded) {
      setDriver(data.storageDriver === 'supabase' ? 'supabase' : 'local');
      setUrl(data.storageUrl ?? '');
      setKey(data.hasStorageKey ? KEEP_KEY : '');
      setLoaded(true);
    }
  }, [settingsQuery.data, loaded]);

  // Clear test result when any config field changes (test is no longer valid).
  const testedConfigRef = useRef<string | null>(null);

  useEffect(() => {
    const currentConfig = JSON.stringify({ driver, url, key });
    if (testedConfigRef.current !== null && testedConfigRef.current !== currentConfig) {
      setTestResult(null);
      setConfigFingerprint(null);
      testedConfigRef.current = null;
    }
  }, [driver, url, key]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = {};
      if (driver === 'supabase') {
        body.storageDriver = 'supabase';
        if (url) body.storageUrl = url;
        if (key && key !== KEEP_KEY) body.storageKey = key;
      } else {
        body.storageDriver = 'local';
      }
      let res: Response;
      try {
        res = await fetch(`/api/organizations/${orgId}/settings/storage/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
      } catch {
        // The API itself was unreachable — do NOT mislabel this as a storage failure.
        setTestResult({ status: 'failed', message: 'Connection test unavailable' });
        toast.error('Connection test unavailable', {
          description: 'OmniSight could not reach the server. Please check your connection and try again.',
        });
        return;
      }
      const data = await res.json().catch(() => null);
      if (!data) {
        setTestResult({ status: 'failed', message: 'Connection test unavailable' });
        toast.error('Connection test unavailable', {
          description: 'OmniSight could not reach the server. Please check your connection and try again.',
        });
        return;
      }
      if (!res.ok) {
        const message = typeof data.error === 'string' ? data.error : 'Storage test failed';
        setTestResult({ status: 'failed', message });
        toast.error('Connection failed', { description: message });
        return;
      }
      const status = data.status ?? 'failed';
      const message = typeof data.message === 'string' && data.message ? data.message : 'Storage test failed';
      setTestResult({ status, message });
      if (status === 'success' || status === 'connected') {
        const fp = data.configFingerprint;
        if (fp) {
          setConfigFingerprint(fp);
          testedConfigRef.current = JSON.stringify({ driver, url, key });
        }
        toast.success('Connection successful', { description: 'OmniSight can connect to this storage.' });
      } else if (status === 'not_configured') {
        toast.info(message);
      } else {
        toast.error('Connection failed', { description: message });
      }
    } finally {
      setTesting(false);
    }
  };

  const handleSubmit = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { storageDriver: driver };
      if (driver === 'supabase') {
        body.storageUrl = url || null;
        if (key && key !== KEEP_KEY) body.storageKey = key;
      }
      body.configFingerprint = configFingerprint ?? undefined;
      const res = await fetch(`/api/organizations/${orgId}/settings/storage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to submit change request');
        return;
      }
      if (data.unchanged) {
        toast.info(data.message || 'Configuration is already active');
      } else {
        toast.success('Change request submitted — awaiting Super Admin approval');
        requestsQuery.refetch();
      }
    } catch {
      toast.error('Network error');
    } finally {
      setSaving(false);
    }
  };

  const requests = requestsQuery.data?.requests ?? [];
  const settings = settingsQuery.data;
  const isSupabaseActive = settings?.storageDriver === 'supabase';
  // Source of truth = the backend's serialized settings (GET /settings).
  // "connected" means the custom storage is active AND its last verified test
  // passed — i.e. activation already happened after a verified migration.
  const connected = settings?.storageDriver === 'supabase' && settings.storageTestStatus === 'success';

  // ── CONNECTED state: compact card, no credentials (the backend never
  // returns the service-role key; only hasStorageKey is known here).
  if (connected && !editing) {
    return (
      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-primary" />
            Storage Configuration
          </CardTitle>
          <CardDescription>
            <div className="flex items-center gap-2 mt-1">
              <Badge className="bg-emerald-500/15 text-emerald-600">Connected</Badge>
              <span className="text-sm text-muted-foreground">
                Your organization operates on its own Supabase storage project.
              </span>
            </div>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="font-medium text-emerald-900">Using your configured storage</p>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-emerald-800">
                  <dt className="text-emerald-700">Supabase Project URL</dt>
                  <dd className="truncate font-mono">{settings?.storageUrl}</dd>
                  <dt className="text-emerald-700">Service-Role Key</dt>
                  <dd>{settings?.hasStorageKey ? 'Stored securely (never displayed)' : 'Not set'}</dd>
                </dl>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" onClick={() => setEditing(true)}>
              Reconfigure
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Changes to storage go through a change request and Super Admin approval. Your organization&apos;s files are migrated and verified before the new storage becomes active.
          </p>
          {requests.length > 0 && (
            <div className="mt-2">
              <h3 className="text-sm font-semibold mb-3">Request History</h3>
              <div className="space-y-2">
                {requests.map((req) => (
                  <RequestHistoryItem key={req.id} req={req} orgId={orgId} />
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="h-5 w-5 text-primary" />
          Storage Configuration
        </CardTitle>
        <CardDescription>
          {isSupabaseActive ? (
            <div className="flex items-center gap-2 mt-1">
              <Badge className="bg-emerald-500/15 text-emerald-600">Custom Storage Active</Badge>
              <span className="text-sm text-muted-foreground">
                Your organization is using a dedicated Supabase storage project.
              </span>
            </div>
          ) : (
            <div className="mt-1">
              <Badge variant="secondary">Platform Storage</Badge>
              <p className="text-sm text-muted-foreground mt-1">
                OmniSight is using the platform-managed storage. No storage setup is required from you.
              </p>
            </div>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {connected && editing && (
          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 p-3">
            <div className="text-sm">
              <span className="font-medium">Reconfiguring the connected storage.</span>{' '}
              <span className="text-muted-foreground">The current storage stays active until a new one is migrated and verified.</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        )}
        {/* Platform Storage Default State */}
        {!isSupabaseActive && driver === 'local' && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium text-emerald-900">Platform Storage (Recommended)</p>
                <p className="text-sm text-emerald-800 mt-1">
                  Your organization is using OmniSight&apos;s managed storage for screenshots and binary data. No setup is required.
                </p>
                <p className="text-sm text-emerald-700 mt-2">
                  Want to use your own Supabase storage project instead? Select &quot;Supabase (Customer)&quot; below.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* What Is Storage? */}
        <HelpPanel title="What is organization storage?">
          <p>
            Storage is where OmniSight saves screenshots and binary data for your organization.
          </p>
          <ul className="mt-2 space-y-1 list-disc list-inside">
            <li><strong>Platform Storage</strong> — Managed by OmniSight. No setup required. Recommended for most organizations.</li>
            <li><strong>Supabase (Customer)</strong> — Your own Supabase project. Choose this only if your organization already has a Supabase project or your IT team can provide one.</li>
          </ul>
        </HelpPanel>

        {/* Storage Driver Selection */}
        <div className="space-y-2">
          <Label>Storage Driver</Label>
          <Select value={driver} onValueChange={(v) => setDriver(v as 'local' | 'supabase')}>
            <SelectTrigger>
              <SelectValue placeholder="Select driver" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Platform Storage (Managed)</SelectItem>
              <SelectItem value="supabase">Supabase (Customer)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {driver === 'local'
              ? 'Use the platform-managed storage pool — no additional configuration needed.'
              : 'Point screenshots and binary data at your own Supabase storage project.'}
          </p>
        </div>

        {/* Supabase Configuration */}
        {driver === 'supabase' && (
          <div className="space-y-4">
            <HelpPanel title="What you'll need for Supabase storage">
              <p className="font-medium text-foreground">You will need:</p>
              <ul className="mt-2 space-y-1 list-disc list-inside">
                <li><strong>Supabase Project URL</strong> — found in your Supabase project settings under &quot;API&quot;</li>
                <li><strong>Service-Role Key</strong> — found in the same settings page (keep this secret)</li>
              </ul>
              <div className="mt-3 pt-3 border-t border-border/60">
                <p className="font-medium text-foreground">Don&apos;t have a Supabase project?</p>
                <ul className="mt-1 space-y-1 list-disc list-inside">
                  <li>You don&apos;t need one if you&apos;re happy using Platform Storage.</li>
                  <li>If your organization has an IT team, ask them for Supabase project details.</li>
                </ul>
              </div>
            </HelpPanel>

            <div className="space-y-2">
              <Label htmlFor="storage-url">Supabase Project URL</Label>
              <Input
                id="storage-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-project.supabase.co"
              />
              <p className="text-xs text-muted-foreground">
                Found in your Supabase project settings under &quot;API&quot; &gt; &quot;Project URL&quot;.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="storage-key">Service-Role Key</Label>
              <Input
                id="storage-key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={settings?.hasStorageKey ? 'Stored key set' : 'Enter service-role key'}
              />
              <p className="text-xs text-muted-foreground">
                {settings?.hasStorageKey
                  ? 'Leave as-is to keep the stored key; enter a new one to replace it.'
                  : 'Found in Supabase project settings under &quot;API&quot; &gt; &quot;service_role key&quot;. Stored encrypted at rest. Never displayed after saving.'}
              </p>
            </div>
          </div>
        )}

        {/* Test Connection Result */}
        {testResult && (
          <div className={`rounded-lg border p-3 text-sm ${testResult.status === 'success' || testResult.status === 'connected'
            ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
            : testResult.status === 'not_configured'
              ? 'bg-slate-50 border-slate-200 text-slate-700'
              : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}>
            <div className="flex items-center gap-2">
              <StatusIcon status={testResult.status} />
              <span className="font-medium">{testResult.message}</span>
            </div>
            {testResult.status === 'failed' && (
              <p className="mt-2 text-xs">
                Please check your Supabase project URL and service-role key, or ask your database administrator to verify the credentials.
              </p>
            )}
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          <Button onClick={handleSubmit} disabled={saving || !configFingerprint}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Submit Change Request
          </Button>
          <Button variant="outline" onClick={handleTest} disabled={testing}>
            {testing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Test Connection
          </Button>
        </div>

        {/* Test Connection Explanation */}
        {driver === 'supabase' && (
          <p className="text-xs text-muted-foreground">
            {configFingerprint
              ? 'Connection tested successfully. You can now submit this configuration for Super Admin approval.'
              : 'Test Connection checks whether OmniSight can securely connect to your Supabase storage. You must test before submitting.'}
          </p>
        )}

        {/* Request History */}
        {requests.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-semibold mb-3">Request History</h3>
            <div className="space-y-2">
              {requests.map((req) => (
                <RequestHistoryItem key={req.id} req={req} orgId={orgId} />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
