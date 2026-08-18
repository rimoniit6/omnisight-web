'use client';

import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, keepPreviousData } from '@tanstack/react-query';
import { motion, AnimatePresence, type Variants } from 'framer-motion';
import { toast } from 'sonner';
import {
  HeartPulse,
  Brain,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Flame,
  Eye,
  Clock,
  Activity,
  Users,
  Loader2,
  Search,
  BarChart3,
  ShieldAlert,
  Zap,
  Target,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { PresenceDot } from '@/components/ui/presence-dot';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import { PaginationControls } from '@/components/ui/pagination-controls';
import { useAuthStore } from '@/lib/store';

// ==================== Types ====================
interface SentimentStats {
  avgScore: number;
  positiveCount: number;
  negativeCount: number;
  criticalCount: number;
  neutralCount: number;
  noDataCount: number;
  burnoutRiskCount: number;
  totalAnalyzed: number;
  moodDistribution: { mood: string; count: number }[];
}

interface SentimentRecord {
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
  updatedAt: string;
  employee: {
    id: string;
    firstName: string;
    lastName: string;
    designation: string;
    department: {
      id: string;
      name: string;
    } | null;
  };
}

interface SentimentDetail extends SentimentRecord {
 aiInsight: string | null;
}

interface SentimentApiResponse {
  records: SentimentRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  stats: SentimentStats;
  departments: { id: string; name: string }[];
}

// Shape of GET /api/sentiment/summary (org-wide, employee-level only).
interface SentimentSummary {
  averageScore: number;
  moodDistribution: Record<string, number>;
  departmentBreakdown: Array<{
    departmentId: string;
    departmentName: string;
    averageScore: number | null;
    employeeCount: number;
  }>;
  topAtRisk: Array<{
    id: string;
    employeeName: string;
    designation: string | null;
    department: string | null;
    score: number;
    mood: string;
    insight: string | null;
  }>;
  topPositive: Array<{
    id: string;
    employeeName: string;
    designation: string | null;
    department: string | null;
    score: number;
    mood: string;
  }>;
  riskFactorDistribution: Record<string, number>;
  totalRecords: number;
}

// Shape of a successful analyze run (per-employee AI outcome counters).
interface AnalyzeResult {
  analyzed: number;
  total: number;
  consentSkipped: number;
  noData: number;
  aiSuccess: number;
  aiFallback: { count: number; reasons: string[] };
  aiFailures: { employeeId: string; reason: string }[];
}

// ==================== Utility Functions ====================

function getMoodColor(mood: string) {
  switch (mood) {
    case 'positive':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'neutral':
      return 'text-blue-600 dark:text-blue-400';
    case 'negative':
      return 'text-amber-600 dark:text-amber-400';
    case 'critical':
      return 'text-rose-600 dark:text-rose-400';
    case 'no-data':
      return 'text-muted-foreground';
    default:
      return 'text-muted-foreground';
  }
}

function getMoodBg(mood: string) {
  switch (mood) {
    case 'positive':
      return 'bg-emerald-50 dark:bg-emerald-900/20';
    case 'neutral':
      return 'bg-blue-50 dark:bg-blue-900/20';
    case 'negative':
      return 'bg-amber-50 dark:bg-amber-900/20';
    case 'critical':
      return 'bg-rose-50 dark:bg-rose-900/20';
    case 'no-data':
      return 'bg-muted text-muted-foreground';
    default:
      return 'bg-muted';
  }
}

function getMoodBorder(mood: string) {
  switch (mood) {
    case 'positive':
      return 'border-l-emerald-500';
    case 'neutral':
      return 'border-l-blue-500';
    case 'negative':
      return 'border-l-amber-500';
    case 'critical':
      return 'border-l-rose-500';
    default:
      return 'border-l-muted';
  }
}

function getMoodLabel(mood: string) {
  switch (mood) {
    case 'positive':
      return 'Positive';
    case 'neutral':
      return 'Neutral';
    case 'negative':
      return 'Negative';
    case 'critical':
      return 'Critical';
    case 'no-data':
      return 'No Data';
    default:
      return 'Unknown';
  }
}

function getScoreGradient(score: number | null) {
  if (score === null) return 'text-muted-foreground';
  if (score > 70) return 'text-emerald-600 dark:text-emerald-400';
  if (score > 40) return 'text-blue-600 dark:text-blue-400';
  if (score > 25) return 'text-amber-600 dark:text-amber-400';
  return 'text-rose-600 dark:text-rose-400';
}

function getRiskIcon(factor: string) {
  switch (factor) {
    case 'burnout_risk':
      return Flame;
    case 'disengaged':
      return Eye;
    case 'overworked':
      return Clock;
    case 'underperforming':
      return TrendingDown;
    case 'irregular_hours':
      return AlertTriangle;
    default:
      return ShieldAlert;
  }
}

function getRiskLabel(factor: string) {
  switch (factor) {
    case 'burnout_risk':
      return 'Burnout Risk';
    case 'disengaged':
      return 'Disengaged';
    case 'overworked':
      return 'Overworked';
    case 'underperforming':
      return 'Underperforming';
    case 'irregular_hours':
      return 'Irregular Hours';
    default:
      return factor.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
  }
}

function parseJSON<T>(str: string | null, fallback: T): T {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/**
 * Normalizes a persisted signals value into a plain object regardless of its
 * shape. The LIST API returns `signals` as a raw JSON string; the DETAIL API
 * returns it already-parsed as an object. Parsing an object with JSON.parse
 * would throw (and fall back to {}), silently blanking every Key Signal — so
 * accept both shapes, mirroring parseRiskFactors. Never yields a non-object.
 */
function parseSignals(raw: string | null | Record<string, unknown>): Record<string, number | null | undefined> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, number | null | undefined>;
  }
  return parseJSON<Record<string, number | null | undefined>>(raw as string | null, {});
}

