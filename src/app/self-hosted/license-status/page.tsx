'use client';

import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { BadgeCheck, Cloud, KeyRound, ShieldAlert } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/hooks/use-current-user';

interface LicenseStatusResponse {
  data: {
    mode: 'cloud' | 'self_hosted';
    licensed: boolean;
    reason?: 'no_license' | 'revoked' | 'inactive' | 'expired';
    license?: {
      key: string;
      validUntil: string;
      plan: { name: string; maxDevices: number; retentionDays: number };
    };
  };
}

const REASON_LABEL: Record<string, string> = {
  no_license: 'No license key issued for this organization.',
  revoked: 'The license key for this organization has been revoked.',
  inactive: 'The license key for this organization is inactive.',
  expired: 'The license key for this organization has expired.',
};

export default function SelfHostedLicenseStatusPage() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useCurrentUser();

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  const query = useQuery<LicenseStatusResponse>({
    queryKey: ['self-hosted-license-status'],
    queryFn: async () => {
      const res = await fetch('/api/self-hosted/license-status', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load license status');
      return res.json();
    },
    enabled: !!user,
    staleTime: 30 * 1000,
  });

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background p-8">
        <Skeleton className="h-10 w-64 mb-6" />
        <Skeleton className="h-56 w-full max-w-2xl rounded-xl" />
      </div>
    );
  }

  if (!user) return null;

  const d = query.data?.data;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-10 bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-4xl px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <KeyRound className="w-5 h-5 text-primary" />
            License Status
          </div>
          <Button variant="outline" size="sm" onClick={() => router.push('/')}>
            Back to app
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Deployment license</CardTitle>
            <CardDescription>
              The license status of this OmniSight instance. Self-hosted deployments must hold a
              valid OMNISIGHT license; cloud tenants are licensed automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {query.isLoading ? (
              <Skeleton className="h-40 w-full rounded-lg" />
            ) : !d ? (
              <p className="text-sm text-muted-foreground py-6 text-center">Unable to load license status.</p>
            ) : d.mode === 'cloud' ? (
              <div className="flex items-center gap-4 py-4">
                <Cloud className="w-8 h-8 text-primary" />
                <div>
                  <Badge className="bg-emerald-500/15 text-emerald-600 mb-1">
                    <BadgeCheck className="w-3.5 h-3.5 mr-1" /> Licensed
                  </Badge>
                  <p className="text-sm text-muted-foreground">
                    This is a cloud-hosted instance. Licensing is managed by the SaaS platform and
                    no self-hosted license is required.
                  </p>
                </div>
              </div>
            ) : d.licensed ? (
              <div className="flex items-start gap-4 py-4">
                <BadgeCheck className="w-8 h-8 text-emerald-600" />
                <div className="space-y-1">
                  <Badge className="bg-emerald-500/15 text-emerald-600 mb-1">Active license</Badge>
                  <p className="font-mono text-sm">{d.license!.key}</p>
                  <p className="text-sm text-muted-foreground">
                    Plan: <span className="font-medium">{d.license!.plan.name}</span> · Valid until{' '}
                    {new Date(d.license!.validUntil).toLocaleString()}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Device limit: {d.license!.plan.maxDevices > 0 ? d.license!.plan.maxDevices : 'Unlimited'} ·
                    Retention: {d.license!.plan.retentionDays > 0 ? `${d.license!.plan.retentionDays} days` : 'Unlimited'}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-4 py-4">
                <ShieldAlert className="w-8 h-8 text-rose-500" />
                <div>
                  <Badge className="bg-rose-500/15 text-rose-600 mb-1">Not licensed</Badge>
                  <p className="text-sm text-muted-foreground">
                    {REASON_LABEL[d.reason ?? 'no_license']}{' '}
                    {d.reason === 'expired'
                      ? 'Contact the platform administrator to renew this deployment.'
                      : 'Contact the platform administrator to issue or restore a license key.'}
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
