'use client';

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Download, Hammer, KeyRound, Loader2, Save, ShieldAlert, Trash2, Wrench } from 'lucide-react';
import { validateServerUrl } from '@/lib/agent-server-url';

interface AgentSoftwareConfig {
  serverUrl: string;
  enrollmentCodeEnabled: boolean;
  guestPendingLimit: number;
  pendingGuestCount: number;
  remaining: number;
  agentVersion: string;
}

interface AgentBuildMeta {
  id: string;
  serverUrl: string;
  enrollmentCodeBaked: boolean;
  agentVersion: string;
  status: string; // pending | building | completed | failed
  sha256?: string | null;
  fileName?: string | null;
  error?: string | null;
  requestedBy?: string;
  createdAt: string;
  completedAt?: string | null;
}

interface AgentSoftwareData {
  config: AgentSoftwareConfig;
  lastBuild: AgentBuildMeta | null;
  builds: AgentBuildMeta[];
}

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-300',
  building: 'bg-blue-50 text-blue-700 border-blue-300',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  failed: 'bg-rose-50 text-rose-700 border-rose-300',
};

function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return '—';
  }
}

/**
 * Settings → Agent Software.
 *
 * Admin-only surface for building the OmniSight Agent EXE for the deployment.
 * Shows the configured server URL, enrollment-code status, agent version and
 * recent build history; actions: save server URL, issue/rotate or disable the
 * enrollment code, and trigger a build.
 *
 * SECURITY: the enrollment code is NEVER displayed here — it is returned
 * exactly once at issuance (POST /api/organization/enrollment-code) and only
 * the enabled/disabled status is shown. Build records expose metadata +
 * SHA-256 only (no plaintext code is ever stored).
 */