/**
 * Display-normalizes a persisted signals object into the shape the UI renders.
 *
 * The analyzer persists employee-level signals as { productivityTrend,
 * productiveHoursThisWeek, productiveHoursLastWeek, totalHoursThisWeek,
 * idleHoursThisWeek, idleRate, ... } — the UI used to read nonexistent keys
 * (productivityPct/totalHours/productiveHours) and silently rendered 0%/0h.
 *
 * - productivityPct is DERIVED from real persisted hours: productive share of
 *   total (null when there is no activity data — never a fabricated 0).
 * - totalHours / productiveHours map to the persisted weekly values.
 * - Legacy seed rows that stored productivityPct/totalHours directly are
 *   honored as a fallback so no real data regresses.
 */
function normalizeSignals(signals: Record<string, number | null | undefined>) {
  const totalHoursThisWeek = typeof signals.totalHoursThisWeek === 'number' ? signals.totalHoursThisWeek : null;
  const productiveHoursThisWeek = typeof signals.productiveHoursThisWeek === 'number' ? signals.productiveHoursThisWeek : null;
  const productivityPct =
    typeof signals.productivityPct === 'number'
      ? signals.productivityPct
      : totalHoursThisWeek !== null && totalHoursThisWeek > 0 && productiveHoursThisWeek !== null
        ? Math.round((productiveHoursThisWeek / totalHoursThisWeek) * 100)
        : null;
  const totalHours =
    typeof signals.totalHours === 'number' ? signals.totalHours : totalHoursThisWeek;
  const productiveHours =
    typeof signals.productiveHours === 'number' ? signals.productiveHours : productiveHoursThisWeek;
  const idleRate = typeof signals.idleRate === 'number' ? signals.idleRate : null;
  const activityCount = typeof signals.activityCount === 'number' ? signals.activityCount : null;
  return { productivityPct, totalHours, productiveHours, idleRate, activityCount };
}

// Normalizes a stored riskFactors value into a flat string[] regardless of its
// persisted shape (JSON string, already-parsed array, nested array, or bare
// string). Never crashes on non-array data and never yields non-string elements
// for getRiskLabel/getRiskIcon. Handles both the list API (raw JSON string) and
// the detail API (already-parsed array).
function parseRiskFactors(raw: string | null | unknown): string[] {
  const parsed = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? parseJSON<unknown>(raw, null)
      : null;
  if (!Array.isArray(parsed)) {
    if (typeof parsed === 'string' && parsed) return [parsed];
    return [];
  }
  const flat: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      flat.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    }
  };
  parsed.forEach(visit);
  return flat;
}

// ==================== Animations ====================

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.04 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' } },
};

// ==================== Sub-Components ====================

function StatSkeleton() {
  return (
    <Card className="bg-card border rounded-xl p-4 md:p-6 shadow-sm">
      <Skeleton className="h-4 w-24 mb-3" />
      <Skeleton className="h-8 w-16 mb-2" />
      <Skeleton className="h-3 w-20" />
    </Card>
  );
}

function CardSkeleton() {
  return (
    <Card className="bg-card border rounded-xl p-4 md:p-6 shadow-sm border-l-4">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div>
            <Skeleton className="h-4 w-32 mb-1" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
        <Skeleton className="h-10 w-16 rounded-lg" />
      </div>
      <Skeleton className="h-3 w-full mb-2" />
      <Skeleton className="h-3 w-3/4 mb-4" />
      <Skeleton className="h-8 w-full rounded" />
    </Card>
  );
}

