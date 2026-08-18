'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  HeartPulse,
  Loader2,
  Play,
  Users,
  TrendingUp,
  Activity,
  AlertTriangle,
  BarChart3,
  Sparkles,
  Scale,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { useAuthStore } from '@/lib/store';
import { hasRolePermission } from '@/lib/auth';

// ==================== Types ====================

interface ProjectSentimentRecord {
  id: string;
  employeeId: string;
  score: number | null;
  mood: string;
  signals: string;
  insight: string;
  riskFactors: string;
  recommendation: string;
  periodStart: string;
  periodEnd: string;
  aiProviderUsed: string | null;
  aiModel: string | null;
  createdAt: string;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    designation: string | null;
    avatar: string | null;
    department: { name: string } | null;
  };
}

interface ProjectSentimentResponse {
  project: { id: string; name: string; status: string };
  records: ProjectSentimentRecord[];
  history: ProjectSentimentRecord[];
  stats: {
    avgScore: number | null;
    moodDistribution: { mood: string; count: number }[];
    analyzedCount: number;
    noDataCount: number;
  };
}

interface AnalyzeResult {
  analyzed: number;
  total: number;
  consentSkipped: number;
  noData: number;
  aiSuccess: number;
  aiFallback: { count: number; reasons: string[] };
  aiFailures: { employeeId: string; reason: string }[];
}

// ==================== Helpers ====================

function getMoodLabel(mood: string): string {
  switch (mood) {
    case 'positive': return 'Positive';
    case 'neutral': return 'Neutral';
    case 'negative': return 'Negative';
    case 'critical': return 'Critical';
    case 'no-data': return 'No Data';
    default: return mood;
  }
}

function getMoodColor(mood: string): string {
  switch (mood) {
    case 'positive': return 'text-emerald-600 dark:text-emerald-400';
    case 'neutral': return 'text-blue-600 dark:text-blue-400';
    case 'negative': return 'text-amber-600 dark:text-amber-400';
    case 'critical': return 'text-rose-600 dark:text-rose-400';
    default: return 'text-muted-foreground';
  }
}

function getMoodBg(mood: string): string {
  switch (mood) {
    case 'positive': return 'bg-emerald-50 dark:bg-emerald-900/20';
    case 'neutral': return 'bg-blue-50 dark:bg-blue-900/20';
    case 'negative': return 'bg-amber-50 dark:bg-amber-900/20';
    case 'critical': return 'bg-rose-50 dark:bg-rose-900/20';
    default: return 'bg-muted text-muted-foreground';
  }
}

