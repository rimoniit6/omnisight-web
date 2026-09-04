'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Loader2, Save, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentUser } from '@/hooks/use-current-user';

interface OrgSettings {
  id: string;
  name: string;
  email: string | null;
  screenshotInterval: number;
  activeDeviceCount: number;
  planName: string;
}

export default function AdminOrgSettingsPage() {
  const router = useRouter();
  const params = useParams<{ orgId: string }>();
  const orgId = params?.orgId ?? '';
  const { user, isLoading: authLoading } = useCurrentUser();

  const [interval, setInterval] = useState<number>(5);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/login');
  }, [authLoading, user, router]);

  const query = useQuery<{ data: OrgSettings }>({
    queryKey: ['admin-org-settings', orgId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/organizations/${orgId}/settings`, { credentials: 'same-origin' });
      if (res.status === 403) throw new Error('super_admin');
      if (res.status === 404) throw new Error('not_found');
      if (!res.ok) throw new Error('Failed to load settings');
      return res.json();
    },
    enabled: !!user && !!orgId,
    staleTime: 30 * 1000,
  });

  // Seed the interval control once the org data arrives.
  useEffect(() => {
    const data = query.data?.data;
    if (data && !loaded) {
      setInterval(data.screenshotInterval);
      setLoaded(true);
    }
  }, [query.data, loaded]);

  const isSuperAdmin = user?.role === 'super_admin';

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/organizations/${orgId}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ screenshotInterval: interval }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to save settings');
        return;
      }
      toast.success('Screenshot interval saved.');
      query.refetch();
    } catch {
      toast.error('Network error. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background p-8">
        <Skeleton className="h-10 w-56 mb-6" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!user) return null;

  if (!isSuperAdmin) {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <div className="text-center max-w-sm">
          <ShieldAlert className="w-10 h-10 mx-auto text-rose-500 mb-3" />
          <p className="text-2xl font-semibold mb-2">Super admin only</p>
          <p className="text-muted-foreground mb-4">Organization settings require a super admin account.</p>
          <Button onClick={() => router.push('/')}>Back to app</Button>
        </div>
      </div>
    );
  }

  const error = query.error as Error | null;
  if (error?.message === 'super_admin') {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <div className="text-center max-w-sm">
          <ShieldAlert className="w-10 h-10 mx-auto text-rose-500 mb-3" />
          <p className="text-2xl font-semibold mb-2">Super admin only</p>
          <p className="text-muted-foreground mb-4">You are not authorized to manage organization settings.</p>
          <Button onClick={() => router.push('/')}>Back to app</Button>
        </div>
      </div>
    );
  }
  if (error?.message === 'not_found') {
    return (
      <div className="min-h-screen bg-background grid place-items-center">
        <div className="text-center max-w-sm">
          <p className="text-2xl font-semibold mb-2">Organization not found</p>
          <Button onClick={() => router.push('/admin/organizations')}>Back</Button>
        </div>
      </div>
    );
  }

  const data = query.data?.data;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b sticky top-0 z-10 bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 font-semibold">
            <ShieldAlert className="w-5 h-5 text-primary" />
            Organization Settings
          </div>
          <Button variant="outline" size="sm" onClick={() => router.push('/')}>
            Back to app
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        {query.isLoading || !data ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{data.name}</CardTitle>
                <CardDescription>
                  {data.email ?? 'No contact email'} · {data.planName} plan · {data.activeDeviceCount} active device(s)
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="screenshot-interval">Screenshot interval (minutes)</Label>
                  <Input
                    id="screenshot-interval"
                    type="number"
                    min={0}
                    max={60}
                    value={Number.isNaN(interval) ? '' : interval}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      setInterval(Number.isNaN(n) ? 0 : n);
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Minutes between agent screenshots for this organization. Set to 0 to disable screenshot
                    capture. This cadence is controlled here (super admin), not in the org-facing monitoring UI.
                  </p>
                </div>

                <div className="flex justify-end">
                  <Button onClick={save} disabled={saving || interval < 0 || interval > 60}>
                    {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                    Save
                  </Button>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