function ScoreGauge({ score }: { score: number | null }) {
  if (score === null) {
    return (
      <div className="relative inline-flex items-center justify-center">
        <svg width="96" height="96" viewBox="0 0 96 96" className="-rotate-90">
          <circle cx="48" cy="48" r="40" fill="none" stroke="currentColor" className="text-muted/30" strokeWidth="8" />
          <circle cx="48" cy="48" r="40" fill="none" stroke="currentColor" className="text-muted/40" strokeWidth="8" strokeLinecap="round" strokeDasharray={`${2 * Math.PI * 40}`} strokeDashoffset={0} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-muted-foreground">&mdash;</span>
          <span className="text-[10px] text-muted-foreground">no data</span>
        </div>
      </div>
    );
  }
  const color = getScoreGradient(score);
  const circumference = 2 * Math.PI * 40;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width="96" height="96" viewBox="0 0 96 96" className="-rotate-90">
        <circle cx="48" cy="48" r="40" fill="none" stroke="currentColor" className="text-muted/30" strokeWidth="8" />
        <circle
          cx="48" cy="48" r="40" fill="none"
          stroke="currentColor" className={color}
          strokeWidth="8" strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.8s ease' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-2xl font-bold ${color}`}>{score}</span>
        <span className="text-[10px] text-muted-foreground">/ 100</span>
      </div>
    </div>
  );
}

function SignalCard({ label, value, icon: Icon }: { label: string; value: string | number; icon?: React.ElementType }) {
  return (
    <div className="bg-muted/50 rounded-lg p-3 flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <span className="text-sm font-semibold text-foreground">{value}</span>
    </div>
  );
}

// ==================== Main Component ====================

