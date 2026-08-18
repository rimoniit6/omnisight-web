'use client';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatDistanceToNow, isToday, isYesterday, startOfWeek, isAfter } from 'date-fns';
import { cn } from '@/lib/utils';

const typeConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' }> = {
  application: { label: 'App', variant: 'secondary' },
  website: { label: 'Web', variant: 'default' },
  idle: { label: 'Idle', variant: 'outline' },
  screenshot: { label: 'Screenshot', variant: 'secondary' },
  work_session: { label: 'Session', variant: 'default' },
};

const categoryDotColors: Record<string, string> = {
  productive: 'bg-success border-success',
  neutral: 'bg-warning border-warning',
  unproductive: 'bg-danger border-danger',
};

interface Activity {
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
}

interface ActivityTimelineProps {
  activities: Activity[];
  isLoading: boolean;
}

function getTimeGroup(date: Date): string | null {
  if (isToday(date)) return 'Today';
  if (isYesterday(date)) return 'Yesterday';
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  if (isAfter(date, weekStart)) return 'Earlier this week';
  return null;
}

export function ActivityTimeline({ activities, isLoading }: ActivityTimelineProps) {
  if (isLoading) {
    return <div className="space-y-4">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 bg-muted/30 rounded animate-pulse" />)}</div>;
  }

  // Build groups
  const groups: { label: string; activities: Activity[] }[] = [];
  let currentGroup: string | null = null;

  for (const act of activities) {
    const d = new Date(act.timestamp);
    const group = getTimeGroup(d);
    if (group && group !== currentGroup) {
      groups.push({ label: group, activities: [act] });
      currentGroup = group;
    } else if (groups.length > 0) {
      groups[groups.length - 1].activities.push(act);
    } else {
      groups.push({ label: 'Activities', activities: [act] });
      currentGroup = 'Activities';
    }
  }

  return (
    <ScrollArea className="max-h-[600px] custom-scrollbar">
      <div className="space-y-0 relative">
        {/* Vertical timeline line */}
        <div className="absolute left-[0.35rem] top-0 bottom-0 w-px bg-border" />

        {groups.map((group, gi) => (
          <div key={group.label + gi}>
            {/* Time group header */}
            <div className="relative flex items-center gap-3 pl-6 py-2">
              <div className="absolute left-[0.15rem] w-3 h-3 rounded-full bg-primary border-2 border-background z-10" />
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</span>
            </div>

            {group.activities.map((act) => {
              const tc = typeConfig[act.type] || { label: act.type, variant: 'outline' as const };
              const dotColor = act.category ? categoryDotColors[act.category] : 'bg-muted-foreground border-muted-foreground/50';
              return (
                <div
                  key={act.id}
                  className={cn(
                    'relative flex gap-4 py-2 md:py-3 pl-6 ml-1 rounded-lg transition-all duration-200 hover:bg-muted/40 hover:translate-x-1',
                  )}
                >
                  {/* Colored dot on timeline */}
                  <div className={cn('absolute left-[0.15rem] w-3 h-3 rounded-full border-2 border-background z-10', dotColor)} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {act.employee && (
                        <Avatar className="h-5 w-5 md:h-6 md:w-6">
                          <AvatarFallback className="text-[8px] md:text-[9px] bg-muted text-foreground font-semibold">
                            {act.employee.firstName[0]}{act.employee.lastName[0]}
                          </AvatarFallback>
                        </Avatar>
                      )}
                      <span className="text-xs md:text-sm font-medium truncate">{act.employee?.firstName} {act.employee?.lastName}</span>
                      <Badge variant={tc.variant} className="text-[9px] md:text-[10px] h-3.5 md:h-4 px-1 md:px-1.5">{tc.label}</Badge>
                      {act.category && (
                        <Badge variant="outline" className="text-[9px] md:text-[10px] h-3.5 md:h-4 px-1 md:px-1.5 capitalize hidden sm:inline-flex">{act.category}</Badge>
                      )}
                    </div>
                    <p className="text-[11px] md:text-xs text-muted-foreground mt-0.5 md:mt-1 truncate">
                      {act.applicationName || act.title || act.url || 'Unknown'}
                    </p>
                    <div className="flex items-center gap-2 md:gap-3 mt-0.5 md:mt-1 text-[9px] md:text-[10px] text-muted-foreground/70">
                      <span>{formatDistanceToNow(new Date(act.timestamp), { addSuffix: true })}</span>
                      <span>·</span>
                      <span>{Math.round(act.duration / 60)}min</span>
                      {act.device && <><span>·</span><span className="hidden sm:inline">{act.device.name}</span></>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