export function AgentSoftwareCard() {
  const queryClient = useQueryClient();
  const [serverUrl, setServerUrl] = useState('');
  const [buildCode, setBuildCode] = useState('');
  const [guestPendingLimit, setGuestPendingLimit] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [justIssuedCode, setJustIssuedCode] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['agent-software'],
    queryFn: async () => {
      const res = await fetch('/api/agent-software');
      if (!res.ok) throw new Error('Failed to load agent software settings');
      return (await res.json()) as AgentSoftwareData;
    },
  });

  const config = data?.config;
  const lastBuild = data?.lastBuild;
  const builds = data?.builds ?? [];
  // Client-side preview of the same env-aware policy the API enforces. In a
  // production deploy NODE_ENV is inlined as "production" (https only); in dev
  // it stays "development" (loopback http allowed).
  const isDevelopment = process.env.NODE_ENV !== 'production';

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['agent-software'] });
  }, [queryClient]);

  const saveServerUrl = async () => {
    const value = serverUrl.trim();
    const check = validateServerUrl(value);
    if (!check.ok) {
      toast.error(check.error);
      return;
    }
    setBusy('save-url');
    try {
      const res = await fetch('/api/agent-software', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl: check.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to save server URL');
      toast.success('Agent server URL saved');
      setServerUrl('');
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save server URL');
    } finally {
      setBusy(null);
    }
  };

  const issueCode = async () => {
    setBusy('issue-code');
    try {
      const res = await fetch('/api/organization/enrollment-code', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to issue enrollment code');
      setJustIssuedCode(body.code as string);
      toast.success('Enrollment code issued — copy it now; it is shown only once');
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to issue enrollment code');
    } finally {
      setBusy(null);
    }
  };

  const disableCode = async () => {
    setBusy('disable-code');
    try {
      const res = await fetch('/api/organization/enrollment-code', { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Failed to disable enrollment code');
      toast.success('Zero-touch enrollment code disabled — anonymous discovers will fail closed');
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to disable enrollment code');
    } finally {
      setBusy(null);
    }
  };

  const saveGuestPendingLimit = async () => {
    const value = guestPendingLimit.trim();
    if (!value) {
      toast.error('Enter a whole number between 1 and 1000.');
      return;
    }
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      toast.error('Enter a whole number between 1 and 1000.');
      return;
    }
    setBusy('save-guest-limit');
    try {
      const res = await fetch('/api/agent-software', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestPendingLimit: n }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not update the guest enrollment limit.');
      toast.success('Guest enrollment limit saved');
      setGuestPendingLimit('');
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update the guest enrollment limit.');
    } finally {
      setBusy(null);
    }
  };

  const triggerBuild = async () => {
    setBusy('build');
    try {
      const body: Record<string, string> = {};
      if (buildCode.trim()) body.enrollmentCode = buildCode.trim();
      const res = await fetch('/api/agent-software/build', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const parsed = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(parsed.error || 'Failed to start build');
      toast.success(parsed.status === 'pending' ? 'Build started — you will be notified when it completes' : parsed.message || 'Build requested');
      setBuildCode('');
      invalidate();
      // Poll the build record to completion so the card updates live.
      const buildId = parsed.buildId as string;
      if (buildId) {
        const poll = setInterval(async () => {
          const r = await fetch(`/api/agent-software/builds/${buildId}`);
          if (!r.ok) return;
          const b = (await r.json()) as { data: AgentBuildMeta };
          invalidate();
          if (b.data?.status === 'completed' || b.data?.status === 'failed') {
            clearInterval(poll);
          }
        }, 5000);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start build');
    } finally {
      setBusy(null);
    }
  };

  const download = async (buildId: string) => {
    setBusy(`dl-${buildId}`);
    try {
      const res = await fetch(`/api/agent-software/builds/${buildId}/download`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Download failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `OmniSightAgent-${buildId}.exe`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setBusy(null);
    }
  };

  if (isLoading) {
    return (
      <Card className="falcon-card">
        <CardContent className="p-6 space-y-3">
          <div className="h-8 bg-muted/30 rounded animate-pulse" />
          <div className="h-8 bg-muted/30 rounded animate-pulse" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="falcon-card">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="w-1 h-8 rounded-full bg-info" />
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-info/10 flex items-center justify-center">
              <Hammer className="w-4 h-4 text-info" />
            </div>
            <div>
              <CardTitle className="text-sm font-semibold">Agent Software</CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                Build the OmniSight Agent installer for this deployment
              </p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Configuration summary */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Agent Version</p>
            <p className="text-sm font-medium mt-0.5">v{config?.agentVersion ?? '—'}</p>
          </div>
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Enrollment Code</p>
            <p className="text-sm font-medium mt-0.5">
              {config?.enrollmentCodeEnabled ? (
                <Badge className="bg-emerald-50 text-emerald-700 border-emerald-300">Enabled</Badge>
              ) : (
                <Badge variant="outline" className="text-muted-foreground">Disabled</Badge>
              )}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Pending Guest Limit</p>
            <p className="text-sm font-medium mt-0.5">{config?.guestPendingLimit ?? '—'} per org</p>
          </div>
        </div>

        {/* Server URL */}
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Server URL</Label>
          <div className="flex gap-2">
            <Input
              value={serverUrl || config?.serverUrl || ''}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://agents.example.com"
              className="h-9 font-mono text-xs flex-1"
              aria-label="Agent server URL"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-9 gap-1.5"
              onClick={saveServerUrl}
              disabled={busy !== null}
            >
              {busy === 'save-url' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {isDevelopment
              ? 'Agents connect to this address. http://localhost is allowed for local development builds; production deployments require HTTPS.'
              : 'Agents connect to this address. HTTPS is required in production; public server URLs must always use HTTPS.'}
          </p>
        </div>

        {/* Guest Enrollment */}
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Guest Enrollment</Label>
          <div className="rounded-lg border border-amber-200 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-900/10 p-3 space-y-2">
            <div className="flex items-start gap-2">
              <Badge className="bg-amber-100 text-amber-800 border-amber-300 shrink-0 mt-0.5">Guest</Badge>
              <div className="flex-1">
                <p className="text-sm font-medium">Pending Guest Requests</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Maximum number of guest enrollment requests that can wait for administrator approval at the same time.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Label className="text-sm font-medium shrink-0">Maximum pending guest enrollment requests:</Label>
              <Input
                value={guestPendingLimit ? guestPendingLimit : (config?.guestPendingLimit?.toString() ?? '20')}
                onChange={(e) => setGuestPendingLimit(e.target.value)}
                type="number"
                min={1}
                max={1000}
                className="h-9 font-mono text-xs w-24"
                aria-label="Guest pending limit"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                onClick={saveGuestPendingLimit}
                disabled={busy !== null}
              >
                {busy === 'save-guest-limit' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Current usage: <span className="font-mono">{config?.pendingGuestCount ?? 0}</span> / <span className="font-mono">{config?.guestPendingLimit ?? 20}</span> pending
              {config?.remaining !== undefined && config?.remaining === 0 && (
                <span className="text-rose-600 ml-1.5">· Limit reached</span>
              )}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Only new pending requests are blocked when this limit is reached. Existing active guests are not affected.
              Changing this number does NOT require rebuilding the desktop agent.
            </p>
          </div>
        </div>

        {/* Enrollment code management */}
        <div className="rounded-lg border border-amber-200 dark:border-amber-800/40 bg-amber-50 dark:bg-amber-900/10 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <KeyRound className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" />
            <div className="flex-1">
              <p className="text-sm font-medium">Zero-Touch Enrollment Code</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Agents built with this code enroll automatically (no employee ID needed). The code is stored only as a hash and shown once at issuance.
              </p>
            </div>
          </div>
          {justIssuedCode && (
            <div className="rounded-md border border-amber-300 bg-white dark:bg-amber-900/20 p-2.5">
              <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">Copy this now — it will not be shown again</p>
              <p className="font-mono text-sm break-all mt-1 select-all">{justIssuedCode}</p>
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={issueCode} disabled={busy !== null}>
              {busy === 'issue-code' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
              {config?.enrollmentCodeEnabled ? 'Rotate Code' : 'Issue Code'}
            </Button>
            {config?.enrollmentCodeEnabled && (
              <Button size="sm" variant="outline" className="h-8 gap-1.5 text-rose-600 border-rose-300 hover:bg-rose-50" onClick={disableCode} disabled={busy !== null}>
                {busy === 'disable-code' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                Disable
              </Button>
            )}
          </div>
        </div>

        {/* Build action */}
        <div className="space-y-1.5">
          <Label className="text-sm font-medium">Build OmniSight Agent</Label>
          <div className="flex gap-2">
            <Input
              value={buildCode}
              onChange={(e) => setBuildCode(e.target.value)}
              placeholder="Enrollment code to bake (optional)"
              className="h-9 font-mono text-xs flex-1"
              aria-label="Enrollment code to bake into the build"
            />
            <Button size="sm" className="h-9 gap-1.5" onClick={triggerBuild} disabled={busy !== null}>
              {busy === 'build' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Hammer className="w-3.5 h-3.5" />}
              Build Agent
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Produces OmniSightAgent.exe with the server URL and (optionally) the enrollment code baked in. One build per deployment — usable by all employees.
          </p>
        </div>

        {/* Last build status */}
        {lastBuild && (
          <div className="rounded-lg border bg-muted/30 px-3 py-2 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Last Build</p>
              <Badge variant="outline" className={`text-[10px] h-5 px-1.5 ${STATUS_STYLES[lastBuild.status] ?? ''}`}>{lastBuild.status}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {lastBuild.agentVersion} · {lastBuild.serverUrl}
              {lastBuild.enrollmentCodeBaked ? ' · code baked' : ''} · {fmtDate(lastBuild.createdAt)}
            </p>
            {lastBuild.sha256 && <p className="text-[10px] font-mono text-muted-foreground break-all">SHA-256: {lastBuild.sha256}</p>}
            {lastBuild.status === 'failed' && lastBuild.error && (
              <p className="text-xs text-rose-600 flex items-start gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                {lastBuild.error}
              </p>
            )}
            {lastBuild.status === 'completed' && (
              <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs mt-1" onClick={() => download(lastBuild.id)} disabled={busy !== null}>
                {busy === `dl-${lastBuild.id}` ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                Download Installer
              </Button>
            )}
          </div>
        )}

        {/* Build history */}
        {builds.length > 0 && (
          <div className="space-y-2">
            <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5">
              <Wrench className="w-3 h-3" /> Build History
            </p>
            <div className="divide-y divide-border rounded-lg border">
              {builds.map((b) => (
                <div key={b.id} className="flex items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">
                      v{b.agentVersion} · {b.serverUrl}
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      {fmtDate(b.createdAt)} · {b.enrollmentCodeBaked ? 'code baked' : 'no code'} · {b.sha256 ? `SHA-256 ${b.sha256.slice(0, 16)}…` : 'no artifact'}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Badge variant="outline" className={`text-[10px] h-5 px-1.5 ${STATUS_STYLES[b.status] ?? ''}`}>{b.status}</Badge>
                    {b.status === 'completed' && (
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => download(b.id)} disabled={busy !== null} aria-label="Download installer">
                        <Download className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
