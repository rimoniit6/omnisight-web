'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, Loader2, ShieldCheck, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface ProvisionResult {
  organization: { id: string; name: string; slug: string };
  admin: { email: string; name: string };
  tempPassword: string | null;
}

/**
 * V1 Service Type options — map 1:1 to Organization.deploymentMode.
 *
 * PRIVATE is removed from V1 customer-facing workflows. Only MANAGED and
 * CUSTOMER_DB are selectable. A future enterprise/self-hosted mode may be
 * introduced in a later version.
 */
const SERVICE_OPTIONS = [
  {
    value: 'MANAGED',
    title: 'OmniSight Managed',
    description:
      'OmniSight hosts the application, database and storage. Best for customers who want a fully managed OmniSight service.',
  },
  {
    value: 'CUSTOMER_DB',
    title: 'Customer Database',
    description:
      'OmniSight hosts the application/API. The customer owns and manages the primary database. Database configuration is done after the Organization Admin logs in.',
  },
] as const;

interface ProvisionOrganizationFlowProps {
  /** When provided, the success card shows a "View Organization" action. */
  onViewOrg?: (org: { id: string; name: string }) => void;
}

/**
 * Full org provisioning flow — posts to POST /api/admin/organizations/create,
 * which provisions in one atomic step: Organization + org_admin AppUser +
 * OrganizationMembership + (paid plan → PENDING subscription + invoice).
 *
 * When no explicit password is supplied the server generates a temp password
 * returned ONCE in the response (mustChangePassword = true on the account) —
 * shown here with the first-login badge and copy action.
 *
 * Service Type (Organization.deploymentMode) is selectable at provisioning:
 * MANAGED | CUSTOMER_DB — persisted verbatim by the server (no
 * silent fallback). PRIVATE is not available in V1. CUSTOMER_DB orgs are
 * control-plane-provisioned; their data plane fails closed until the
 * customer primary database is configured by the Organization Admin.
 */
