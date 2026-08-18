'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatDistanceToNow } from 'date-fns';

const typeIcons: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  application: { label: 'App', variant: 'secondary' },
  website: { label: 'Web', variant: 'default' },
  idle: { label: 'Idle', variant: 'outline' },
  screenshot: { label: 'Screenshot', variant: 'secondary' },
  work_session: { label: 'Session', variant: 'default' },
};

const categoryDotColor: Record<string, string> = {
  productive: 'bg-emerald-500',
  neutral: 'bg-slate-400',
  unproductive: 'bg-rose-500',
};

function formatTimeGap(ms: number): string | null {
  const hours = ms / (1000 * 60 * 60);
  if (hours >= 2) {
    const h = Math.round(hours);
    return `— ${h} hour${h > 1 ? 's' : ''} later —`;
  }
  return null;
}

interface ActivityFeedProps {
  data?: Array<{
    id: string;
    type: string;
    title: string | null;
    applicationName: string | null;
    url: string | null;
    category: string | null;
    duration: number;
    timestamp: string;
    employee: { id: string; firstName: string; lastName: string; avatar: string | null } | null;
    device: { id: string; name: string } | null;
  }>;
  isLoading: boolean;
}

export function ActivityFeed({ data, isLoading }: ActivityFeedProps) {
  const activities = data || [];

  return (
    <Card className="border shadow-sm overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Recent Activity</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="space-y-1 flex-1">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <ScrollArea className="max-h-72 custom-scrollbar">
            <div className="space-y-1">
              {activities.map((act, idx) => {
                const typeInfo = typeIcons[act.type] || { label: act.type, variant: 'outline' as const };
                const dotColor = categoryDotColor[act.category || ''] || 'bg-slate-300';
                const timestamp = new Date(act.timestamp).getTime();

                // Time-based separator
                let separator: string | null = null;
                if (idx > 0) {
                  const prevTimestamp = new Date(activities[idx - 1].timestamp).getTime();
                  separator = formatTimeGap(timestamp - prevTimestamp);
                }

                return (
                  <div key={act.id}>
                    {separator && (
                      <div className="flex items-center gap-2 py-2">
                        <div className="flex-1 h-px bg-border" />
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap">{separator}</span>
                        <div className="flex-1 h-px bg-border" />
                      </div>
                    )}
                    <div className="flex items-start gap-3 py-2 px-2 -mx-2 rounded-md hover:bg-muted/30 transition-colors duration-150 cursor-default">
                      <Avatar className="h-8 w-8 shrink-0">
                        <AvatarFallback className="text-[10px] bg-emerald-100 text-emerald-700 font-semibold">
                          {act.employee?.firstName?.[0]}{act.employee?.lastName?.[0]}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">
                            {act.employee?.firstName} {act.employee?.lastName}
                          </span>
                          <Badge variant={typeInfo.variant} className="text-[10px] h-4 px-1.5">
                            {typeInfo.label}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground truncate flex items-center gap-1.5">
                          <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${dotColor}`} />
                          {act.applicationName || act.title || act.url || 'Unknown activity'}
                        </p>
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5">
                          {formatDistanceToNow(new Date(act.timestamp), { addSuffix: true })} · {Math.round(act.duration / 60)}min
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  );
}
