'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Globe, AppWindow } from 'lucide-react';
import { cn } from '@/lib/utils';
import { chartTheme } from '@/lib/chart-theme';

interface TopAppsWebsitesProps {
  data?: Array<{
    name: string;
    duration: number;
    durationMinutes: number;
    count: number;
    type: string;
    category?: string;
  }>;
  isLoading: boolean;
}

function getCategoryBg(category?: string) {
  switch (category) {
    case 'productive': return 'bg-emerald-100 dark:bg-emerald-900/40';
    case 'neutral': return 'bg-amber-100 dark:bg-amber-900/40';
    case 'unproductive': return 'bg-rose-100 dark:bg-rose-900/40';
    default: return 'bg-muted';
  }
}

function getCategoryBarStyle(category?: string): { background: string } {
  const color =
    category === 'productive' ? chartTheme.colors.emerald :
    category === 'neutral' ? chartTheme.colors.amber :
    category === 'unproductive' ? chartTheme.colors.rose :
    'var(--muted-foreground)';
  return { background: `linear-gradient(90deg, ${color}cc, ${color})` };
}

export function TopAppsWebsites({ data, isLoading }: TopAppsWebsitesProps) {
  const maxDuration = data && data.length > 0 ? Math.max(...data.map((d) => d.duration)) : 1;

  return (
    <Card className='border shadow-sm'>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm font-semibold'>Top Applications & Websites</CardTitle>
      </CardHeader>
      <CardContent className='pt-0'>
        {isLoading ? (
          <div className='space-y-3'>{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className='h-12 w-full' />)}</div>
        ) : (
          <div className='space-y-1 max-h-96 overflow-y-auto custom-scrollbar'>
            {(data || []).map((item, i) => {
              const pct = maxDuration > 0 ? (item.duration / maxDuration) * 100 : 0;
              const isTop3 = i < 3;
              return (
                <div key={i} className='flex items-center gap-2 sm:gap-3 py-2.5 px-2 rounded-lg hover:bg-muted/30 hover:shadow-sm transition-all duration-200 group'>
                  {/* Rank Number */}
                  <span className={cn(
                    'text-xs font-bold w-5 h-5 rounded-full flex items-center justify-center shrink-0',
                    isTop3
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                      : 'text-muted-foreground bg-muted'
                  )}>
                    {i + 1}
                  </span>
                  {/* Icon */}
                  <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', getCategoryBg(item.category))}>
                    {item.type === 'website'
                      ? <Globe className='w-4 h-4' style={{ color: chartTheme.colors.teal }} />
                      : <AppWindow className='w-4 h-4' style={{ color: chartTheme.colors.emerald }} />
                    }
                  </div>
                  {/* Name & Info */}
                  <div className='flex-1 min-w-0'>
                    <div className='flex items-center gap-2'>
                      <p className='text-sm font-medium truncate'>{item.name}</p>
                    </div>
                    <div className='flex items-center gap-2 mt-1'>
                      {/* Progress Bar with gradient */}
                      <div className='flex-1 h-1.5 rounded-full bg-muted overflow-hidden'>
                        <div
                          className='h-full rounded-full transition-all duration-500'
                          style={{ ...getCategoryBarStyle(item.category), width: `${pct}%` }}
                        />
                      </div>
                      <span className='text-[10px] text-muted-foreground shrink-0 hidden sm:inline'>{item.count} uses</span>
                    </div>
                  </div>
                  {/* Duration */}
                  <div className='text-right shrink-0 ml-1 sm:ml-2'>
                    <p className='text-sm font-semibold'>{item.durationMinutes}min</p>
                    <p className='text-[10px] text-muted-foreground'>{item.type === 'website' ? 'Website' : 'App'}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
