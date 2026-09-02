'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PaginationControls } from '@/components/ui/pagination-controls';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDistanceToNow, isToday, isYesterday, format } from 'date-fns';
import { ClipboardList, FileDown, Plus, Pencil, Trash2, LogIn, LogOut, Download, Settings, BarChart3, Target, Hash, Brain, Upload, Key, ShieldAlert, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { exportToCSV } from '@/lib/csv-export';
import { cn } from '@/lib/utils';

const actionColors: Record<string, string> = {
  create: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
  update: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  delete: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-400',
  login: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-400',
  logout: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  export: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  configure: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400',
  detect: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-400',
  ai_analysis: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-400',
  import: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-400',
  reset: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-400',
  revoke: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
  other: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

const actionBorderColors: Record<string, string> = {
  create: 'border-l-emerald-500',
  update: 'border-l-amber-500',
  delete: 'border-l-rose-500',
  login: 'border-l-teal-500',
  logout: 'border-l-slate-400',
  export: 'border-l-amber-400',
  configure: 'border-l-purple-500',
  detect: 'border-l-sky-500',
  ai_analysis: 'border-l-indigo-500',
  import: 'border-l-cyan-500',
  reset: 'border-l-orange-500',
  revoke: 'border-l-red-500',
  other: 'border-l-gray-400',
};

const actionBarColors: Record<string, string> = {
  create: 'bg-emerald-500',
  update: 'bg-amber-500',
  delete: 'bg-rose-500',
  login: 'bg-teal-500',
  logout: 'bg-slate-400',
  export: 'bg-amber-400',
  configure: 'bg-purple-500',
  detect: 'bg-sky-500',
  ai_analysis: 'bg-indigo-500',
  import: 'bg-cyan-500',
  reset: 'bg-orange-500',
  revoke: 'bg-red-500',
  other: 'bg-gray-400',
};

const actionAvatarBg: Record<string, string> = {
  create: 'bg-emerald-500',
  update: 'bg-amber-500',
  delete: 'bg-rose-500',
  login: 'bg-teal-500',
  logout: 'bg-slate-500',
  export: 'bg-amber-400',
  configure: 'bg-purple-500',
  detect: 'bg-sky-500',
  ai_analysis: 'bg-indigo-500',
  import: 'bg-cyan-500',
  reset: 'bg-orange-500',
  revoke: 'bg-red-500',
  other: 'bg-gray-400',
};

const actionIcons: Record<string, React.ElementType> = {
  create: Plus,
  update: Pencil,
  delete: Trash2,
  login: LogIn,
  logout: LogOut,
  export: Download,
  configure: Settings,
  detect: Search,
  ai_analysis: Brain,
  import: Upload,
  reset: Key,
  revoke: ShieldAlert,
  other: ClipboardList,
};

interface AuditLogEntry {
  id: string;
  action: string;
  resource: string;
  description: string;
  userId?: string;
  ipAddress?: string;
  createdAt: string;
}

function groupByDate(logs: AuditLogEntry[]) {
  const groups: Array<{ label: string; logs: AuditLogEntry[] }> = [];
  let currentDateLabel = '';
  let currentGroup: AuditLogEntry[] = [];

  const sorted = [...logs];

  sorted.forEach((log) => {
    const d = new Date(log.createdAt);
    let label: string;
    if (isToday(d)) label = 'Today';
    else if (isYesterday(d)) label = 'Yesterday';
    else label = format(d, 'MMM d, yyyy');

    if (label !== currentDateLabel) {
      if (currentGroup.length > 0) {
        groups.push({ label: currentDateLabel, logs: currentGroup });
      }
      currentDateLabel = label;
      currentGroup = [log];
    } else {
      currentGroup.push(log);
    }
  });
  if (currentGroup.length > 0) {
    groups.push({ label: currentDateLabel, logs: currentGroup });
  }

  return groups;
}

export function AuditPage() {
  const [actionFilter, setActionFilter] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams();
  if (actionFilter && actionFilter !== 'all') params.set('action', actionFilter);
  if (resourceFilter && resourceFilter !== 'all') params.set('resource', resourceFilter);
  params.set('page', String(page));
  params.set('pageSize', '15');

  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', actionFilter, resourceFilter, page],
    queryFn: async () => {
      const res = await fetch(`/api/audit-logs?${params}`);
      return res.json();
    },
  });

  const logs = useMemo(() => data?.data || [], [data]);
  const stats = data?.stats;
  const actionDistribution = stats?.actionDistribution || {};
  const maxActionCount = Math.max(1, ...Object.values(actionDistribution) as number[]);
  const groupedLogs = useMemo(() => groupByDate(logs), [logs]);

  return (
    <div className='space-y-4 rounded-lg p-1' role='region' aria-label='Audit Logs'>
      {/* Filters Row with Stats */}
      <div className='flex flex-col lg:flex-row gap-3 items-start lg:items-center justify-between'>
        <div className='flex flex-col sm:flex-row gap-3 flex-1 w-full sm:w-auto'>
          <Select value={actionFilter || 'all'} onValueChange={(v) => { setActionFilter(v === 'all' ? '' : v); setPage(1); }}>
            <SelectTrigger className='w-full sm:w-40'><SelectValue placeholder='All Actions' /></SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>All Actions</SelectItem>
              {Object.keys(actionColors).map((a) => (
                <SelectItem key={a} value={a} className='capitalize'>{a.replace(/_/g, ' ')}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={resourceFilter || 'all'} onValueChange={(v) => { setResourceFilter(v === 'all' ? '' : v); setPage(1); }}>
            <SelectTrigger className='w-full sm:w-40'><SelectValue placeholder='All Resources' /></SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>All Resources</SelectItem>
              {['employee', 'device', 'department', 'policy', 'settings', 'report', 'notification', 'alert'].map((r) => (
                <SelectItem key={r} value={r} className='capitalize'>{r}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className='flex items-center gap-2 shrink-0'>
          {/* Mini Stats */}
          {stats && !isLoading && (
            <div className='hidden md:flex items-center gap-3 mr-3'>
              <div className='inline-flex items-center gap-1.5 bg-muted rounded-full px-3 py-1.5'>
                <Hash className='w-3 h-3 text-muted-foreground' />
                <span className='text-xs font-medium'>{stats.total} entries</span>
              </div>
              <div className='inline-flex items-center gap-1.5 bg-emerald-100 dark:bg-emerald-900/40 rounded-full px-3 py-1.5'>
                <BarChart3 className='w-3 h-3 text-emerald-600 dark:text-emerald-400' />
                <span className='text-xs font-medium text-emerald-700 dark:text-emerald-400'>{stats.mostCommonAction}</span>
              </div>
              <div className='inline-flex items-center gap-1.5 bg-teal-100 dark:bg-teal-900/40 rounded-full px-3 py-1.5'>
                <Target className='w-3 h-3 text-teal-600 dark:text-teal-400' />
                <span className='text-xs font-medium text-teal-700 dark:text-teal-400'>{stats.mostAffectedResource}</span>
              </div>
            </div>
          )}

          <Button
            variant='outline'
            onClick={async () => {
              try {
                const res = await fetch('/api/audit-logs/export');
                const json = await res.json();
                if (json.data && json.data.length > 0) {
                  exportToCSV(json.data, 'audit_logs');
                  toast.success(`Exported ${json.data.length} audit logs`);
                } else {
                  toast.error('No audit logs to export');
                }
              } catch {
                toast.error('Failed to export audit logs');
              }
            }}
            className='shrink-0'
          >
            <FileDown className='w-4 h-4 mr-2' /> Export
          </Button>
        </div>
      </div>

      {/* Action Distribution Chart */}
      {stats && Object.keys(actionDistribution).length > 0 && !isLoading && (
        <Card className='border shadow-sm'>
          <CardContent className='p-4'>
            <h3 className='text-xs font-semibold text-muted-foreground mb-3'>Action Distribution</h3>
            <div className='space-y-2'>
              {Object.entries(actionDistribution)
                .sort((a, b) => (b[1] as number) - (a[1] as number))
                .map(([action, count]) => {
                  const pct = ((count as number) / maxActionCount) * 100;
                  const ActionIcon = actionIcons[action] || ClipboardList;
                  return (
                    <div key={action} className='flex items-center gap-3'>
                      <div className={cn('w-6 h-6 rounded flex items-center justify-center shrink-0', actionColors[action] || 'bg-muted')}>
                        <ActionIcon className='w-3 h-3' />
                      </div>
                      <span className='text-xs font-medium capitalize w-16 shrink-0'>{action}</span>
                      <div className='flex-1 h-2 rounded-full bg-muted overflow-hidden'>
                        <div
                          className={cn('h-full rounded-full transition-all duration-500', actionBarColors[action] || 'bg-muted-foreground')}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className='text-xs text-muted-foreground w-8 text-right'>{count as number}</span>
                    </div>
                  );
                })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Log List */}
      {isLoading ? (
        <div className='space-y-0 border rounded-lg overflow-hidden'>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className='flex items-center gap-4 px-4 py-3 border-b last:border-0'>
              <Skeleton className='h-5 w-8 rounded' />
              <Skeleton className='h-5 w-8 rounded-full' />
              <div className='flex-1 space-y-1.5'>
                <Skeleton className='h-4 w-3/4' />
                <Skeleton className='h-3 w-1/2' />
              </div>
              <Skeleton className='h-3 w-16' />
            </div>
          ))}
        </div>
      ) : logs.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title='No audit logs found'
          description={actionFilter || resourceFilter ? 'Try adjusting your filters to see more results.' : 'Audit logs will appear here as actions are performed.'}
        />
      ) : (
        <div className='border rounded-lg'>
          <ScrollArea className='max-h-[600px] custom-scrollbar'>
            {groupedLogs.map((group) => (
              <div key={group.label}>
                {/* Date Header */}
                <div className='px-4 py-2 bg-muted/50 border-b sticky top-0 z-10'>
                  <span className='text-xs font-semibold text-muted-foreground uppercase tracking-wider'>{group.label}</span>
                </div>
                {/* Timeline entries */}
                <div className='relative'>
                  {/* Timeline vertical line */}
                  <div className='absolute left-[1.875rem] top-0 bottom-0 w-px bg-border' />
                  {group.logs.map((log: { id: string; action: string; resource: string; description: string; userId?: string; ipAddress?: string; createdAt: string }, idx: number) => {
                    const ActionIcon = actionIcons[log.action] || ClipboardList;
                    const initials = log.userId ? log.userId.slice(0, 2).toUpperCase() : '??';
                    const isLast = idx === group.logs.length - 1;
                    return (
                      <div
                        key={log.id}
                        className={cn(
                          'list-item-interactive flex items-center gap-4 px-4 py-3 border-b last:border-0 transition-all hover:bg-muted/40',
                          'border-l-[3px]',
                          actionBorderColors[log.action] || 'border-l-transparent'
                        )}
                      >
                        {/* User Avatar Initial Circle */}
                        <div className='relative z-10 shrink-0'>
                          <div className={cn(
                            'w-8 h-8 rounded-full flex items-center justify-center ring-2 ring-background shadow-sm',
                            actionAvatarBg[log.action] || 'bg-muted-foreground'
                          )}>
                            <span className='text-[10px] font-bold text-white'>{initials}</span>
                          </div>
                          {/* Timeline dot */}
                          {!isLast && (
                            <div className={cn(
                              'absolute -bottom-3 left-1/2 -translate-x-1/2 w-1.5 h-1.5 rounded-full',
                              actionBarColors[log.action] || 'bg-muted-foreground'
                            )} />
                          )}
                        </div>
                        {/* Action type color badge */}
                        <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-transform hover:scale-110', actionColors[log.action] || 'bg-muted')}>
                          <ActionIcon className='w-3.5 h-3.5' />
                        </div>
                        {/* Description */}
                        <div className='flex-1 min-w-0'>
                          <p className='text-sm truncate text-clamp-2'>{log.description}</p>
                          <div className='flex items-center gap-2 mt-0.5'>
                            <Badge variant='outline' className='text-[10px] h-4 px-1.5'>{log.resource}</Badge>
                            {log.ipAddress && <span className='text-[10px] text-muted-foreground'>IP: {log.ipAddress}</span>}
                          </div>
                        </div>
                        {/* Time */}
                        <span className='text-[10px] text-muted-foreground shrink-0'>
                          {formatDistanceToNow(new Date(log.createdAt), { addSuffix: true })}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </ScrollArea>
        </div>
      )}

      <PaginationControls
        currentPage={data?.page || 1}
        totalPages={data?.totalPages || 1}
        totalItems={data?.total || 0}
        pageSize={15}
        onPageChange={setPage}
      />
    </div>
  );
}
