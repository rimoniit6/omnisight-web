'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      {/* KPI Cards skeleton - 4 cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="border">
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-7 w-14" />
                </div>
                <Skeleton className="h-10 w-10 rounded-lg" />
              </div>
              <Skeleton className="h-3 w-20 mt-3" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Productivity chart + Department chart skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border">
          <CardContent className="p-4">
            <Skeleton className="h-4 w-48 mb-4" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </CardContent>
        </Card>
        <Card className="border">
          <CardContent className="p-4">
            <Skeleton className="h-4 w-48 mb-4" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </CardContent>
        </Card>
      </div>

      {/* Device status + Top employees skeleton */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border">
          <CardContent className="p-4">
            <Skeleton className="h-4 w-40 mb-4" />
            <Skeleton className="h-64 w-full rounded-lg" />
          </CardContent>
        </Card>
        <Card className="border">
          <CardContent className="p-4">
            <Skeleton className="h-4 w-40 mb-4" />
            <div className="space-y-3 mt-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-28" />
                    <Skeleton className="h-2.5 w-full max-w-40" />
                  </div>
                  <Skeleton className="h-4 w-12" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Activity feed skeleton */}
      <Card className="border">
        <CardContent className="p-4">
          <Skeleton className="h-4 w-32 mb-4" />
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-7 w-7 rounded-full shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-48" />
                  <Skeleton className="h-2.5 w-32" />
                </div>
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
