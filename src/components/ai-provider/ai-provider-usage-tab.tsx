'use client';

import { motion } from 'framer-motion';
import { formatDistanceToNow } from 'date-fns';
import {
  Activity, BarChart3, Sparkles, RefreshCw, CheckCircle2, X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface AiUsageDailyBar {
  day: string;
  count: number;
}

export interface AiUsageRecent {
  id: string;
  model: string;
  title: string;
  status: string;
  createdAt: string;
}

export interface AiUsage {
  today: number;
  thisMonth: number;
  total: number;
  dailyBars: AiUsageDailyBar[];
  recentRequests: AiUsageRecent[];
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

interface AiProviderUsageTabProps {
  usage: AiUsage | undefined;
  onRefresh: () => void;
}

export function AiProviderUsageTab({ usage, onRefresh }: AiProviderUsageTabProps) {
  const dailyBars = usage?.dailyBars || [];
  const maxDaily = Math.max(1, ...dailyBars.map((b) => b.count));
  const recentRequests = usage?.recentRequests || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Usage Statistics</h2>
          <p className="text-sm text-muted-foreground mt-1">
            AI analyses performed by the system, sourced from the database.
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={onRefresh}>
          <RefreshCw className="size-3.5" />
          Refresh
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'Analyses Today', value: usage?.today ?? 0, icon: Activity, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20' },
          { label: 'This Month', value: usage?.thisMonth ?? 0, icon: BarChart3, color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/20' },
          { label: 'Total All Time', value: usage?.total ?? 0, icon: Sparkles, color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-900/20' },
        ].map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06, duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
          >
            <Card className="relative overflow-hidden">
              <CardContent className="py-5 px-5">
                <div className="flex items-center gap-3">
                  <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', stat.bg)}>
                    <stat.icon className={cn('size-4.5', stat.color)} />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground font-medium">{stat.label}</p>
                    <p className="text-xl font-bold tracking-tight mt-0.5">
                      {formatNumber(stat.value)}
                      <span className="text-xs font-normal text-muted-foreground ml-1">analyses</span>
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Daily Usage Bar Chart */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2, duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
      >
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="size-4 text-[oklch(0.555_0.163_163.5)]" />
              Daily Usage — Last 7 Days
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dailyBars.length === 0 ? (
              <div className="h-44 flex items-center justify-center text-sm text-muted-foreground">
                No AI analyses recorded yet.
              </div>
            ) : (
              <div className="flex items-end gap-3 h-44 pt-2">
                {dailyBars.map((bar, i) => {
                  const heightPercent = (bar.count / maxDaily) * 100;
                  const isToday = i === dailyBars.length - 1;
                  return (
                    <div key={`${bar.day}-${i}`} className="flex-1 flex flex-col items-center gap-2">
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="w-full relative group cursor-default">
                              <motion.div
                                initial={{ height: 0 }}
                                animate={{ height: `${Math.max(heightPercent, 3)}%` }}
                                transition={{ delay: i * 0.08, duration: 0.5, ease: 'easeOut' }}
                                className={cn(
                                  'w-full rounded-t-md min-h-[4px] transition-colors',
                                  isToday
                                    ? 'bg-primary'
                                    : 'bg-primary/40 group-hover:bg-primary/70',
                                )}
                              />
                            </div>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="text-xs font-medium">{bar.day}</p>
                            <p className="text-xs text-muted-foreground">{bar.count} analyses</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                      <span className={cn('text-[10px] font-medium', isToday ? 'text-[oklch(0.555_0.163_163.5)]' : 'text-muted-foreground')}>
                        {bar.day}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Recent AI Outputs Table */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3, duration: 0.35, ease: [0.25, 0.46, 0.45, 0.94] }}
      >
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <RefreshCw className="size-4 text-[oklch(0.555_0.163_163.5)]" />
              Recent AI Outputs
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentRequests.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No AI analyses recorded yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="pb-3 font-medium text-muted-foreground text-xs">Category</th>
                      <th className="pb-3 font-medium text-muted-foreground text-xs">Title</th>
                      <th className="pb-3 font-medium text-muted-foreground text-xs">Status</th>
                      <th className="pb-3 font-medium text-muted-foreground text-xs text-right">Time</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {recentRequests.map((req) => (
                      <tr key={req.id} className="hover:bg-muted/50 transition-colors">
                        <td className="py-3 font-medium text-xs capitalize">{req.model}</td>
                        <td className="py-3 text-xs text-muted-foreground max-w-[280px] truncate">{req.title}</td>
                        <td className="py-3">
                          <Badge
                            variant="outline"
                            className={cn(
                              'text-[10px] px-1.5 py-0 h-5 font-medium',
                              req.status === 'success'
                                ? 'border-emerald-500/40 text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 dark:text-emerald-400'
                                : 'border-rose-500/40 text-rose-600 bg-rose-50 dark:bg-rose-900/20 dark:text-rose-400',
                            )}
                          >
                            {req.status === 'success' ? (
                              <><CheckCircle2 className="size-3 mr-0.5" /> Success</>
                            ) : (
                              <><X className="size-3 mr-0.5" /> Failed</>
                            )}
                          </Badge>
                        </td>
                        <td className="py-3 text-xs text-muted-foreground text-right">
                          {formatDistanceToNow(new Date(req.createdAt), { addSuffix: true })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