export function SentimentPage() {
  const [moodFilter, setMoodFilter] = useState<string>('all');
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<string>('newest');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const PAGE_SIZE = 12;

  // Debounced search (350ms): typing updates `search` immediately, but the
  // API request fires only once the input settles — never once per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Viewers are read-only: analysis runs cost AI credits, so the trigger is
  // hidden for them — the analyze route independently enforces manager+.
  const currentUser = useAuthStore((s) => s.user);
  const canRunAnalysis = currentUser?.role !== 'viewer' && currentUser?.role !== 'employee';

  // Filters/sort/pagination are applied SERVER-side: the API returns one
  // page of the latest-per-employee records and the stats reflect the full
  // filtered set, never a truncated client-side copy.
  //
  // `placeholderData: keepPreviousData` preserves the currently displayed
  // results while a new search/filter request is in flight (no full-page
  // skeleton on every keystroke). React Query keys requests by the debounced
  // value, so a stale earlier response can never replace a newer one.
  const { data, isLoading, isFetching, error, refetch } = useQuery<SentimentApiResponse>({
    queryKey: ['sentiment', page, moodFilter, deptFilter, debouncedSearch, sort],
    queryFn: async () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        sort,
      });
      if (moodFilter !== 'all') params.set('mood', moodFilter);
      if (deptFilter !== 'all') params.set('departmentId', deptFilter);
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      const res = await fetch(`/api/sentiment?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`Failed to load sentiment data (${res.status})`);
      }
      return res.json();
    },
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });

  // Fetch employee detail for dialog (the API wraps the record in { data })
  const { data: detail, isLoading: detailLoading } = useQuery<SentimentDetail>({
    queryKey: ['sentiment-detail', selectedId],
    queryFn: async () => {
      const res = await fetch(`/api/sentiment/${selectedId}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error ?? `Failed to load sentiment details (${res.status})`);
      }
      return (json.data ?? json) as SentimentDetail;
    },
    enabled: !!selectedId,
  });

  // Run analysis mutation: explicit JSON body, res.ok checked, and the
  // server's per-employee AI outcome counters surface in the toast.
  const analyzeMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/sentiment/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodDays: 7 }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `Analysis failed (${res.status})`);
      return json as AnalyzeResult;
    },
    onSuccess: (res) => {
      refetch();
      const parts = [`Analysis complete for ${res.analyzed ?? res.total ?? 'all'} employee(s)`];
      if (res.aiSuccess > 0) parts.push(`${res.aiSuccess} AI-generated`);
      if (res.aiFallback?.count > 0) parts.push(`${res.aiFallback.count} rules-based`);
      if (res.noData > 0) parts.push(`${res.noData} no-data`);
      if (res.consentSkipped > 0) parts.push(`${res.consentSkipped} skipped (consent)`);
      if (res.aiFailures?.length > 0) parts.push(`${res.aiFailures.length} failed`);
      toast.success(parts.join(' · '));
      if (res.aiFailures?.length > 0) {
        toast.warning(`${res.aiFailures.length} employee(s) could not be analyzed — retry the run to attempt them again.`);
      }
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Analysis failed. Please try again.');
    },
  });

  // Org-wide summary (department breakdown + top at-risk / top positive).
  // This is the UI consumer of /api/sentiment/summary — the endpoint exists
  // to power this panel.
  const { data: summaryData } = useQuery<SentimentSummary>({
    queryKey: ['sentiment-summary'],
    queryFn: async () => {
      const res = await fetch('/api/sentiment/summary');
      if (!res.ok) throw new Error('Failed to fetch sentiment summary');
      return res.json();
    },
  });

  // Records are already filtered/sorted/paginated server-side; the client
  // never applies its own truncating filter over a subset.
  const pageRecords = data?.records ?? [];

  // Mood distribution for the bar. Defensive: only iterate when the API
  // actually returned an array ({ mood, count }[]) — never a plain object.
  const moodDistribution = useMemo(() => {
    const raw = data?.stats?.moodDistribution;
    if (!Array.isArray(raw)) return { positive: 0, neutral: 0, negative: 0, critical: 0, total: 0 };
    const dist: Record<string, number> = { positive: 0, neutral: 0, negative: 0, critical: 0 };
    let total = 0;
    for (const d of raw) {
      if (!d || typeof d.mood !== 'string') continue;
      const count = Number(d.count) || 0;
      dist[d.mood] = (dist[d.mood] || 0) + count;
      total += count;
    }
    return { ...dist, total };
  }, [data]);

  const stats = data?.stats;
  const isAnalyzing = analyzeMutation.isPending;

  // ==================== RENDER ====================

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
            <HeartPulse className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">Sentiment Analysis</h1>
            <p className="text-sm text-muted-foreground">Monitor workforce wellbeing and engagement</p>
          </div>
        </div>
        {canRunAnalysis && (
          <Button
            onClick={() => analyzeMutation.mutate()}
            disabled={isAnalyzing}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
          >
            {isAnalyzing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Brain className="h-4 w-4" />
                Run Analysis
              </>
            )}
          </Button>
        )}
      </div>

      {isLoading && !data ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <StatSkeleton key={i} />
            ))}
          </div>
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        </div>
      ) : !data ? (
        error ? (
          <EmptyState
            icon={AlertTriangle}
            title="Failed to load sentiment data"
            description="There was an error loading the sentiment analysis data. Please try again."
            action={{ label: 'Retry', onClick: () => refetch() }}
          />
        ) : (
          <EmptyState
            icon={HeartPulse}
            title="No sentiment data yet"
            description="Run your first analysis to generate sentiment scores for all employees."
            action={canRunAnalysis ? { label: 'Run Analysis', onClick: () => analyzeMutation.mutate() } : undefined}
          />
        )
      ) : (
        <motion.div variants={containerVariants} initial="hidden" animate="visible" className="space-y-6">
          {/* Stats Bar */}
          <motion.div variants={itemVariants} className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {/* Avg Sentiment */}
            <Card className="bg-card border rounded-xl p-4 md:p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Target className="h-4 w-4 text-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Avg Sentiment</span>
              </div>
              <div className="flex items-baseline gap-1">
                <span className={`text-2xl font-bold ${getScoreGradient(stats?.avgScore ?? 0)}`}>
                  {stats?.avgScore?.toFixed(0) ?? 0}
                </span>
                <span className="text-xs text-muted-foreground">/ 100</span>
              </div>
              <Progress value={stats?.avgScore ?? 0} className="mt-2 h-1.5 [&>[data-slot=progress-indicator]]:bg-emerald-500" />
            </Card>

            {/* Positive */}
            <Card className="bg-card border rounded-xl p-4 md:p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="h-4 w-4 text-emerald-500" />
                <span className="text-xs font-medium text-muted-foreground">Positive</span>
              </div>
              <span className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{stats?.positiveCount ?? 0}</span>
              <div className="mt-2 flex items-center gap-2">
                <Progress
                  value={stats?.totalAnalyzed ? ((stats.positiveCount ?? 0) / stats.totalAnalyzed) * 100 : 0}
                  className="h-1.5 flex-1 [&>[data-slot=progress-indicator]]:bg-emerald-500"
                />
                <span className="text-[10px] text-muted-foreground w-8 text-right">
                  {stats?.totalAnalyzed ? Math.round(((stats.positiveCount ?? 0) / stats.totalAnalyzed) * 100) : 0}%
                </span>
              </div>
            </Card>

            {/* At Risk */}
            <Card className="bg-card border rounded-xl p-4 md:p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <ShieldAlert className="h-4 w-4 text-rose-500" />
                <span className="text-xs font-medium text-muted-foreground">At Risk</span>
              </div>
              <span className="text-2xl font-bold text-rose-600 dark:text-rose-400">
                {(stats?.negativeCount ?? 0) + (stats?.criticalCount ?? 0)}
              </span>
              <div className="mt-2 flex items-center gap-2">
                <Progress
                  value={stats?.totalAnalyzed ? (((stats?.negativeCount ?? 0) + (stats?.criticalCount ?? 0)) / stats.totalAnalyzed) * 100 : 0}
                  className="h-1.5 flex-1 [&>[data-slot=progress-indicator]]:bg-rose-500"
                />
                <span className="text-[10px] text-muted-foreground w-8 text-right">
                  {stats?.totalAnalyzed ? Math.round((((stats?.negativeCount ?? 0) + (stats?.criticalCount ?? 0)) / stats.totalAnalyzed) * 100) : 0}%
                </span>
              </div>
            </Card>

            {/* Burnout Risk */}
            <Card className="bg-card border rounded-xl p-4 md:p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                <span className="text-xs font-medium text-muted-foreground">Burnout Risk</span>
              </div>
              <span className="text-2xl font-bold text-amber-600 dark:text-amber-400">{stats?.burnoutRiskCount ?? 0}</span>
              <p className="text-[10px] text-muted-foreground mt-1">Employees flagged</p>
            </Card>

            {/* Analyzed */}
            <Card className="bg-card border rounded-xl p-4 md:p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Users className="h-4 w-4 text-blue-500" />
                <span className="text-xs font-medium text-muted-foreground">Analyzed</span>
              </div>
              <span className="text-2xl font-bold text-blue-600 dark:text-blue-400">{stats?.totalAnalyzed ?? 0}</span>
              <p className="text-[10px] text-muted-foreground mt-1">
                {stats?.totalAnalyzed
                  ? stats.noDataCount > 0
                    ? `${stats.noDataCount} without data`
                    : 'Total employees'
                  : 'Total employees'}
              </p>
            </Card>
          </motion.div>

          {/* Mood Distribution Bar */}
          <motion.div variants={itemVariants}>
            <Card className="bg-card border rounded-xl p-4 md:p-6 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-foreground">Mood Distribution</h3>
                <span className="text-xs text-muted-foreground">{moodDistribution.total} total</span>
              </div>
              <div className="flex h-5 w-full rounded-full overflow-hidden bg-muted/50">
                {moodDistribution.total > 0 ? (
                  <>
                    <div
                      className="bg-emerald-500 transition-all duration-500"
                      style={{ width: `${((moodDistribution.positive ?? 0) / moodDistribution.total) * 100}%` }}
                    />
                    <div
                      className="bg-blue-500 transition-all duration-500"
                      style={{ width: `${((moodDistribution.neutral ?? 0) / moodDistribution.total) * 100}%` }}
                    />
                    <div
                      className="bg-amber-500 transition-all duration-500"
                      style={{ width: `${((moodDistribution.negative ?? 0) / moodDistribution.total) * 100}%` }}
                    />
                    <div
                      className="bg-rose-500 transition-all duration-500"
                      style={{ width: `${((moodDistribution.critical ?? 0) / moodDistribution.total) * 100}%` }}
                    />
                  </>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-4 mt-3">
                <div className="flex items-center gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  <span className="text-xs text-muted-foreground">Positive ({moodDistribution.positive})</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full bg-blue-500" />
                  <span className="text-xs text-muted-foreground">Neutral ({moodDistribution.neutral})</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                  <span className="text-xs text-muted-foreground">Negative ({moodDistribution.negative})</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full bg-rose-500" />
                  <span className="text-xs text-muted-foreground">Critical ({moodDistribution.critical})</span>
                </div>
              </div>
            </Card>
          </motion.div>

          {/* Team Summary — consumes GET /api/sentiment/summary (department
              breakdown + top at-risk / top positive from real records). */}
          {summaryData && (summaryData.departmentBreakdown.length > 0 || summaryData.topAtRisk.length > 0) && (
            <motion.div variants={itemVariants} className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Department breakdown */}
              {summaryData.departmentBreakdown.length > 0 && (
                <Card className="bg-card border rounded-xl p-4 md:p-5 shadow-sm">
                  <p className="text-xs font-medium text-muted-foreground mb-3">Department Averages</p>
                  <div className="space-y-2.5">
                    {summaryData.departmentBreakdown.slice(0, 6).map((d) => (
                      <div key={d.departmentId} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium truncate">{d.departmentName}</span>
                          <span className="tabular-nums">{d.averageScore !== null ? `${d.averageScore}` : '—'}</span>
                        </div>
                        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${(d.averageScore ?? 0) >= 70 ? 'bg-emerald-500' : (d.averageScore ?? 0) >= 40 ? 'bg-blue-500' : (d.averageScore ?? 0) >= 25 ? 'bg-amber-500' : 'bg-rose-500'}`}
                            style={{ width: `${Math.max(2, Math.min(100, d.averageScore ?? 0))}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Top at-risk */}
              {summaryData.topAtRisk.length > 0 && (
                <Card className="bg-card border rounded-xl p-4 md:p-5 shadow-sm">
                  <p className="text-xs font-medium text-muted-foreground mb-3">Top At-Risk</p>
                  <div className="space-y-2">
                    {summaryData.topAtRisk.map((r) => (
                      <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{r.employeeName}</p>
                          <p className="text-[10px] text-muted-foreground truncate">{r.department || '—'}</p>
                        </div>
                        <Badge className={`shrink-0 text-[10px] px-1.5 py-0 ${getMoodBg(r.mood)} ${getMoodColor(r.mood)} border-0`}>
                          {r.score}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Top positive */}
              {summaryData.topPositive.length > 0 && (
                <Card className="bg-card border rounded-xl p-4 md:p-5 shadow-sm">
                  <p className="text-xs font-medium text-muted-foreground mb-3">Top Positive</p>
                  <div className="space-y-2">
                    {summaryData.topPositive.map((r) => (
                      <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <p className="font-medium truncate">{r.employeeName}</p>
                          <p className="text-[10px] text-muted-foreground truncate">{r.department || '—'}</p>
                        </div>
                        <Badge className={`shrink-0 text-[10px] px-1.5 py-0 ${getMoodBg(r.mood)} ${getMoodColor(r.mood)} border-0`}>
                          {r.score}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </motion.div>
          )}

          {/* Filter Toolbar (server-side: every change refetches the API) */}
          <motion.div variants={itemVariants} className="flex flex-col sm:flex-row gap-3">
            <Select value={moodFilter} onValueChange={(v) => { setMoodFilter(v); setPage(1); }}>
              <SelectTrigger className="w-full sm:w-[160px]">
                <SelectValue placeholder="All Moods" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Moods</SelectItem>
                <SelectItem value="positive">Positive</SelectItem>
                <SelectItem value="neutral">Neutral</SelectItem>
                <SelectItem value="negative">Negative</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="no-data">No Data</SelectItem>
              </SelectContent>
            </Select>

            <Select value={deptFilter} onValueChange={(v) => { setDeptFilter(v); setPage(1); }}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="All Departments" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Departments</SelectItem>
                {(data?.departments ?? []).map(d => (
                  <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search employee..."
                value={search}
                onChange={e => { setSearch(e.target.value); setPage(1); }}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 pl-9 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>

            <Select value={sort} onValueChange={(v) => { setSort(v); setPage(1); }}>
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest</SelectItem>
                <SelectItem value="score_desc">Score (High to Low)</SelectItem>
                <SelectItem value="score_asc">Score (Low to High)</SelectItem>
                <SelectItem value="name_asc">Name A-Z</SelectItem>
              </SelectContent>
            </Select>

            {/* Subtle in-flight indicator: a background refetch (search/filter/
                pagination) must NOT blank the page — only this hint shows. */}
            {isFetching && !isLoading && (
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground shrink-0">
                <Loader2 className="h-3 w-3 animate-spin" />
                Updating…
              </div>
            )}
          </motion.div>

          {/* Refetch failed but we still hold previous results — surface the
              error truthfully without hiding the stale-but-visible data. */}
          {error && data && (
            <div className="flex items-center justify-between rounded-lg border border-rose-200 bg-rose-50/50 dark:border-rose-800/50 dark:bg-rose-900/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
              <span>Could not refresh results — showing previous data.</span>
              <button onClick={() => refetch()} className="underline font-medium">Retry</button>
            </div>
          )}

          {/* Employee Sentiment Cards */}
          <AnimatePresence mode="popLayout">
            {pageRecords.length === 0 ? (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                {search.trim() || moodFilter !== 'all' || deptFilter !== 'all' ? (
                  <EmptyState
                    icon={Search}
                    title="No matching employees"
                    description="Try adjusting your filters or search query."
                    action={{ label: 'Clear Filters', onClick: () => { setMoodFilter('all'); setDeptFilter('all'); setSearch(''); setPage(1); } }}
                  />
                ) : (
                  <EmptyState
                    icon={HeartPulse}
                    title="No sentiment data yet"
                    description="Run your first analysis to generate sentiment scores for all employees."
                    action={canRunAnalysis ? { label: 'Run Analysis', onClick: () => analyzeMutation.mutate() } : undefined}
                  />
                )}
              </motion.div>
            ) : (
              <motion.div
                key="grid"
                variants={containerVariants}
                initial="hidden"
                animate="visible"
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
              >
                {pageRecords.map(record => {
                  const signals = normalizeSignals(parseSignals(record.signals as string | null | Record<string, unknown>));
                  const risks = parseRiskFactors(record.riskFactors);
                  const initials = `${record.employee?.firstName?.[0] ?? ''}${record.employee?.lastName?.[0] ?? ''}`.toUpperCase();

                  return (
                    <motion.div
                      key={record.id}
                      variants={itemVariants}
                      layout
                      className={`bg-card border rounded-xl p-4 md:p-6 shadow-sm border-l-4 ${getMoodBorder(record.mood)}`}
                    >
                      {/* Top row: employee info + score */}
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Avatar className="h-10 w-10">
                            <AvatarFallback className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 text-xs font-semibold">
                              {initials}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground truncate">
                              {record.employee?.id && <PresenceDot employeeId={record.employee.id} />}
                              <span className="truncate">{record.employee?.firstName} {record.employee?.lastName}</span>
                            </h3>
                            <p className="text-xs text-muted-foreground truncate">
                              {record.employee?.designation}
                            </p>
                          </div>
                        </div>
                        <div className={`text-2xl font-bold tabular-nums ${getScoreGradient(record.score)}`}>
                          {record.score ?? '—'}
                        </div>
                      </div>

                      {/* Department badge + Mood badge + AI origin */}
                      <div className="flex flex-wrap items-center gap-2 mb-3">
                        {record.employee?.department && (
                          <Badge variant="secondary" className="text-[10px] px-2 py-0">
                            {record.employee.department.name}
                          </Badge>
                        )}
                        <Badge className={`text-[10px] px-2 py-0 ${getMoodBg(record.mood)} ${getMoodColor(record.mood)} border-0`}>
                          {getMoodLabel(record.mood)}
                        </Badge>
                        {record.mood !== 'no-data' && (
                          <span className="text-[10px] text-muted-foreground/70">
                            {record.aiProviderUsed && record.aiProviderUsed !== 'rules'
                              ? `AI-generated · ${record.aiProviderUsed}`
                              : 'Rule-based'}
                          </span>
                        )}
                      </div>

                      {/* Key signals — real persisted values; null renders "—" */}
                      <div className="flex gap-3 text-[11px] text-muted-foreground mb-3">
                        {signals.productivityPct !== null && (
                          <span className="flex items-center gap-1">
                            <Zap className="h-3 w-3" />
                            {signals.productivityPct}% productivity
                          </span>
                        )}
                        {signals.idleRate !== null && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {signals.idleRate}% idle
                          </span>
                        )}
                        {signals.totalHours !== null && (
                          <span className="flex items-center gap-1">
                            <Activity className="h-3 w-3" />
                            {signals.totalHours}h total
                          </span>
                        )}
                      </div>

                      {/* Risk factors */}
                      {risks.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-3">
                          {risks.map(risk => {
                            const RiskIcon = getRiskIcon(risk);
                            return (
                              <Badge key={risk} variant="destructive" className="text-[10px] px-1.5 py-0 gap-1">
                                <RiskIcon className="h-2.5 w-2.5" />
                                {getRiskLabel(risk)}
                              </Badge>
                            );
                          })}
                        </div>
                      )}

                      {/* Insight */}
                      <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                        {record.insight}
                      </p>

                      {/* Recommendation */}
                      <p className="text-[11px] italic text-muted-foreground/80 line-clamp-1 mb-3">
                        {record.recommendation}
                      </p>

                      {/* Freshness: the period this analysis covers */}
                      <p className="text-[10px] text-muted-foreground/60 mb-3">
                        Period: {new Date(record.periodStart).toLocaleDateString()} &mdash; {new Date(record.periodEnd).toLocaleDateString()}
                      </p>

                      {/* View Details button */}
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full text-primary border-primary/30 hover:bg-primary/10 hover:text-primary text-xs"
                        onClick={() => setSelectedId(record.id)}
                      >
                        View Details
                      </Button>
                    </motion.div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Server-side pagination (one page of latest-per-employee records) */}
          {(data?.totalPages ?? 0) > 0 && (
            <PaginationControls
              currentPage={data?.page ?? 1}
              totalPages={data?.totalPages ?? 0}
              totalItems={data?.total ?? 0}
              onPageChange={setPage}
              pageSize={PAGE_SIZE}
            />
          )}
        </motion.div>
      )}

      {/* Detail Dialog */}
      <Dialog open={!!selectedId} onOpenChange={open => { if (!open) setSelectedId(null); }}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          {detailLoading ? (
            <div className="space-y-4 py-4">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-24 w-24 rounded-full mx-auto" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <div className="grid grid-cols-2 gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            </div>
          ) : detail ? (
            <>
              <DialogHeader>
                <DialogTitle>Employee Sentiment Details</DialogTitle>
                <DialogDescription>
                  Detailed sentiment analysis for {detail.employee?.firstName} {detail.employee?.lastName}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-5 mt-2">
                {/* Employee info header */}
                <div className="flex items-center gap-4">
                  <Avatar className="h-14 w-14">
                    <AvatarFallback className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300 text-lg font-semibold">
                      {`${detail.employee?.firstName?.[0] ?? ''}${detail.employee?.lastName?.[0] ?? ''}`.toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <h3 className="text-base font-semibold text-foreground">
                      {detail.employee?.firstName} {detail.employee?.lastName}
                    </h3>
                    <p className="text-sm text-muted-foreground">{detail.employee?.designation}</p>
                    {detail.employee?.department && (
                      <Badge variant="secondary" className="mt-1 text-xs">{detail.employee.department.name}</Badge>
                    )}
                  </div>
                </div>

                <Separator />

                {/* Score gauge + mood */}
                <div className="flex items-center justify-center gap-6">
                  <ScoreGauge score={detail.score} />
                  <div className="space-y-2">
                    <Badge className={`${getMoodBg(detail.mood)} ${getMoodColor(detail.mood)} border-0 text-sm px-3 py-1`}>
                      {getMoodLabel(detail.mood)}
                    </Badge>
                    {/* Accurate origin labeling: AI-generated only when a
                        provider actually produced the insight */}
                    <p className="text-xs text-muted-foreground">
                      {detail.mood === 'no-data'
                        ? 'No activity data — not analyzed'
                        : detail.aiProviderUsed && detail.aiProviderUsed !== 'rules'
                          ? <>AI-generated · <span className="font-medium text-foreground">{detail.aiProviderUsed}{detail.aiModel ? ` / ${detail.aiModel}` : ''}</span></>
                          : 'Rule-based analysis'}
                    </p>
                  </div>
                </div>

                <Separator />

                {/* Signals grid */}
                <div>
                  <h4 className="text-sm font-semibold text-foreground mb-3">Key Signals</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {(() => {
                      const s = normalizeSignals(parseSignals(detail.signals as string | null | Record<string, unknown>));
                      return (
                        <>
                          <SignalCard label="Productivity" value={s.productivityPct !== null ? `${s.productivityPct}%` : '—'} icon={Zap} />
                          <SignalCard label="Idle Rate" value={s.idleRate !== null ? `${s.idleRate}%` : '—'} icon={Clock} />
                          <SignalCard label="Total Hours" value={s.totalHours !== null ? `${s.totalHours}h` : '—'} icon={Activity} />
                          <SignalCard label="Productive Hrs" value={s.productiveHours !== null ? `${s.productiveHours}h` : '—'} icon={TrendingUp} />
                          <SignalCard label="Activities" value={s.activityCount ?? '—'} icon={BarChart3} />
                          <SignalCard label="Score" value={detail.score !== null ? `${detail.score}/100` : '—'} icon={Target} />
                        </>
                      );
                    })()}
                  </div>
                </div>

                {/* Risk factors */}
                {(() => {
                  const risks = parseRiskFactors(detail.riskFactors);
                  if (risks.length === 0) return null;
                  return (
                    <div>
                      <h4 className="text-sm font-semibold text-foreground mb-3">Risk Factors</h4>
                      <div className="space-y-2">
                        {risks.map(risk => {
                          const RiskIcon = getRiskIcon(risk);
                          return (
                            <div key={risk} className="flex items-center gap-3 p-2.5 rounded-lg bg-rose-50 dark:bg-rose-900/15">
                              <RiskIcon className="h-4 w-4 text-rose-500" />
                              <span className="text-sm font-medium text-rose-700 dark:text-rose-300">{getRiskLabel(risk)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* AI Insight */}
                {detail.insight && (
                  <div>
                    <h4 className="text-sm font-semibold text-foreground mb-2">AI Insight</h4>
                    <div className="relative rounded-lg bg-muted/50 p-4">
                      <div className="absolute top-2 left-3 text-3xl text-muted-foreground/30 font-serif">&ldquo;</div>
                      <p className="text-sm text-foreground/90 pl-6 italic">
                        {detail.insight}
                      </p>
                    </div>
                  </div>
                )}

                {/* Recommendation */}
                {detail.recommendation && (
                  <div>
                    <h4 className="text-sm font-semibold text-foreground mb-2">Recommendation</h4>
                    <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-50 dark:bg-emerald-900/15">
                      <Zap className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                      <p className="text-sm text-emerald-700 dark:text-emerald-300">
                        {detail.recommendation}
                      </p>
                    </div>
                  </div>
                )}

                {/* Period info */}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    Period: {new Date(detail.periodStart).toLocaleDateString()} — {new Date(detail.periodEnd).toLocaleDateString()}
                  </span>
                  <span>
                    Last updated: {new Date(detail.updatedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
