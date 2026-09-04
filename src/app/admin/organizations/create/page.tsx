'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Copy, KeyRound, Loader2, ShieldCheck, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useCurrentUser } from '@/hooks/use-current-user';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface CreateResult {
  organization: { id: string; name: string; slug: string };
  admin: { email: string; name: string };
  tempPassword: string | null;
}

const FALLBACK_PLAN_OPTIONS = ['Free', 'Pro', 'Business', 'Enterprise_SelfHosted'];

export default function AdminCreateOrganizationPage() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useCurrentUser();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [password, setPassword] = useState('');
  const [plan, setPlan] = useState<string>('Free');
  const [planOptions, setPlanOptions] = useState<string[]>(FALLBACK_PLAN_OPTIONS);
  const [deploymentMode, setDeploymentMode] = useState<string>('MANAGED');
  const [initialStatus, setInitialStatus] = useState<string>('active');
  const [timezone, setTimezone] = useState('Asia/Dhaka');

  // Phase 2 §12: package list is database-driven (GET /api/plans), never
  // hardcoded. Fallback options apply only if the catalog is unreachable.
  useEffect(() => {
    fetch('/api/plans', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const names = (data?.data ?? data?.plans ?? [])
          .map((p: { name?: string }) => p?.name)
          .filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);
        if (names.length > 0) {
          setPlanOptions(names);
          setPlan((prev) => (names.includes(prev) ? prev : names[0]));
        }
      })
      .catch(() => null);
  }, []);

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreateResult | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  if (authLoading || !user) return null;

  if (user.role !== 'super_admin') {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <ShieldCheck className="mx-auto h-10 w-10 text-destructive" />
        <h1 className="mt-4 text-2xl font-bold">Super Admin Only</h1>
        <p className="mt-2 text-muted-foreground">
          You need super admin access to generate organizations and accounts.
        </p>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch('/api/admin/organizations/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          name,
          slug: slug || undefined,
          adminEmail,
          adminName: adminName || undefined,
          password: password || undefined,
          planName: plan,
          timezone,
          deploymentMode,
          status: initialStatus,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to create organization');
        return;
      }
      setResult(data.data);
      toast.success('Organization created');
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const copyPassword = async () => {
    if (!result?.tempPassword) return;
    try {
      await navigator.clipboard.writeText(result.tempPassword);
      toast.success('Temporary password copied');
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <a
        href="/admin/payments"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to admin
      </a>

      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">Create Organization</h1>
        <p className="mt-1.5 text-muted-foreground">
          Provision a complete workspace with an org admin account, subscription,
          and welcome email — ready to sign in.
        </p>
      </div>

      {result ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              Account Generated
            </CardTitle>
            <CardDescription>
              Relay these credentials to your new admin. The temporary password is
              shown <strong>once</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
                <Label className="text-xs text-muted-foreground">Organization</Label>
                <div className="mt-1 font-medium text-foreground">{result.organization.name}</div>
                <div className="text-sm text-muted-foreground">/{result.organization.slug}</div>
              </div>
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
                <Label className="text-xs text-muted-foreground">Admin Email</Label>
                <div className="mt-1 font-medium text-foreground break-all">{result.admin.email}</div>
              </div>
            </div>

            {result.tempPassword && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border bg-background p-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Temporary Password</Label>
                  <div className="mt-1 font-mono text-sm text-foreground break-all">
                    {result.tempPassword}
                  </div>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={copyPassword}>
                  <Copy className="mr-1.5 h-4 w-4" />
                  Copy
                </Button>
              </div>
            )}

            <p className="text-sm text-muted-foreground">
              {result.tempPassword
                ? 'Share the email + temporary password securely, then ask the admin to sign in and reset their password immediately.'
                : 'The admin will sign in with the password you provided.'}
            </p>

            <Button
              type="button"
              onClick={() => {
                setResult(null);
                setName('');
                setSlug('');
                setAdminEmail('');
                setAdminName('');
                setPassword('');
              }}
            >
              Create another
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-primary" />
              Organization Details
            </CardTitle>
            <CardDescription>
              Provide the organization name and the future org admin&apos;s email.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="org-name">Organization Name *</Label>
                  <Input
                    id="org-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Acme Inc."
                    required
                    minLength={2}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="org-slug">Slug (optional)</Label>
                  <Input
                    id="org-slug"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    placeholder="acme"
                  />
                </div>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="admin-email">Admin Email *</Label>
                  <Input
                    id="admin-email"
                    type="email"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                    placeholder="admin@company.com"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="admin-name">Admin Name</Label>
                  <Input
                    id="admin-name"
                    value={adminName}
                    onChange={(e) => setAdminName(e.target.value)}
                    placeholder="Jane Doe"
                  />
                </div>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="password">Set Password (optional)</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Leave blank to auto-generate"
                    minLength={8}
                  />
                  <p className="text-xs text-muted-foreground">
                    Min 8 chars. If blank, a secure temporary password is generated.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timezone">Timezone</Label>
                  <Input
                    id="timezone"
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                    placeholder="Asia/Dhaka"
                  />
                </div>
              </div>

              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="plan">Plan</Label>
                  <Select value={plan} onValueChange={setPlan}>
                    <SelectTrigger id="plan">
                      <SelectValue placeholder="Select a plan" />
                    </SelectTrigger>
                    <SelectContent>
                      {planOptions.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p.replace('_', ' ')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Free / self-hosted plans provision without an invoice. Paid plans
                    get a pending subscription + invoice (manual payment).
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="deployment-mode">Deployment Mode</Label>
                  <Select value={deploymentMode} onValueChange={setDeploymentMode}>
                    <SelectTrigger id="deployment-mode">
                      <SelectValue placeholder="Select deployment mode" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MANAGED">Managed (OmniSight-hosted)</SelectItem>
                      <SelectItem value="PRIVATE">Private (customer-hosted)</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Customer DB requires a configured primary database and cannot be
                    selected here.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="initial-status">Initial Status</Label>
                <Select value={initialStatus} onValueChange={setInitialStatus}>
                  <SelectTrigger id="initial-status">
                    <SelectValue placeholder="Select initial status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active (usable immediately)</SelectItem>
                    <SelectItem value="pending">Pending (locked until activated)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex gap-3 pt-2">
                <Button type="submit" className="flex-1" disabled={submitting}>
                  {submitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Creating…
                    </>
                  ) : (
                    'Create Organization'
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
