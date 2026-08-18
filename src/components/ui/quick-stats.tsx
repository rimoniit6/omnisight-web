'use client';

import React from 'react';
import { Card, CardContent } from '@/components/ui/card';

export interface QuickStat {
  label: string;
  value: number;
  icon: React.ElementType;
  color: string; // e.g., 'emerald', 'rose', 'amber', 'blue'
}

interface QuickStatsProps {
  stats: QuickStat[];
}

const colorMap: Record<string, { iconBg: string; iconColor: string; valueColor: string; dotColor: string }> = {
  emerald: {
    iconBg: 'bg-primary/10',
    iconColor: 'text-primary',
    valueColor: 'text-foreground',
    dotColor: 'bg-primary',
  },
  rose: {
    iconBg: 'bg-danger/10',
    iconColor: 'text-danger',
    valueColor: 'text-foreground',
    dotColor: 'bg-danger',
  },
  amber: {
    iconBg: 'bg-warning/10',
    iconColor: 'text-warning',
    valueColor: 'text-foreground',
    dotColor: 'bg-warning',
  },
  blue: {
    iconBg: 'bg-info/10',
    iconColor: 'text-info',
    valueColor: 'text-foreground',
    dotColor: 'bg-info',
  },
  default: {
    iconBg: 'bg-muted',
    iconColor: 'text-muted-foreground',
    valueColor: 'text-foreground',
    dotColor: 'bg-muted-foreground',
  },
};

export function QuickStats({ stats }: QuickStatsProps) {
  const cols = stats.length;
  const gridCols =
    cols <= 3
      ? 'grid-cols-3'
      : 'grid-cols-2 sm:grid-cols-4';

  return (
    <div className={`grid ${gridCols} gap-3`}>
      {stats.map((stat) => {
        const Icon = stat.icon;
        const colors = colorMap[stat.color] || colorMap.default;
        return (
          <Card key={stat.label} className="border py-0">
            <CardContent className="p-3.5 flex items-center gap-3">
              <div className={`h-9 w-9 rounded-lg ${colors.iconBg} flex items-center justify-center shrink-0`}>
                <Icon className={`w-4 h-4 ${colors.iconColor}`} />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] text-muted-foreground font-medium leading-tight">{stat.label}</p>
                <p className={`text-lg font-bold ${colors.valueColor} leading-tight mt-0.5`}>{stat.value}</p>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