function getScoreColor(score: number | null): string {
  if (score === null) return 'text-muted-foreground';
  if (score >= 70) return 'text-emerald-600 dark:text-emerald-400';
  if (score >= 40) return 'text-blue-600 dark:text-blue-400';
  if (score >= 25) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

function parseSignals(signals: string): Record<string, number> {
  try {
    const parsed = JSON.parse(signals);
    if (parsed && typeof parsed === 'object') return parsed;
    return {};
  } catch {
    return {};
  }
}

function getInitials(first: string, last: string): string {
  return `${first?.[0] ?? ''}${last?.[0] ?? ''}`.toUpperCase();
}

// ==================== Component ====================

export function ProjectSentimentTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const role = useAuthStore((s) => s.user?.role ?? '');
  const canAnalyze = hasRolePermission(role, 'manager');
  const [periodDays, setPeriodDays] = useState(7);

  const { data, isLoading, isError } = useQuery<ProjectSentimentResponse>({
    queryKey: ['project-sentiment', projectId],
    queryFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/sentiment`);
      if (!res.ok) throw new Error('Failed to fetch project sentiment');
      return res.json();
    },
    enabled: !!projectId,
  });

  const analyzeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/projects/${projectId}/sentiment/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodDays }),
      });
      const json = (await res.json()) as AnalyzeResult & { error?: string };
      if (!res.ok) throw new Error(json.error || 'Analysis failed');
      return json;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['project-sentiment', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project-detail', projectId] });
      const aiNote = result.aiSuccess > 0
        ? `${result.aiSuccess} AI-generated`
        : 'rules-based';
      toast.success(
        `Analysis complete: ${result.analyzed} employee(s) analyzed (${aiNote}${result.consentSkipped > 0 ? `, ${result.consentSkipped} skipped (no consent)` : ''}${result.noData > 0 ? `, ${result.noData} no-data` : ''})`
      );
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Analysis failed');
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={HeartPulse}
        title="Could not load sentiment"
        description="Failed to load project sentiment data."
      />
    );
  }

  const records = data?.records ?? [];
  const stats = data?.stats;

  return (
    <div className="space-y-6 mt-4">
      {/* Header: period selector + run analysis */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">Project Sentiment</p>
          <p className="text-xs text-muted-foreground">
            Derived only from time entries logged to this project — never from
            the employee&apos;s other projects or general activity.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(periodDays)} onValueChange={(v) => setPeriodDays(parseInt(v, 10))}>
            <SelectTrigger className="w-32 h-8 text-xs">
              <SelectValue placeholder="Period" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="14">Last 14 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
            </SelectContent>
          </Select>
          {canAnalyze && (
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => analyzeMutation.mutate()}
              disabled={analyzeMutation.isPending}
            >
              {analyzeMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <Play className="h-3.5 w-3.5 mr-1.5" />
              )}
              Run Analysis
            </Button>
          )}
        </div>
      </div>

      {!canAnalyze && (
        <p className="text-xs text-muted-foreground">
          Viewers can view results. Managers and admins can run analysis.
        </p>
      )}

      {/* Stats */}
      {records.length > 0 && stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="border-border/60">
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Avg Score</p>
              <p className={`text-2xl font-bold tabular-nums mt-1 ${getScoreColor(stats.avgScore)}`}>
                {stats.avgScore ?? '—'}
              </p>
            </CardContent>
          </Card>
          <Card className="border-border/60">
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Analyzed</p>
              <p className="text-2xl font-bold tabular-nums mt-1 flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                {stats.analyzedCount}
              </p>
            </CardContent>
          </Card>
          <Card className="border-border/60">
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">No Data</p>
              <p className="text-2xl font-bold tabular-nums mt-1 flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-amber-500" />
                {stats.noDataCount}
              </p>
            </CardContent>
          </Card>
          <Card className="border-border/60">
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Mood Mix</p>
              <div className="mt-2 space-y-1">
                {stats.moodDistribution.map((m) => (
                  <div key={m.mood} className="flex items-center justify-between text-[11px]">
                    <span className={`${getMoodColor(m.mood)}`}>{getMoodLabel(m.mood)}</span>
                    <span className="font-medium tabular-nums">{m.count}</span>
                  </div>
                ))}
                {stats.moodDistribution.length === 0 && (
                  <span className="text-[11px] text-muted-foreground">—</span>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Records per employee */}
      {records.length === 0 ? (
        <EmptyState
          icon={HeartPulse}
          title={canAnalyze ? 'No sentiment yet' : 'Not analyzed'}
          description={
            canAnalyze
              ? 'Run analysis to score project engagement from logged time entries.'
              : 'This project has not been analyzed yet.'
          }
        />
      ) : (
        <div className="space-y-3">
          {records.map((record) => {
            const s = parseSignals(record.signals);
            return (
              <motion.div
                key={record.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className={`bg-card border rounded-xl p-4 shadow-sm border-l-4 ${record.mood === 'no-data' ? 'border-l-muted' : record.score !== null && record.score >= 70 ? 'border-l-emerald-500' : record.score !== null && record.score >= 40 ? 'border-l-blue-500' : record.score !== null && record.score >= 25 ? 'border-l-amber-500' : 'border-l-rose-500'}`}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar className="h-9 w-9">
                      <AvatarFallback className="text-[10px] bg-primary/10 text-primary font-semibold">
                        {getInitials(record.employee.firstName, record.employee.lastName)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">
                        {record.employee.firstName} {record.employee.lastName}
                      </p>
                      <p className="text-[11px] text-muted-foreground truncate">
                        {record.employee.designation || 'Employee'}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`text-xl font-bold tabular-nums ${getScoreColor(record.score)}`}>
                      {record.score ?? '—'}
                    </p>
                    <Badge className={`text-[10px] px-1.5 py-0 ${getMoodBg(record.mood)} ${getMoodColor(record.mood)} border-0`}>
                      {getMoodLabel(record.mood)}
                    </Badge>
                  </div>
                </div>

                {/* Signals (project-scoped) */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground mb-2">
                  {s.hoursThisPeriod !== undefined && (
                    <span className="flex items-center gap-1">
                      <Activity className="h-3 w-3" /> {s.hoursThisPeriod}h logged
                    </span>
                  )}
                  {s.hoursTrend !== undefined && s.hoursTrend !== 0 && (
                    <span className="flex items-center gap-1">
                      <TrendingUp className="h-3 w-3" /> {s.hoursTrend > 0 ? '+' : ''}{s.hoursTrend}% trend
                    </span>
                  )}
                  {s.productiveRatio !== undefined && (
                    <span className="flex items-center gap-1">
                      <BarChart3 className="h-3 w-3" /> {s.productiveRatio}% productive
                    </span>
                  )}
                  {s.entryCount !== undefined && (
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" /> {s.entryCount} entries
                    </span>
                  )}
                </div>

                {/* AI attribution */}
                {record.mood !== 'no-data' && (
                  <p className="text-[10px] text-muted-foreground/70 mb-1.5 flex items-center gap-1">
                    {record.aiProviderUsed && record.aiProviderUsed !== 'rules' ? (
                      <>
                        <Sparkles className="h-3 w-3" /> AI-generated · {record.aiProviderUsed}
                        {record.aiModel ? ` / ${record.aiModel}` : ''}
                      </>
                    ) : (
                      <><Scale className="h-3 w-3" /> Rule-based analysis</>
                    )}
                  </p>
                )}

                <p className="text-xs text-muted-foreground line-clamp-2 mb-1">{record.insight}</p>
                <p className="text-[10px] text-muted-foreground/60">
                  Period: {new Date(record.periodStart).toLocaleDateString()} — {new Date(record.periodEnd).toLocaleDateString()}
                </p>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}