export function OrganizationProvisionFlow({ onViewOrg }: ProvisionOrganizationFlowProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [password, setPassword] = useState('');
  const [plan, setPlan] = useState<string>('');
  type CatalogStatus = 'loading' | 'ready' | 'failed';
  const [catalog, setCatalog] = useState<{ status: CatalogStatus; options: string[] }>({ status: 'loading', options: [] });
  const catalogOptions = catalog.status === 'ready' ? catalog.options : [];
  const [deploymentMode, setDeploymentMode] = useState<'MANAGED' | 'CUSTOMER_DB'>('MANAGED');
  const [initialStatus, setInitialStatus] = useState<string>('active');
  const [timezone, setTimezone] = useState('Asia/Dhaka');
  // Manual payment — recorded at provisioning for paid plans (manual sales
  // model, no payment gateway). Applied to the created invoice.
  const [payStatus, setPayStatus] = useState<string>('PENDING');
  const [payMethod, setPayMethod] = useState<string>('');
  const [payRef, setPayRef] = useState('');
  const [payDate, setPayDate] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ProvisionResult | null>(null);

  // Phase 2 §12 / Phase 5: the package list is database-driven (GET /api/plans),
  // never hardcoded. The catalog is public, so this works on the standalone
  // route and inside the authenticated Control Center alike. Failures are
  // surfaced with an explicit error + Retry instead of a silent catch.
  const loadCatalog = useCallback(async () => {
    setCatalog((prev) => ({ ...prev, status: 'loading' }));
    try {
      const res = await fetch('/api/plans', { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`plans ${res.status}`);
      const data = await res.json();
      const names = (data?.plans ?? data?.data ?? [])
        .map((p: { name?: string }) => p?.name)
        .filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);
      setCatalog({ status: 'ready', options: names });
      if (names.length > 0) {
        setPlan((prev) => (names.includes(prev) ? prev : names[0]));
      }
    } catch {
      setCatalog((prev) => ({ ...prev, status: 'failed' }));
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

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
          planName: plan || undefined,
          timezone,
          deploymentMode,
          status: initialStatus,
          paymentStatus: payStatus,
          paymentMethod: payMethod || undefined,
          transactionId: payRef || undefined,
          paidAt: payDate || undefined,
          paymentNotes: payNotes || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to create organization');
        return;
      }
      // POST /api/admin/organizations/create returns the provisioning payload
      // directly (apiSuccess has no envelope).
      setResult(data as ProvisionResult);
      toast.success('Organization provisioned');
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

  const reset = () => {
    setResult(null);
    setName('');
    setSlug('');
    setAdminEmail('');
    setAdminName('');
    setPassword('');
    setPayStatus('PENDING');
    setPayMethod('');
    setPayRef('');
    setPayDate('');
    setPayNotes('');
  };

  if (result) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              Account Generated
            </CardTitle>
            <CardDescription>
              Relay these credentials to the new admin. The temporary password is
              shown <strong>once</strong>.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {result.tempPassword && (
              <Badge
                variant="outline"
                className="gap-1.5 border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                First login — password change required
              </Badge>
            )}

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
                ? 'Share the email + temporary password securely, then ask the admin to sign in and set a new password on first login.'
                : 'The admin will sign in with the password you provided.'}
            </p>

            <div className="flex flex-wrap gap-3">
              {onViewOrg && (
                <Button type="button" onClick={() => onViewOrg({ id: result.organization.id, name: result.organization.name })}>
                  View Organization
                </Button>
              )}
              <Button type="button" variant="outline" onClick={reset}>
                Provision another
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="h-5 w-5 text-primary" />
          Organization Details
        </CardTitle>
        <CardDescription>
          Provision a complete workspace: organization + package + org admin
          account + subscription, ready to sign in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="prov-org-name">Organization Name *</Label>
              <Input
                id="prov-org-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Inc."
                required
                minLength={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prov-org-slug">Slug (optional)</Label>
              <Input
                id="prov-org-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="acme"
              />
            </div>
          </div>

          {/* Service Type — mandatory selection, persisted as deploymentMode */}
          <div className="space-y-2">
            <Label>Service Type *</Label>
            <div role="radiogroup" aria-label="Service Type" className="grid gap-3 sm:grid-cols-3">
              {SERVICE_OPTIONS.map((opt) => {
                const active = deploymentMode === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={cn(
                      'relative flex cursor-pointer flex-col gap-2 rounded-xl border p-4 transition-colors',
                      active
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                        : 'border-border bg-background hover:border-border/80 hover:bg-muted/30',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="prov-service-type"
                        value={opt.value}
                        checked={active}
                        onChange={() => setDeploymentMode(opt.value)}
                        className="h-4 w-4 accent-primary"
                      />
                      <span className="text-sm font-semibold text-foreground">{opt.title}</span>
                    </span>
                    <span className="text-xs leading-relaxed text-muted-foreground">{opt.description}</span>
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              Select the OmniSight service model this customer will use. The value is stored as the
              organization&apos;s deployment mode and cannot be silently changed.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="prov-admin-email">Admin Email *</Label>
              <Input
                id="prov-admin-email"
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
                placeholder="admin@company.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prov-admin-name">Admin Name</Label>
              <Input
                id="prov-admin-name"
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="prov-password">Set Password (optional)</Label>
              <Input
                id="prov-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Leave blank to auto-generate"
                minLength={8}
              />
              <p className="text-xs text-muted-foreground">
                Min 8 chars. If blank, a secure temporary password is generated and the
                admin must change it on first login.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="prov-timezone">Timezone</Label>
              <Input
                id="prov-timezone"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="Asia/Dhaka"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prov-plan">Package</Label>
            <Select value={plan} onValueChange={setPlan}>
              <SelectTrigger id="prov-plan">
                <SelectValue placeholder="Select a package" />
              </SelectTrigger>
              <SelectContent>
                {catalogOptions.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p.replace('_', ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {catalog.status === 'loading' && 'Loading the plan catalog…'}
              {catalog.status === 'failed' && (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span>Could not load the plan catalog.</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    onClick={() => void loadCatalog()}
                  >
                    Retry
                  </Button>
                </span>
              )}
              {catalog.status === 'ready' && catalogOptions.length === 0 &&
                'No packages are available. Provision without a package, or create one in Packages first.'}
              {catalog.status === 'ready' && catalogOptions.length > 0 &&
                'Free plans provision without an invoice. Paid plans get a pending subscription + invoice (manual payment).'}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="prov-initial-status">Initial Status</Label>
            <Select value={initialStatus} onValueChange={setInitialStatus}>
              <SelectTrigger id="prov-initial-status">
                <SelectValue placeholder="Select initial status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active (usable immediately)</SelectItem>
                <SelectItem value="pending">Pending (locked until activated)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Manual payment — part of organization provisioning */}
          <div className="rounded-xl border border-border/70 bg-muted/20 p-4">
            <p className="mb-1 text-[13px] font-semibold text-foreground">Manual Payment</p>
            <p className="mb-4 text-xs text-muted-foreground">
              Record the customer&apos;s manual payment on the invoice (paid plans only — Free plans
              provision without an invoice). Subscription activation happens separately from
              Subscriptions once payment is confirmed.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="prov-pay-status">Payment Status</Label>
                <Select value={payStatus} onValueChange={setPayStatus}>
                  <SelectTrigger id="prov-pay-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PENDING">Pending</SelectItem>
                    <SelectItem value="PAID">Paid</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="prov-pay-method">Payment Method</Label>
                <Select value={payMethod} onValueChange={setPayMethod}>
                  <SelectTrigger id="prov-pay-method">
                    <SelectValue placeholder="Select method" />
                  </SelectTrigger>
                  <SelectContent>
                    {['Bank_Transfer', 'bKash', 'Nagad', 'Rocket', 'Cash', 'Other'].map((m) => (
                      <SelectItem key={m} value={m}>
                        {m.replace(/_/g, ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="prov-pay-ref">Transaction / Reference ID</Label>
                <Input
                  id="prov-pay-ref"
                  value={payRef}
                  onChange={(e) => setPayRef(e.target.value)}
                  placeholder="e.g. bank ref or bKash trx"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prov-pay-date">Payment Date</Label>
                <Input id="prov-pay-date" type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
              </div>
              <div className="space-y-2 sm:col-span-2">
                <Label htmlFor="prov-pay-notes">Notes</Label>
                <textarea
                  id="prov-pay-notes"
                  rows={2}
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  placeholder="Anything worth recording about this manual payment"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
          </div>

          <div className="flex gap-3 pt-2">
            <Button type="submit" className="flex-1" disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Provisioning…
                </>
              ) : (
                'Provision Organization'
              )}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
