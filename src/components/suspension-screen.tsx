'use client';

import { useAuthStore } from '@/lib/store';
import { Button } from '@/components/ui/button';
import { ShieldAlert } from 'lucide-react';

export function SuspensionScreen() {
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="mx-auto h-16 w-16 rounded-full bg-amber-500/10 flex items-center justify-center">
          <ShieldAlert className="h-8 w-8 text-amber-500" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">Organization Suspended</h1>
          <p className="text-muted-foreground">
            Your organization account is currently suspended.
          </p>
          <p className="text-sm text-muted-foreground">
            Please contact OmniSight Support or your organization administrator for assistance.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            logout();
            window.location.href = '/login';
          }}
        >
          Sign out
        </Button>
      </div>
    </div>
  );
}
