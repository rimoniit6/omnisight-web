'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Crown, Medal, Trophy } from 'lucide-react';
import { PresenceDot } from '@/components/ui/presence-dot';
import { chartTheme } from '@/lib/chart-theme';

const rankIcons: React.ElementType[] = [Crown, Trophy, Medal];
const rankColors = ['text-amber-500', 'text-slate-400', 'text-orange-600'];
// Gold / Silver / Bronze badge backgrounds
const rankBadgeBg = ['bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400', 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300', 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400'];

interface TopEmployeesProps {
  data?: Array<{
    id: string;
    firstName: string;
    lastName: string;
    department: string;
    productiveTime: number;
  }>;
  isLoading: boolean;
}

export function TopEmployees({ data, isLoading }: TopEmployeesProps) {
  const topTime = (data?.[0]?.productiveTime || 1);

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Top Performers</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-7 w-7 rounded-full" />
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="space-y-1 flex-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {(data || []).map((emp, i) => {
              const hours = (emp.productiveTime / 3600).toFixed(1);
              const RankIcon = i < 3 ? rankIcons[i] : null;
              const pct = Math.round((emp.productiveTime / topTime) * 100);
              return (
                <div
                  key={emp.id}
                  className="flex items-center gap-2 sm:gap-3 bg-muted/50 rounded-lg transition-all duration-200 px-2 py-1.5 -mx-2 group cursor-default"
                >
                  {i < 3 && RankIcon ? (
                    <div className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 ${rankBadgeBg[i]}`}>
                      <RankIcon className={`w-3.5 h-3.5 ${rankColors[i]}`} />
                    </div>
                  ) : (
                    <span className="h-7 w-7 rounded-full bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground shrink-0">{i + 1}</span>
                  )}
                  <Avatar className="h-8 w-8 shrink-0">
                    <AvatarFallback className="text-[10px] font-semibold" style={{
                      backgroundColor: chartTheme.colors.emeraldLight,
                      color: chartTheme.colors.emerald,
                    }}>
                      {emp.firstName[0]}{emp.lastName[0]}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <PresenceDot employeeId={emp.id} />
                      <p className="text-sm font-medium truncate">{emp.firstName} {emp.lastName}</p>
                    </span>
                    <p className="text-xs text-muted-foreground truncate">{emp.department}</p>
                    {/* Emerald gradient progress bar */}
                    <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: chartTheme.colors.emeraldLight }}>
                      <div
                        className="h-full rounded-full transition-all duration-700 ease-out"
                        style={{
                          width: `${pct}%`,
                          background: `linear-gradient(90deg, ${chartTheme.gradients.emeraldArea[0]}, ${chartTheme.gradients.emeraldArea[0]}cc, ${chartTheme.colors.teal})`,
                        }}
                      />
                    </div>
                  </div>
                  <span className="text-sm font-semibold shrink-0" style={{ color: chartTheme.colors.emerald }}>{hours}h</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
