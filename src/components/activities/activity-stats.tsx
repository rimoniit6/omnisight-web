'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Clock, Monitor, Globe, Coffee } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

interface ActivityStatsProps {
  stats?: {
    totalActivities: number;
    totalDuration: number;
    productiveTime: number;
    unproductiveTime: number;
  };
  isLoading: boolean;
}

export function ActivityStats({ stats, isLoading }: ActivityStatsProps) {
  const items = [
    { label: 'Total Activities', value: stats?.totalActivities ?? 0, icon: Monitor, color: 'text-emerald-600', bg: 'bg-emerald-50' },
    { label: 'Total Time', value: `${((stats?.totalDuration ?? 0) / 3600).toFixed(1)}h`, icon: Clock, color: 'text-teal-600', bg: 'bg-teal-50' },
    { label: 'Productive', value: `${((stats?.productiveTime ?? 0) / 3600).toFixed(1)}h`, icon: Globe, color: 'text-emerald-600', bg: 'bg-emerald-50' },
    { label: 'Unproductive', value: `${((stats?.unproductiveTime ?? 0) / 60).toFixed(0)}min`, icon: Coffee, color: 'text-rose-600', bg: 'bg-rose-50' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 stagger-children">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Card key={item.label} className="falcon-card falcon-card-hover">
            <CardContent className="p-4">
              {isLoading ? (
                <Skeleton className="h-12 w-full" />
              ) : (
                <div className="flex items-center gap-3">
                  <div className={`h-10 w-10 rounded-lg ${item.bg} flex items-center justify-center shrink-0`}>
                    <Icon className={`w-5 h-5 ${item.color}`} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">{item.label}</p>
                    <p className="text-lg font-bold">{typeof item.value === 'number' ? item.value.toLocaleString() : item.value}</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
