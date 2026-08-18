'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { InsightCard } from './insight-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import {
  Sparkles, RefreshCw, Brain, TrendingUp, Gauge, AlertTriangle,
  Lightbulb, Zap, CheckCircle2, XCircle, ArrowRight, ShieldAlert,
  Clock, Filter, Database, Bot,
} from 'lucide-react';
import { toast } from 'sonner';
import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';

const typeIcons: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
  productivity: { icon: TrendingUp, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
  efficiency: { icon: Gauge, color: 'text-teal-600 dark:text-teal-400', bg: 'bg-teal-100 dark:bg-teal-900/30' },
  risk: { icon: AlertTriangle, color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-100 dark:bg-rose-900/30' },
  opportunity: { icon: Lightbulb, color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/30' },
};

const categoryFilterChips = [
  { value: 'all', label: 'All Categories' },
  { value: 'productivity', label: 'Productivity' },
  { value: 'anomaly', label: 'Anomaly' },
  { value: 'recommendation', label: 'Recommendation' },
  { value: 'trend', label: 'Trend' },
  { value: 'risk', label: 'Risk' },
];

interface AnalysisInsight {
  title: string;
  content: string;
  type: string;
  confidence: number;
  recommendation: string;
  category: string;
}

// Unified analysis contract (from the engine): mode is 'AI_ANALYSIS' when a
// real provider produced a validated response, 'DATA_SUMMARY' when the
// deterministic database-backed fallback was used.
interface AnalysisFinding {
  type: string;
  severity?: string;
  title: string;
  description?: string;
  statement?: string;
  employeeId?: string | null;
  projectId?: string | null;
  evidence?: { metric: string; value: string; comparison?: string } | Record<string, number | string> | null;
}
interface AnalysisEvidenceRow { label: string; value: string }
interface AnalysisOutput {
  mode: 'AI_ANALYSIS' | 'DATA_SUMMARY';
  title: string;
  summary: string;
  findings: AnalysisFinding[];
  evidence: AnalysisEvidenceRow[];
}
interface AiRecommendation { priority: string; title: string; description: string }
// Legacy AI-only view (ai.keyFindings etc.) — kept for backward compat with
// older persisted payloads; the page now renders via `analysis`.
interface AiFinding {
  type: string;
  severity: string;
  title: string;
  description: string;
  employeeId?: string;
  projectId?: string;
  evidence?: { metric: string; value: string; comparison?: string };
}
interface AiAnalysis {
  summary: string;
  overallAssessment: string;
  keyFindings: AiFinding[];
  recommendations: AiRecommendation[];
}

interface MeasuredEmployee {
  employeeId: string;
  name: string;
  designation: string | null;
  department: string | null;
  status: string;
  productiveSeconds: number;
  neutralSeconds: number;
  unproductiveSeconds: number;
  totalSeconds: number;
  activityCount: number;
  productivityPct: number;
  topApps: { name: string; seconds: number }[];
  projects: { projectId: string; name: string; hours: number }[];
}

interface AiMeta {
  aiStatus: 'generated' | 'disabled' | 'not_configured' | 'error';
  aiError: string | null;
  fallbackReason: string | null;
  fallbackUsed: boolean;
  aiAvailable: boolean;
  source: 'database' | 'database+ai';
  provider: string | null;
  model: string | null;
  generatedAt: string;
  period: { start: string; end: string };
  filters: { employeeId: string | null; departmentId: string | null; projectId: string | null };
  datasetHash: string;
  consentSkipped: number;
  truncated: boolean;
}

interface InsightFilters {
  from?: string;
  to?: string;
  employeeId?: string;
  departmentId?: string;
  projectId?: string;
}

function fmtSec(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(2)}h`;
  return `${Math.round(seconds / 60)}m`;
}

function fmtDay(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

function AnalysisSkeleton() {
  return (
    <div className="space-y-4 animate-in fade-in duration-500">
      <div className="flex items-center gap-3 mb-2">
        <div className="h-10 w-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
          <Brain className="w-5 h-5 text-emerald-600 dark:text-emerald-400 animate-pulse" />
        </div>
        <div>
          <div className="h-4 w-48 bg-muted rounded animate-pulse" />
          <div className="h-3 w-32 bg-muted/50 rounded animate-pulse mt-1.5" />
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="border">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-lg bg-muted animate-pulse shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-3/4 bg-muted rounded animate-pulse" />
                  <div className="h-3 w-full bg-muted/50 rounded animate-pulse" />
                  <div className="h-3 w-5/6 bg-muted/50 rounded animate-pulse" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function severityColor(sev: string): string {
  if (sev === 'high') return 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300';
  if (sev === 'medium') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';
  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
}

function findingTypeConfig(type: string): { icon: React.ElementType; color: string; bg: string } {
  return typeIcons[type] || typeIcons.opportunity;
}

export function InsightsPage() {
  const queryClient = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [analysisRequested, setAnalysisRequested] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [refreshingInsights, setRefreshingInsights] = useState(false);

  // ── Filters (server-side) ────────────────────────────────────────────
  const [period, setPeriod] = useState<'7d' | '30d' | 'custom'>('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [employeeId, setEmployeeId] = useState<string>('');
  const [departmentId, setDepartmentId] = useState<string>('');
  const [projectId, setProjectId] = useState<string>('');

  const filters: InsightFilters = useMemo(() => {
    const now = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (period === 'custom' && customFrom && customTo) {
      return { from: customFrom, to: customTo, employeeId: employeeId || undefined, departmentId: departmentId || undefined, projectId: projectId || undefined };
    }
    const days = period === '30d' ? 30 : 7;
    const from = new Date(now.getTime() - (days - 1) * 86_400_000);
    return { from: iso(from), to: iso(now), employeeId: employeeId || undefined, departmentId: departmentId || undefined, projectId: projectId || undefined };
  }, [period, customFrom, customTo, employeeId, departmentId, projectId]);

  // ── Filter options (org-scoped lists for the selects) ────────────────
  const { data: employees } = useQuery({
    queryKey: ['insight-employees'],
    queryFn: async () => {
      const res = await fetch('/api/employees?pageSize=200');
      const json = await res.json();
      return (json.data || []) as Array<{ id: string; firstName: string; lastName: string; employeeId: string }>;
    },
  });
  const { data: departments } = useQuery({
    queryKey: ['insight-departments'],
    queryFn: async () => {
      const res = await fetch('/api/departments');
      const json = await res.json();
      return (json.data || []) as Array<{ id: string; name: string }>;
    },
  });
  const { data: projects } = useQuery({
    queryKey: ['insight-projects'],
    queryFn: async () => {
      const res = await fetch('/api/projects?pageSize=200&includeArchived=true');
      const json = await res.json();
      return (json.data || []) as Array<{ id: string; name: string }>;
    },
  });

  // ── Persisted insight feed ───────────────────────────────────────────
  const { data, isLoading } = useQuery({
    queryKey: ['insights'],
    queryFn: async () => {
      const res = await fetch('/api/insights');
      const json = await res.json();
      return json.data;
    },
  });

  // ── Deep Analysis (real AI + measured) ───────────────────────────────
  const filterKey = JSON.stringify(filters);
  const { data: analysisData, isLoading: analysisLoading, isFetching: analysisFetching, refetch: refetchAnalysis } = useQuery({
    queryKey: ['ai-analysis', filterKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.from) params.set('from', filters.from);
      if (filters.to) params.set('to', filters.to);
      if (filters.employeeId) params.set('employeeId', filters.employeeId);
      if (filters.departmentId) params.set('departmentId', filters.departmentId);
      if (filters.projectId) params.set('projectId', filters.projectId);
      const res = await fetch(`/api/insights/ai-analysis?${params.toString()}`);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Analysis failed');
      }
      return res.json();
    },
    enabled: analysisRequested,
    staleTime: 30 * 1000,
  });

  const filteredInsights = useMemo(() => {
    const insights = data || [];
    if (categoryFilter === 'all') return insights;
    return insights.filter((i: { type: string }) => i.type === categoryFilter);
  }, [data, categoryFilter]);

  const generateInsight = async () => {
    setGenerating(true);
    try {
      const res = await fetch('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filters),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || 'Failed to generate insight');
        return;
      }
      if (!json.data) {
        // Honest empty state (no employee data) — nothing persisted.
        toast.error(json.message || 'No data available for these filters');
        setAnalysisRequested(true);
        await refetchAnalysis();
        return;
      }
      const mode = json.analysis?.mode ?? json.meta?.mode;
      if (mode === 'DATA_SUMMARY') {
        toast.success('Data summary generated (AI provider unavailable)');
      } else {
        toast.success('New AI insight generated');
      }
      queryClient.invalidateQueries({ queryKey: ['insights'] });
    } catch {
      toast.error('Failed to generate insight');
    } finally {
      setGenerating(false);
    }
  };

  const runAnalysis = () => {
    setAnalysisRequested(true);
    refetchAnalysis().catch(() => {});
  };

  const refreshInsights = async () => {
    setRefreshingInsights(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ['insights'] });
      toast.success('Insights refreshed');
    } finally {
      setRefreshingInsights(false);
    }
  };

  const handleUpdate = async (id: string, status: string) => {
    try {
      const res = await fetch(`/api/insights/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error();
      queryClient.invalidateQueries({ queryKey: ['insights'] });
      toast.success(`Insight ${status}`);
    } catch {
      toast.error('Failed to update insight');
    }
  };

  const insights = data || [];
  const activeCount = insights.filter((i: { status: string }) => i.status === 'active').length;
  const actionedCount = insights.filter((i: { status: string }) => i.status === 'actioned' || i.status === 'acknowledged').length;
  const dismissedCount = insights.filter((i: { status: string }) => i.status === 'dismissed').length;

  // AI analysis + measured data from the engine response
  const ai: AiAnalysis | null = analysisData?.ai ?? null;
  const measured = analysisData?.measured ?? null;
  const meta: AiMeta | null = analysisData?.meta ?? null;
  const analysis: AnalysisOutput | null = analysisData?.analysis ?? null;
  const isAiMode = analysis?.mode === 'AI_ANALYSIS';
  const isDataSummaryMode = analysis?.mode === 'DATA_SUMMARY';
  const rulesData: AnalysisInsight[] = analysisData?.data ?? [];

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Active Insights', value: activeCount, icon: Sparkles, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20' },
          { label: 'Actioned', value: actionedCount, icon: CheckCircle2, color: 'text-teal-600 dark:text-teal-400', bg: 'bg-teal-50 dark:bg-teal-900/20' },
          { label: 'Dismissed', value: dismissedCount, icon: XCircle, color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20' },
        ].map((s) => {
          const Icon = s.icon;
          return (
            <Card key={s.label} className="border shadow-sm">
              <CardContent className="p-3 flex items-center gap-3">
                <div className={`h-9 w-9 rounded-lg ${s.bg} flex items-center justify-center shrink-0`}>
                  <Icon className={`w-4 h-4 ${s.color}`} />
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground font-medium leading-tight">{s.label}</p>
                  <p className="text-xl font-bold leading-tight mt-0.5">{s.value}</p>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Filters */}
      <Card className="border shadow-sm">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Analysis Filters</h2>
            <span className="text-[11px] text-muted-foreground">applied to both measured stats and AI analysis</span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Period</label>
              <select
                value={period}
                onChange={(e) => setPeriod(e.target.value as typeof period)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs"
              >
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="custom">Custom range</option>
              </select>
            </div>
            {period === 'custom' && (
              <>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">From</label>
                  <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="h-9 text-xs" />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">To</label>
                  <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="h-9 text-xs" />
                </div>
              </>
            )}
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Employee</label>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs">
                <option value="">All employees</option>
                {(employees || []).map((e) => (
                  <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Department</label>
              <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs">
                <option value="">All departments</option>
                {(departments || []).map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">Project</label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-xs">
                <option value="">All projects</option>
                {(projects || []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Deep Analysis Section */}
      <Card className="border shadow-sm overflow-hidden">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center">
                <Brain className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="text-sm font-semibold">Deep Analysis</h2>
                <p className="text-[11px] text-muted-foreground">
                  {meta ? `Period: ${fmtDay(meta.period.start)} → ${fmtDay(meta.period.end)}` : 'Select filters and run analysis'}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                onClick={runAnalysis}
                disabled={analysisLoading || analysisFetching}
                className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm"
              >
                {analysisLoading || analysisFetching ? (
                  <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Analyzing...</>
                ) : (
                  <><Zap className="w-4 h-4 mr-2" /> Run Analysis</>
                )}
              </Button>
              <Button variant="outline" size="sm" className="h-9" disabled={generating} onClick={generateInsight}>
                {generating ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
                Generate Insight
              </Button>
            </div>
          </div>

          {meta && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              {isAiMode ? (
                <Badge variant="outline" className="text-[10px] border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-300">
                  <Bot className="w-3 h-3 mr-1" /> AI Analysis
                </Badge>
              ) : isDataSummaryMode ? (
                <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300">
                  <Database className="w-3 h-3 mr-1" /> Data Summary
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px] border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300">
                  <Database className="w-3 h-3 mr-1" /> Measured only
                </Badge>
              )}
              {isDataSummaryMode && (
                <span className="text-amber-600 dark:text-amber-400">
                  AI provider unavailable{meta.fallbackReason ? ` (${meta.fallbackReason})` : ''} — showing database-backed summary
                </span>
              )}
              {meta.provider && meta.model && (
                <span><Bot className="w-3 h-3 inline mr-1" />{meta.provider} · {meta.model}</span>
              )}
              {meta.generatedAt && <span><Clock className="w-3 h-3 inline mr-1" />{new Date(meta.generatedAt).toLocaleString()}</span>}
              {meta.datasetHash && <span><Database className="w-3 h-3 inline mr-1" />dataset {meta.datasetHash}</span>}
              {meta.consentSkipped > 0 && <span>{meta.consentSkipped} employee(s) skipped (no consent)</span>}
              {meta.truncated && <span>Dataset truncated (top 50)</span>}
            </div>
          )}

          {/* Disabled / error states — the experience never dies: a
              database-backed Data Summary is still produced below. */}
          {meta && meta.aiStatus === 'disabled' && (
            <div className="mt-4 p-3 rounded-lg bg-muted/50 border text-sm text-muted-foreground flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-500 shrink-0" />
              AI Insights disabled by administrator — showing a database-backed data summary.
            </div>
          )}
          {meta && meta.aiStatus === 'error' && (
            <div className="mt-4 p-3 rounded-lg bg-amber-50/60 dark:bg-amber-900/10 border border-amber-200/60 text-sm text-amber-700 dark:text-amber-300">
              <span className="font-medium">AI provider unavailable: </span>{meta.aiError}
              <span className="block text-xs mt-0.5">Showing a database-backed data summary instead — measured statistics are not affected.</span>
            </div>
          )}
          {meta && meta.aiStatus === 'not_configured' && (
            <div className="mt-4 p-3 rounded-lg bg-amber-50/60 dark:bg-amber-900/10 border border-amber-200/60 text-sm text-amber-700 dark:text-amber-300">
              <span className="font-medium">AI not configured: </span>{meta.aiError}
              <span className="block text-xs mt-0.5">Showing a database-backed data summary instead.</span>
            </div>
          )}

          <div className="mt-4">
            {analysisLoading || analysisFetching ? (
              <AnalysisSkeleton />
            ) : analysisData ? (
              <div className="space-y-4">
                {/* Measured metrics (deterministic, real data) */}
                {measured && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Database className="w-4 h-4 text-slate-500" />
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Measured (deterministic)</h3>
                    </div>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <Card className="border">
                        <CardContent className="p-3">
                          <p className="text-[10px] text-muted-foreground">Productivity</p>
                          <p className="text-lg font-bold">{measured.totals.productivityPct}%</p>
                          <p className="text-[10px] text-muted-foreground">{fmtSec(measured.totals.productiveSeconds)} productive</p>
                        </CardContent>
                      </Card>
                      <Card className="border">
                        <CardContent className="p-3">
                          <p className="text-[10px] text-muted-foreground">Tracked time</p>
                          <p className="text-lg font-bold">{fmtSec(measured.totals.totalSeconds)}</p>
                          <p className="text-[10px] text-muted-foreground">{measured.totals.activityCount} events</p>
                        </CardContent>
                      </Card>
                      <Card className="border">
                        <CardContent className="p-3">
                          <p className="text-[10px] text-muted-foreground">Employees analyzed</p>
                          <p className="text-lg font-bold">{measured.employees.length}</p>
                          <p className="text-[10px] text-muted-foreground">{measured.org.name}</p>
                        </CardContent>
                      </Card>
                      <Card className="border">
                        <CardContent className="p-3">
                          <p className="text-[10px] text-muted-foreground">Projects</p>
                          <p className="text-lg font-bold">{measured.projects.length}</p>
                          <p className="text-[10px] text-muted-foreground">with logged hours</p>
                        </CardContent>
                      </Card>
                    </div>
                    {/* Per-employee measured rows */}
                    <div className="mt-3 space-y-1.5 max-h-72 overflow-y-auto custom-scrollbar">
                      {measured.employees.slice(0, 15).map((e: MeasuredEmployee) => (
                        <div key={e.employeeId} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/40 text-xs">
                          <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center font-semibold shrink-0">
                            {e.name.split(' ').map((n) => n[0]).join('').slice(0, 2)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium truncate">{e.name} <span className="text-muted-foreground font-normal">· {e.department || 'Unassigned'}</span></p>
                            <p className="text-[10px] text-muted-foreground truncate">
                              {fmtSec(e.totalSeconds)} tracked · {e.activityCount} events
                              {e.projects.length > 0 && <> · {e.projects.map((p) => p.name).join(', ')}</>}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className={`font-semibold ${e.productivityPct >= 70 ? 'text-emerald-600' : e.productivityPct >= 40 ? 'text-amber-600' : 'text-rose-600'}`}>
                              {e.productivityPct}%
                            </p>
                            <p className="text-[10px] text-muted-foreground">productive</p>
                          </div>
                        </div>
                      ))}
                      {measured.employees.length === 0 && (
                        <p className="text-xs text-muted-foreground text-center py-4">No consented employee activity in this period.</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Analysis — AI Analysis OR Data Summary (unified contract) */}
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    {isAiMode ? <Bot className="w-4 h-4 text-primary" /> : <Database className="w-4 h-4 text-amber-500" />}
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      {isAiMode ? 'AI Analysis' : isDataSummaryMode ? 'Data Summary' : 'Analysis'}
                    </h3>
                    {isDataSummaryMode && (
                      <span className="text-[10px] text-muted-foreground">generated directly from employee database data</span>
                    )}
                  </div>

                  {analysis ? (
                    <div className="space-y-4">
                      <Card className="border shadow-sm">
                        <CardContent className="p-4 space-y-3">
                          <p className="text-sm leading-relaxed">{analysis.summary}</p>
                        </CardContent>
                      </Card>

                      {/* Provenance / evidence section (auditable) */}
                      {analysis.evidence.length > 0 && (
                        <Card className="border shadow-sm">
                          <CardContent className="p-3.5">
                            <div className="flex items-center gap-2 mb-2">
                              <Database className="w-3.5 h-3.5 text-slate-500" />
                              <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Evidence · data source</h4>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5">
                              {analysis.evidence.map((row, i) => (
                                <div key={i} className="flex justify-between gap-2 text-[11px]">
                                  <span className="text-muted-foreground">{row.label}</span>
                                  <span className="font-medium text-foreground/90 text-right">{row.value}</span>
                                </div>
                              ))}
                            </div>
                          </CardContent>
                        </Card>
                      )}

                      {/* Findings (AI findings carry severity/description; data-summary findings carry statement + numeric evidence) */}
                      {analysis.findings.length > 0 && (
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                          {analysis.findings.map((f, i) => {
                            const cfg = findingTypeConfig(f.type);
                            const Icon = cfg.icon;
                            return (
                              <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
                                <Card className="border shadow-sm">
                                  <CardContent className="p-3.5">
                                    <div className="flex items-start gap-2.5">
                                      <div className={`h-8 w-8 rounded-lg ${cfg.bg} flex items-center justify-center shrink-0`}>
                                        <Icon className={`w-4 h-4 ${cfg.color}`} />
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <h4 className="text-xs font-semibold">{f.title}</h4>
                                          {f.severity && (
                                            <Badge className={`${severityColor(f.severity)} border-0 text-[9px]`}>{f.severity}</Badge>
                                          )}
                                          <Badge variant="secondary" className="text-[9px] capitalize">{f.type}</Badge>
                                        </div>
                                        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{f.statement || f.description}</p>
                                        {/* Evidence — AI metric/value pair or data-summary numeric record */}
                                        {f.evidence && (
                                          <div className="mt-2 p-2 rounded-md bg-muted/50 border border-border/50">
                                            <p className="text-[9px] text-muted-foreground font-medium uppercase tracking-wider mb-0.5">Evidence</p>
                                            {('metric' in f.evidence) ? (
                                              <>
                                                <p className="text-[11px] font-medium">{(f.evidence as { metric: string; value: string }).metric}: <span className="text-foreground">{(f.evidence as { metric: string; value: string }).value}</span></p>
                                                {'comparison' in f.evidence && (f.evidence as { comparison?: string }).comparison && <p className="text-[10px] text-muted-foreground">{(f.evidence as { comparison?: string }).comparison}</p>}
                                              </>
                                            ) : (
                                              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                                                {Object.entries(f.evidence as Record<string, number | string>).map(([k, v]) => (
                                                  <div key={k} className="flex justify-between gap-2 text-[10px]">
                                                    <span className="text-muted-foreground capitalize">{k.replace(/([A-Z])/g, ' $1')}</span>
                                                    <span className="font-medium">{typeof v === 'number' ? v.toLocaleString('en-US') : v}</span>
                                                  </div>
                                                ))}
                                              </div>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </CardContent>
                                </Card>
                              </motion.div>
                            );
                          })}
                        </div>
                      )}

                      {/* AI recommendations (only in AI mode) */}
                      {isAiMode && ai?.recommendations && ai.recommendations.length > 0 && (
                        <Card className="border shadow-sm">
                          <CardContent className="p-4">
                            <h4 className="text-xs font-semibold mb-2 flex items-center gap-1.5">
                              <Lightbulb className="w-3.5 h-3.5 text-amber-500" /> Recommendations
                            </h4>
                            <div className="space-y-2">
                              {ai.recommendations.map((r, i) => (
                                <div key={i} className="flex items-start gap-2.5 p-2 rounded-lg bg-muted/40">
                                  <Badge className={`${severityColor(r.priority)} border-0 text-[9px] shrink-0 mt-0.5`}>{r.priority}</Badge>
                                  <div className="min-w-0">
                                    <p className="text-xs font-medium">{r.title}</p>
                                    <p className="text-[11px] text-muted-foreground leading-relaxed">{r.description}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </CardContent>
                        </Card>
                      )}
                    </div>
                  ) : (
                    <div className="text-center py-6">
                      <Bot className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
                      <p className="text-xs text-muted-foreground">
                        {meta && meta.aiStatus === 'disabled'
                          ? 'AI Insights disabled by administrator. Data summary will be generated from employee database data.'
                          : meta && meta.aiStatus !== 'generated'
                            ? meta.aiError
                            : 'Click "Run Analysis" to generate analysis from your workforce data.'}
                      </p>
                    </div>
                  )}
                </div>

                {/* Rule-based cards (deterministic — clearly labeled, NOT AI) */}
                {rulesData.length > 0 && (
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <Database className="w-4 h-4 text-slate-500" />
                      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Rule-based analysis (not AI)</h3>
                    </div>
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                      {rulesData.map((insight, i) => (
                        <AnalysisResultCard key={i} insight={insight} index={i} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-8">
                <Brain className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
                <p className="text-sm text-muted-foreground">Click &quot;Run Analysis&quot; to compute insights from your workforce data.</p>
                <p className="text-xs text-muted-foreground/60 mt-1">Analyzes employees, departments, devices, and activity patterns</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Divider & section header with category filter chips */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Insight Feed</h2>
          <div className="flex gap-2">
            <Button
              onClick={refreshInsights}
              disabled={refreshingInsights}
              size="sm"
              variant="outline"
              className="h-8 text-xs border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
            >
              {refreshingInsights ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
              Refresh Insights
            </Button>
          </div>
        </div>

        {/* Category filter chips */}
        <div className="flex flex-wrap gap-2">
          {categoryFilterChips.map((chip) => (
            <button
              key={chip.value}
              onClick={() => setCategoryFilter(chip.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-all ${
                categoryFilter === chip.value
                  ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                  : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground'
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </div>

      {/* Insight cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-32 bg-muted/30 rounded animate-pulse" />)}
        </div>
      ) : filteredInsights.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Sparkles className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">
            {categoryFilter !== 'all' ? `No ${categoryFilter} insights found.` : 'No insights yet.'}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 stagger-children">
          {filteredInsights.map((insight: { id: string; title: string; content: string; type: string; category: string | null; confidence: number | null; status: string; createdAt: string; metadata?: string | null }, index: number) => (
            <InsightCard key={insight.id} insight={insight} onUpdate={handleUpdate} index={index} />
          ))}
        </div>
      )}
    </div>
  );
}

function AnalysisResultCard({ insight, index }: { insight: AnalysisInsight; index: number }) {
  const config = typeIcons[insight.type] || typeIcons.opportunity;
  const Icon = config.icon;
  const confPct = Math.round(insight.confidence * 100);
  const confColor = confPct >= 85 ? '[&>div]:bg-emerald-500' : confPct >= 70 ? '[&>div]:bg-amber-500' : '[&>div]:bg-rose-500';

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.1, duration: 0.3 }}
    >
      <Card className="border shadow-sm hover:shadow-md transition-shadow">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className={`h-10 w-10 rounded-lg ${config.bg} flex items-center justify-center shrink-0`}>
              <Icon className={`w-5 h-5 ${config.color}`} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold">{insight.title}</h3>
                <Badge variant="secondary" className="text-[10px] capitalize bg-muted/80">{insight.type}</Badge>
              </div>
              <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">{insight.content}</p>
              <div className="mt-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-muted-foreground font-medium">Confidence</span>
                  <span className="text-xs font-semibold">{confPct}%</span>
                </div>
                <Progress value={confPct} className={`h-1.5 ${confColor}`} />
              </div>
              <div className="mt-3 p-2.5 rounded-lg bg-muted/50 border border-border/50">
                <div className="flex items-start gap-2">
                  <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider mb-0.5">Recommendation</p>
                    <p className="text-xs text-foreground/80 leading-relaxed">{insight.recommendation}</p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px] text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 hover:bg-emerald-500/10 mt-2 px-2"
                  onClick={() => toast.success('Action noted — follow up in your workflow')}
                >
                  Take Action <ArrowRight className="w-3 h-3 ml-1" />
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
