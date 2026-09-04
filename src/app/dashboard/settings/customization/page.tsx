'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Save, PlugZap, Database, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useCurrentUser } from '@/hooks/use-current-user';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useQuery } from '@tanstack/react-query';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const AI_PROVIDERS = ['openai', 'anthropic', 'groq', 'google', 'mistral', 'ollama', 'custom'];
const KEEP_KEY = '••••••';

interface OrgSettings {
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
  aiTestStatus: string | null;
  dbTestStatus: string | null;
}

function TestBadge({ status }: { status: string | null }) {
  if (!status) return null;
  return status === 'connected' || status === 'success' ? (
    <Badge className="bg-emerald-500/15 text-emerald-600">Connected</Badge>
  ) : status === 'not_configured' ? (
    <Badge variant="secondary">Not configured</Badge>
  ) : (
    <Badge className="bg-rose-500/15 text-rose-600">Failed</Badge>
  );
}

export default function CustomizationPage() {
  const router = useRouter();
  const { user, org, isLoading: authLoading } = useCurrentUser();
  const orgId = org?.id ?? '';

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  // Standard org config page supports org_admin/owner/super_admin.
  const [loaded, setLoaded] = useState(false);

  // AI fields
  const [aiProvider, setAiProvider] = useState<string>('openai');
  const [aiKey, setAiKey] = useState('');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiModel, setAiModel] = useState('');
  // DB fields
  const [useOwnDb, setUseOwnDb] = useState(false);
  const [dbHost, setDbHost] = useState('');
  const [dbPort, setDbPort] = useState<string>('5432');
  const [dbName, setDbName] = useState('');
  const [dbUser, setDbUser] = useState('');
  const [dbPassword, setDbPassword] = useState('');
  const [dbSsl, setDbSsl] = useState(false);

  const [savingAi, setSavingAi] = useState(false);
  const [savingDb, setSavingDb] = useState(false);
  const [testing, setTesting] = useState<'ai' | 'db' | null>(null);

  const settingsQuery = useQuery<{ data: OrgSettings }>({
    queryKey: ['org-settings', orgId],
    queryFn: async () => {
      const res = await fetch(`/api/organizations/${orgId}/settings`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load settings');
      return res.json();
    },
    enabled: !!orgId,
    staleTime: 30 * 1000,
  });

  useEffect(() => {
    const data = settingsQuery.data?.data;
    if (data && !loaded) {
      setAiProvider(data.aiProvider ?? 'openai');
      setAiKey(data.hasAiKey ? KEEP_KEY : '');
      setAiBaseUrl(data.aiBaseUrl ?? '');
      setAiModel(data.aiModel ?? '');
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

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background p-8">
        <Skeleton className="h-10 w-72 mb-6" />
        <Skeleton className="h-56 w-full mb-6 rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (!user) return null;

  if (!['super_admin', 'owner', 'admin', 'org_admin'].includes(user.role)) {
    return (
      <div className="p-8 text-center">
        <ShieldAlert className="mx-auto h-10 w-10 text-destructive" />
        <h1 className="mt-4 text-2xl font-bold">Admin Only</h1>
        <p className="mt-2 text-muted-foreground">Only organization admins can configure customization.</p>
      </div>
    );
  }

  const saveAi = async () => {
    setSavingAi(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/settings/ai`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          aiProvider,
          aiApiKey: aiKey && aiKey !== KEEP_KEY ? aiKey : undefined,
          aiBaseUrl,
          aiModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to save AI settings');
        return;
      }
      toast.success('AI settings saved');
      if (aiKey && aiKey !== KEEP_KEY) {
        setAiKey(KEEP_KEY);
        settingsQuery.refetch();
      }
    } catch {
      toast.error('Network error');
    } finally {
      setSavingAi(false);
    }
  };

  const testAi = async () => {
    setTesting('ai');
    try {
      const res = await fetch(`/api/organizations/${orgId}/settings/ai/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          provider: aiProvider,
          apiKey: aiKey && aiKey !== KEEP_KEY ? aiKey : undefined,
          baseUrl: aiBaseUrl || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'AI test failed');
        return;
      }
      if (data.data?.status === 'connected') {
        toast.success('AI connection successful');
      } else {
        toast.error(data.data?.message || 'AI connection failed');
      }
      settingsQuery.refetch();
    } catch {
      toast.error('Network error');
    } finally {
      setTesting(null);
    }
  };

  const saveDb = async () => {
    setSavingDb(true);
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
          dbPassword: dbPassword && dbPassword !== KEEP_KEY ? dbPassword : dbPassword === '' && !useOwnDb ? undefined : undefined,
          dbSsl,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to save database settings');
        return;
      }
      toast.success('Database settings saved');
      if (dbPassword && dbPassword !== KEEP_KEY) {
        setDbPassword('');
        settingsQuery.refetch();
      }
    } catch {
      toast.error('Network error');
    } finally {
      setSavingDb(false);
    }
  };

  const testDb = async () => {
    setTesting('db');
    try {
      const res = await fetch(`/api/organizations/${orgId}/settings/database/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Database test failed');
        return;
      }
      if (data.data?.status === 'connected') {
        toast.success('Database connection successful');
      } else {
        toast.error(data.data?.message || 'Database connection failed');
      }
      settingsQuery.refetch();
    } catch {
      toast.error('Network error');
    } finally {
      setTesting(null);
    }
  };

  const settings = settingsQuery.data?.data;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-bold tracking-tight">Customization</h1>
      <p className="mt-1.5 text-muted-foreground">
        Per-organization AI provider and analytics database configuration.
      </p>

      {/* AI Provider */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PlugZap className="h-5 w-5 text-primary" />
            AI Provider
          </CardTitle>
          <CardDescription>
            Choose which AI provider powers insights for this organization. Your
            API key is encrypted at rest.
            <span className="mt-2 flex">
              <TestBadge status={settings?.aiTestStatus ?? null} />
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ai-provider">Provider</Label>
              <Select value={aiProvider} onValueChange={setAiProvider}>
                <SelectTrigger id="ai-provider">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {AI_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ai-model">Model</Label>
              <Input id="ai-model" value={aiModel} onChange={(e) => setAiModel(e.target.value)} placeholder="gpt-4o, claude-3-haiku…" />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-key">API Key</Label>
            <Input
              id="ai-key"
              type="password"
              value={aiKey}
              onChange={(e) => setAiKey(e.target.value)}
              placeholder={settings?.hasAiKey ? `Stored key ends in ${settings.aiApiKeyLast4 ?? '••••'}` : 'Enter API key'}
            />
            <p className="text-xs text-muted-foreground">
              {settings?.hasAiKey ? 'Leave as-is to keep the stored key; enter a new key to replace it.' : 'Required for cloud providers.'}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-base-url">Base URL (optional)</Label>
            <Input id="ai-base-url" value={aiBaseUrl} onChange={(e) => setAiBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
          </div>

          <div className="flex flex-wrap gap-3">
            <Button onClick={saveAi} disabled={savingAi}>
              {savingAi ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save AI Settings
            </Button>
            <Button variant="outline" onClick={testAi} disabled={testing !== null}>
              {testing === 'ai' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Test Connection
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Analytics Database */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5 text-primary" />
            Analytics Database
          </CardTitle>
          <CardDescription>
            Optionally point high-volume analytics data at a dedicated database
            you manage. Leave off to use the platform cloud database.
            <span className="mt-2 flex">
              <TestBadge status={settings?.dbTestStatus ?? null} />
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between rounded-lg border border-border/60 p-4">
            <div>
              <div className="font-medium">Use my own analytics database</div>
              <p className="text-sm text-muted-foreground">Self-hosted / BYODB</p>
            </div>
            <Switch checked={useOwnDb} onCheckedChange={setUseOwnDb} />
          </div>

          {useOwnDb && (
            <div className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="db-host">Host</Label>
                  <Input id="db-host" value={dbHost} onChange={(e) => setDbHost(e.target.value)} placeholder="db.example.com" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="db-port">Port</Label>
                  <Input id="db-port" value={dbPort} onChange={(e) => setDbPort(e.target.value)} placeholder="5432" inputMode="numeric" />
                </div>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="db-name">Database Name</Label>
                  <Input id="db-name" value={dbName} onChange={(e) => setDbName(e.target.value)} placeholder="omnisight_analytics" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="db-user">User</Label>
                  <Input id="db-user" value={dbUser} onChange={(e) => setDbUser(e.target.value)} placeholder="postgres" />
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
                  {settings?.hasDbPassword ? 'Leave as-is to keep the stored password; enter a new one to replace it.' : 'Stored encrypted at rest.'}
                </p>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border/60 p-4">
                <div>
                  <div className="text-sm font-medium">Use SSL</div>
                  <p className="text-sm text-muted-foreground">Require an encrypted connection (sslmode=require)</p>
                </div>
                <Switch checked={dbSsl} onCheckedChange={setDbSsl} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <Button onClick={saveDb} disabled={savingDb}>
              {savingDb ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save Database Settings
            </Button>
            <Button variant="outline" onClick={testDb} disabled={testing !== null}>
              {testing === 'db' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Test Connection
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
