'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { format, subDays, parseISO } from 'date-fns';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Calendar,
  Download,
  Loader2,
  FileText,
  Clock,
  Users,
  Zap,
  AlertTriangle,
  Camera,
  Pause,
  TrendingUp,
  TrendingDown,
  Minus,
  RefreshCw,
  Sparkles,
  Copy,
  CheckCircle2,
  Lightbulb,
  ShieldAlert,
  Target,
  History,
  Building2,
  Award,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// ==================== Types ====================

interface DailySummary {
  totalEmployees: number;
  employeesActive: number;
  totalActivities: number;
  totalWorkingMinutes: number;
  avgMinutesPerEmployee: number;
  productivityScore: number;
  breakdown: {
    productive: { minutes: number; percent: number };
    neutral: { minutes: number; percent: number };
    unproductive: { minutes: number; percent: number };
    idle: { minutes: number; percent: number };
  };
  breakCount: number;
  alertsCount: number;
  screenshotsCount: number;
  onlineDevices: number;
}

interface EmployeeStat {
  employeeId: string;
  name: string;
  department: string;
  activities: number;
  productiveMin: number;
  neutralMin: number;
  unproductiveMin: number;
  totalMin: number;
  topApps: { app: string; minutes: number }[];
}

interface AiSummaryData {
  executiveSummary: string;
  keyFindings: string[];
  highlights: string[];
  concerns: string[];
  recommendations: string[];
  productivityRating: string;
  nextDayFocus: string;
}

interface ReportData {
  date: string;
  summary: DailySummary;
  employeeStats: EmployeeStat[];
  breakActivities: { type: string; employeeName: string; timestamp: string }[];
}

// ==================== Stat Card ====================

function StatCard({ label, value, icon: Icon, color, sub }: {
  label: string; value: string | number; icon: React.ElementType; color: string; sub?: string;
}) {
  return (
    <Card className="falcon-card p-0">
      <CardContent className="p-3">
        <div className="flex items-center gap-3">
          <div className={cn('h-9 w-9 rounded-lg flex items-center justify-center shrink-0', color)}>
            <Icon className="h-4 w-4 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-muted-foreground">{label}</p>
            <p className="text-lg font-bold leading-tight">{value}</p>
            {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ==================== Productivity Bar ====================

function ProductivityBar({ data, isLoading }: {
  data: DailySummary['breakdown'] | null;
  isLoading: boolean;
}) {
  if (isLoading || !data) {
    return <Skeleton className="h-8 w-full rounded-full" />;
  }

  return (
    <div className="space-y-2">
      <div className="flex h-8 w-full rounded-full overflow-hidden">
        <motion.div
          className="bg-emerald-500"
          initial={{ width: 0 }}
          animate={{ width: `${data.productive.percent}%` }}
          transition={{ duration: 0.8 }}
        />
        <motion.div
          className="bg-amber-400"
          initial={{ width: 0 }}
          animate={{ width: `${data.neutral.percent}%` }}
          transition={{ duration: 0.8, delay: 0.1 }}
        />
        <motion.div
          className="bg-rose-400"
          initial={{ width: 0 }}
          animate={{ width: `${data.unproductive.percent}%` }}
          transition={{ duration: 0.8, delay: 0.2 }}
        />
        <motion.div
          className="bg-slate-300 dark:bg-slate-600"
          initial={{ width: 0 }}
          animate={{ width: `${data.idle.percent}%` }}
          transition={{ duration: 0.8, delay: 0.3 }}
        />
      </div>
      <div className="flex flex-wrap gap-3 text-[10px]">
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Productive {data.productive.percent}% ({data.productive.minutes}m)</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" /> Neutral {data.neutral.percent}% ({data.neutral.minutes}m)</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-rose-400" /> Unproductive {data.unproductive.percent}% ({data.unproductive.minutes}m)</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-600" /> Idle {data.idle.percent}% ({data.idle.minutes}m)</span>
      </div>
    </div>
  );
}

// ==================== AI Summary Panel ====================

function AiSummaryPanel({ reportData, onClose }: {
  reportData: ReportData;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const { mutate: generateAiSummary, data: aiData, isPending: aiLoading } = useMutation({
    mutationFn: async () => {
      // DS-P1-2: the server derives its data from `body.date` (reportData is
      // intentionally ignored server-side as untrusted). Sending only
      // reportData made the summary ALWAYS analyze today regardless of the
      // selected report date.
      const res = await fetch('/api/reports/daily/ai-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: reportData.date }),
      });
      if (!res.ok) throw new Error('Failed');
      return res.json();
    },
    onSuccess: () => {
      toast.success('AI executive summary generated');
    },
    onError: () => {
      toast.error('Failed to generate AI summary');
    },
  });

  const ai = aiData?.aiSummary as AiSummaryData | undefined;

  const handleCopy = useCallback(() => {
    if (!ai) return;
    const text = [
      `📊 Daily Report — ${reportData.date}`,
      `🏢 Rating: ${ai.productivityRating}`,
      '',
      ai.executiveSummary,
      '',
      '🔍 Key Findings:',
      ...ai.keyFindings.map(f => `  • ${f}`),
      '',
      '✨ Highlights:',
      ...ai.highlights.map(h => `  • ${h}`),
      '',
      '⚠️ Concerns:',
      ...ai.concerns.map(c => `  • ${c}`),
      '',
      '💡 Recommendations:',
      ...ai.recommendations.map(r => `  • ${r}`),
      '',
      `🎯 Next Day Focus: ${ai.nextDayFocus}`,
    ].join('\n');

    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [ai, reportData.date]);

  const ratingColors: Record<string, string> = {
    'Excellent': 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400',
    'Good': 'bg-teal-100 text-teal-700 border-teal-200 dark:bg-teal-900/30 dark:text-teal-400',
    'Fair': 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400',
    'Needs Improvement': 'bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-900/30 dark:text-rose-400',
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
    >
      <Card className="falcon-card p-0 overflow-hidden">
        {/* Header with sparkle gradient */}
        <div className="px-4 py-3 bg-muted/50 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Sparkles className="h-4 w-4 text-primary" />
              </div>
              <div>
                <h3 className="text-sm font-semibold">AI Executive Summary</h3>
                <p className="text-[10px] text-muted-foreground">Powered by OmniSight intelligence engine</p>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {ai && (
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={handleCopy}>
                  {copied ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              )}
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
                ×
              </Button>
            </div>
          </div>
        </div>

        <CardContent className="p-4 space-y-4">
          {!ai && !aiLoading && (
            <div className="flex flex-col items-center py-8 text-center">
              <Sparkles className="h-10 w-10 text-purple-300 mb-3" />
              <p className="text-sm text-muted-foreground mb-3">Generate an AI-powered executive summary</p>
              <Button
                size="sm"
                className="gap-1.5 bg-primary hover:bg-primary/90 text-primary-foreground"
                onClick={() => generateAiSummary()}
              >
                <Sparkles className="h-3.5 w-3.5" />
                Generate AI Summary
              </Button>
            </div>
          )}

          {aiLoading && (
            <div className="space-y-3">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
              <Separator className="my-3" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3" />
              <div className="flex items-center gap-1 text-xs text-purple-500 mt-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Analyzing workforce data...
              </div>
            </div>
          )}

          {ai && (
            <AnimatePresence>
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
                {/* Rating Badge + Executive Summary */}
                <div className="flex items-start gap-3">
                  <div className={cn('px-2.5 py-1 rounded-lg border text-xs font-semibold shrink-0', ratingColors[ai.productivityRating] || ratingColors['Fair'])}>
                    {ai.productivityRating}
                  </div>
                  <p className="text-sm text-foreground leading-relaxed">{ai.executiveSummary}</p>
                </div>

                <Separator />

                {/* Key Findings */}
                <div>
                  <h4 className="text-xs font-semibold flex items-center gap-1.5 mb-2">
                    <Target className="h-3.5 w-3.5 text-blue-500" />
                    Key Findings
                  </h4>
                  <ul className="space-y-1">
                    {ai.keyFindings.map((f, i) => (
                      <li key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 mt-1.5 shrink-0" />
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Highlights & Concerns */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="rounded-lg bg-emerald-50/50 dark:bg-emerald-900/10 p-3 border border-emerald-200/50 dark:border-emerald-800/30">
                    <h4 className="text-xs font-semibold flex items-center gap-1.5 mb-2 text-emerald-600 dark:text-emerald-400">
                      <Zap className="h-3.5 w-3.5" />
                      Highlights
                    </h4>
                    <ul className="space-y-1">
                      {ai.highlights.map((h, i) => (
                        <li key={i} className="text-[11px] text-emerald-700 dark:text-emerald-300 flex items-start gap-1.5">
                          <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" />
                          {h}
                        </li>
                      ))}
                      {ai.highlights.length === 0 && (
                        <li className="text-[11px] text-muted-foreground">No highlights detected</li>
                      )}
                    </ul>
                  </div>
                  <div className="rounded-lg bg-amber-50/50 dark:bg-amber-900/10 p-3 border border-amber-200/50 dark:border-amber-800/30">
                    <h4 className="text-xs font-semibold flex items-center gap-1.5 mb-2 text-amber-600 dark:text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      Concerns
                    </h4>
                    <ul className="space-y-1">
                      {ai.concerns.map((c, i) => (
                        <li key={i} className="text-[11px] text-amber-700 dark:text-amber-300 flex items-start gap-1.5">
                          <ShieldAlert className="h-3 w-3 mt-0.5 shrink-0" />
                          {c}
                        </li>
                      ))}
                      {ai.concerns.length === 0 && (
                        <li className="text-[11px] text-muted-foreground">No concerns detected</li>
                      )}
                    </ul>
                  </div>
                </div>

                {/* Recommendations */}
                <div className="rounded-lg bg-violet-50/50 dark:bg-violet-900/10 p-3 border border-violet-200/50 dark:border-violet-800/30">
                  <h4 className="text-xs font-semibold flex items-center gap-1.5 mb-2 text-violet-600 dark:text-violet-400">
                    <Lightbulb className="h-3.5 w-3.5" />
                    Recommendations
                  </h4>
                  <ul className="space-y-1">
                    {ai.recommendations.map((r, i) => (
                      <li key={i} className="text-[11px] text-violet-700 dark:text-violet-300 flex items-start gap-1.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-violet-400 mt-1.5 shrink-0" />
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Next Day Focus */}
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-primary/5 to-primary/10 border border-primary/20">
                  <Target className="h-4 w-4 text-primary" />
                  <div>
                    <p className="text-[10px] text-muted-foreground">Next Day Focus</p>
                    <p className="text-xs font-medium text-foreground">{ai.nextDayFocus}</p>
                  </div>
                </div>

                {/* Regenerate button */}
                <div className="flex justify-center pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs gap-1.5"
                    onClick={() => generateAiSummary()}
                    disabled={aiLoading}
                  >
                    <RefreshCw className={cn('h-3 w-3', aiLoading && 'animate-spin')} />
                    Regenerate Summary
                  </Button>
                </div>
              </motion.div>
            </AnimatePresence>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ==================== Department Breakdown ====================

function DepartmentBreakdown({ employeeStats }: { employeeStats: EmployeeStat[] }) {
  // Aggregate stats by department
  const deptMap = new Map<string, { dept: string; totalMin: number; productiveMin: number; employees: number; topApps: Map<string, number> }>();

  for (const emp of employeeStats) {
    const dept = emp.department || 'Unassigned';
    const existing = deptMap.get(dept) || { dept, totalMin: 0, productiveMin: 0, employees: 0, topApps: new Map() };
    existing.totalMin += emp.totalMin;
    existing.productiveMin += emp.productiveMin;
    existing.employees += 1;
    for (const app of emp.topApps) {
      existing.topApps.set(app.app, (existing.topApps.get(app.app) || 0) + app.minutes);
    }
    deptMap.set(dept, existing);
  }

  const departments = Array.from(deptMap.values())
    .sort((a, b) => b.productiveMin - a.productiveMin);

  if (departments.length === 0) return null;

  return (
    <div className="space-y-3">
      {departments.map((dept, idx) => {
        const pct = dept.totalMin > 0 ? Math.round((dept.productiveMin / dept.totalMin) * 100) : 0;
        const topApps = Array.from(dept.topApps.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);

        return (
          <motion.div
            key={dept.dept}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: idx * 0.05 }}
            className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/30 transition-colors"
          >
            <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Building2 className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium">{dept.dept}</span>
                <span className="text-[10px] text-muted-foreground">{dept.employees} employee{dept.employees > 1 ? 's' : ''}</span>
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={`text-[10px] font-medium ${pct >= 70 ? 'text-emerald-500' : pct >= 40 ? 'text-amber-500' : 'text-rose-500'}`}>
                  <TrendingUp className="h-3 w-3 inline mr-0.5" />
                  {pct}% productive
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-muted/50 overflow-hidden max-w-[120px]">
                  <div
                    className={`h-full rounded-full transition-all ${pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-400' : 'bg-rose-400'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground">{dept.totalMin}m</span>
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              {topApps.map(([name]) => (
                <Badge key={name} variant="secondary" className="text-[8px] h-4 px-1">
                  {name}
                </Badge>
              ))}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}

// ==================== Main Page ====================

export function DailyReportPage() {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [generating, setGenerating] = useState(false);
  const [showAiSummary, setShowAiSummary] = useState(false);
  const [exporting, setExporting] = useState(false);
  const initialized = useRef(false);
  const queryClient = useQueryClient();

  const s = reportData?.summary;

  // Fetch report history
  const { data: reportHistory } = useQuery({
    queryKey: ['report-history'],
    queryFn: () => fetch('/api/reports?type=productivity&pageSize=7').then((r) => r.json()),
  });

  const generateReport = useMutation({
    mutationFn: async (date: string) => {
      const res = await fetch('/api/reports/daily', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      });
      if (!res.ok) throw new Error('Failed to generate report');
      return res.json() as Promise<ReportData>;
    },
    onSuccess: (data) => {
      setReportData(data);
      // DS-P2-1: data.date is a date-only string (YYYY-MM-DD) — parseISO treats
      // it as a local calendar date, while new Date() would interpret it as UTC
      // midnight and show the previous day in UTC+ zones.
      toast.success(`Report generated for ${format(parseISO(data.date), 'MMM d, yyyy')}`);
      // DS-P2-2: the Report History list uses the ['report-history'] query key;
      // invalidating ['reports'] never refreshed it.
      queryClient.invalidateQueries({ queryKey: ['report-history'] });
    },
    onError: () => {
      toast.error('Failed to generate daily report');
    },
  });

  const handleGenerate = useCallback(() => {
    setGenerating(true);
    setShowAiSummary(false);
    generateReport.mutate(selectedDate.toISOString().split('T')[0], {
      onSettled: () => setGenerating(false),
    });
  }, [generateReport, selectedDate]);

  // Auto-generate today's report on first mount. The initialized ref guard
  // keeps this single-shot even though the deps are listed for correctness.
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      generateReport.mutate(selectedDate.toISOString().split('T')[0]);
    }
  }, [generateReport, selectedDate]);

  // Scroll to the Report History section
  const scrollToReportHistory = useCallback(() => {
    document.getElementById('report-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Export report as formatted text
  const handleExport = useCallback(() => {
    if (!reportData || !s) return;
    setExporting(true);
    const lines = [
      '═══════════════════════════════════════════',
      `  DAILY SUMMARY REPORT — ${reportData.date}`,
      '═══════════════════════════════════════════',
      '',
      `Productivity Score: ${s.productivityScore}%`,
      `Total Work Hours: ${(s.totalWorkingMinutes / 60).toFixed(1)}h`,
      `Active Employees: ${s.employeesActive} of ${s.totalEmployees}`,
      `Total Activities: ${s.totalActivities}`,
      `Breaks: ${s.breakCount} | Alerts: ${s.alertsCount} | Screenshots: ${s.screenshotsCount}`,
      '',
      '─── Time Breakdown ───',
      `  Productive:    ${s.breakdown.productive.minutes}m (${s.breakdown.productive.percent}%)`,
      `  Neutral:      ${s.breakdown.neutral.minutes}m (${s.breakdown.neutral.percent}%)`,
      `  Unproductive:  ${s.breakdown.unproductive.minutes}m (${s.breakdown.unproductive.percent}%)`,
      `  Idle:         ${s.breakdown.idle.minutes}m (${s.breakdown.idle.percent}%)`,
      '',
      '─── Employee Performance ───',
      ...reportData.employeeStats.map((emp, i) => {
        const pct = emp.totalMin > 0 ? Math.round((emp.productiveMin / emp.totalMin) * 100) : 0;
        return `  ${i + 1}. ${emp.name} (${emp.department}) — ${pct}% productive, ${emp.totalMin}m total`;
      }),
      '',
      `Generated by OmniSight on ${new Date().toLocaleString()}`,
      '═══════════════════════════════════════════',
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daily-report-${reportData.date}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Report exported');
    setExporting(false);
  }, [reportData, s]);

  // Quick date buttons
  const quickDates = [
    { label: 'Today', date: new Date() },
    { label: 'Yesterday', date: subDays(new Date(), 1) },
    { label: '2 days ago', date: subDays(new Date(), 2) },
  ];

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card className="falcon-card p-0">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <FileText className="h-5 w-5 text-primary" />
              </div>
              <div>
                <h2 className="text-base font-semibold">Daily Summary Report</h2>
                <p className="text-xs text-muted-foreground">Generate comprehensive daily productivity analysis with AI insights</p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {quickDates.map((qd) => (
                <Button
                  key={qd.label}
                  variant={format(selectedDate, 'yyyy-MM-dd') === format(qd.date, 'yyyy-MM-dd') ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setSelectedDate(qd.date)}
                >
                  {qd.label}
                </Button>
              ))}
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={handleGenerate}
                disabled={generating}
              >
                {generating ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5 mr-1.5" />}
                Generate
              </Button>
              {reportData && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={handleExport}
                  disabled={exporting}
                >
                  {exporting ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1.5" />}
                  Export
                </Button>
              )}
              {reportHistory?.data?.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={scrollToReportHistory}
                >
                  <History className="w-3.5 h-3.5 mr-1.5" />
                  Report History
                </Button>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">
              {format(selectedDate, 'EEEE, MMMM d, yyyy')}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Report Content */}
      {!reportData && !generating && (
        <Card className="falcon-card">
          <CardContent className="p-8 flex flex-col items-center justify-center text-center">
            <FileText className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">Select a date and click &quot;Generate&quot; to create a daily report</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Reports include employee productivity, AI executive summary, and actionable recommendations</p>
          </CardContent>
        </Card>
      )}

      {generating && !reportData && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      )}

      {reportData && s && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
          {/* AI Summary Toggle */}
          <div className="flex items-center justify-between">
            <Button
              variant={showAiSummary ? 'default' : 'outline'}
              size="sm"
              className="gap-1.5"
              onClick={() => setShowAiSummary(!showAiSummary)}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {showAiSummary ? 'Hide AI Summary' : 'Show AI Summary'}
            </Button>
            {s && (
              <Badge variant="outline" className="text-[10px] h-5">
                <Clock className="h-3 w-3 mr-1" />
                {reportData.date}
              </Badge>
            )}
          </div>

          {/* AI Summary Panel */}
          <AnimatePresence>
            {showAiSummary && (
              <AiSummaryPanel reportData={reportData} onClose={() => setShowAiSummary(false)} />
            )}
          </AnimatePresence>

          {/* Summary Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Productivity Score" value={`${s.productivityScore}%`} icon={Zap} color="bg-emerald-500" />
            <StatCard label="Total Work Hours" value={`${(s.totalWorkingMinutes / 60).toFixed(1)}h`} icon={Clock} color="bg-teal-500" sub={`${s.avgMinutesPerEmployee}m avg/employee`} />
            <StatCard label="Active Employees" value={s.employeesActive} icon={Users} color="bg-indigo-500" sub={`of ${s.totalEmployees} total`} />
            <StatCard label="Activities" value={s.totalActivities} icon={FileText} color="bg-violet-500" />
          </div>

          {/* Secondary Stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Breaks Today" value={s.breakCount} icon={Pause} color="bg-orange-500" />
            <StatCard label="Alerts" value={s.alertsCount} icon={AlertTriangle} color={s.alertsCount > 0 ? 'bg-rose-500' : 'bg-slate-400'} />
            <StatCard label="Screenshots" value={s.screenshotsCount} icon={Camera} color="bg-purple-500" />
            <StatCard label="Online Devices" value={s.onlineDevices} icon={Zap} color="bg-cyan-500" />
          </div>

          {/* Productivity Breakdown Bar */}
          <Card className="falcon-card p-0">
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold mb-3">Time Breakdown</h3>
              <ProductivityBar data={s.breakdown} isLoading={false} />
            </CardContent>
          </Card>

          {/* Employee Performance */}
          <Card className="falcon-card p-0">
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold mb-3">Employee Performance</h3>
              <div className="space-y-2 max-h-[400px] overflow-y-auto custom-scrollbar">
                {reportData.employeeStats.map((emp, idx) => {
                  const productivity = emp.totalMin > 0 ? Math.round((emp.productiveMin / emp.totalMin) * 100) : 0;
                  const TrendIcon = productivity >= 70 ? TrendingUp : productivity >= 40 ? Minus : TrendingDown;
                  const trendColor = productivity >= 70 ? 'text-emerald-500' : productivity >= 40 ? 'text-amber-500' : 'text-rose-500';

                  return (
                    <motion.div
                      key={emp.employeeId}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.03 }}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/30 transition-colors"
                    >
                      <span className="text-[10px] text-muted-foreground w-5 text-center font-medium">{idx + 1}</span>
                      <Avatar className="h-7 w-7">
                        <AvatarFallback className="text-[9px] bg-primary/10 text-primary font-semibold">
                          {emp.name.split(' ').map(n => n[0]).join('')}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium truncate">{emp.name}</span>
                          <Badge variant="outline" className="text-[9px] h-4 px-1">{emp.department}</Badge>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className={`text-[10px] font-medium ${trendColor}`}>
                            <TrendIcon className="h-3 w-3 inline mr-0.5" />
                            {productivity}%
                          </span>
                          <div className="flex-1 h-1.5 rounded-full bg-muted/50 overflow-hidden max-w-[120px]">
                            <div
                              className={`h-full rounded-full ${productivity >= 70 ? 'bg-emerald-500' : productivity >= 40 ? 'bg-amber-400' : 'bg-rose-400'}`}
                              style={{ width: `${productivity}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground">{emp.totalMin}m total</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {emp.topApps.slice(0, 2).map((app) => (
                          <Badge key={app.app} variant="secondary" className="text-[8px] h-4 px-1">
                            {app.app}
                          </Badge>
                        ))}
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Break History */}
          {reportData.breakActivities.length > 0 && (
            <Card className="falcon-card p-0">
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3">Break History</h3>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {reportData.breakActivities.map((ba, idx) => (
                    <div key={idx} className="flex items-center gap-2 px-3 py-1.5 rounded-md text-xs">
                      <Pause className={`h-3 w-3 ${ba.type === 'break_start' ? 'text-amber-500' : 'text-emerald-500'}`} />
                      <span className="font-medium">{ba.employeeName}</span>
                      <span className="text-muted-foreground">
                        {ba.type === 'break_start' ? 'started break' : 'ended break'}
                      </span>
                      <span className="text-[10px] text-muted-foreground/60 ml-auto">
                        {format(new Date(ba.timestamp), 'h:mm a')}
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Department Breakdown */}
          {reportData.employeeStats.length > 0 && (
            <Card className="falcon-card p-0">
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  Department Breakdown
                </h3>
                <DepartmentBreakdown employeeStats={reportData.employeeStats} />
              </CardContent>
            </Card>
          )}

          {/* Top Performer Highlight */}
          {reportData.employeeStats.length > 0 && (() => {
            const topEmp = reportData.employeeStats.reduce((best, emp) => {
              const bestPct = best.totalMin > 0 ? (best.productiveMin / best.totalMin) * 100 : 0;
              const empPct = emp.totalMin > 0 ? (emp.productiveMin / emp.totalMin) * 100 : 0;
              return empPct > bestPct ? emp : best;
            }, reportData.employeeStats[0]);
            if (!topEmp) return null;
            const topPct = topEmp.totalMin > 0 ? Math.round((topEmp.productiveMin / topEmp.totalMin) * 100) : 0;
            return (
              <div className="falcon-card p-4 bg-warning/5 border-warning/20">
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-warning/10 flex items-center justify-center">
                    <Award className="h-5 w-5 text-warning" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold">Top Performer</p>
                      <Badge className="text-[10px] bg-amber-500 text-white">🥇 {topPct}%</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {topEmp.name} — {topEmp.department} · {topEmp.totalMin}m total work time
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Top Apps</p>
                    <div className="flex gap-1 mt-1">
                      {topEmp.topApps.slice(0, 3).map((app) => (
                        <Badge key={app.app} variant="secondary" className="text-[9px] h-5 px-1.5">
                          {app.app}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}
        </motion.div>
      )}

      {/* Report History */}
      {reportHistory?.data?.length > 0 && (
        <Card id="report-history" className="falcon-card p-0">
          <CardContent className="p-4">
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              Report History
            </h3>
            <ScrollArea className="max-h-48">
              <div className="space-y-1.5">
                {reportHistory.data.map((report: { id: string; title: string; createdAt: string; status: string }) => (
                  <div key={report.id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/30 transition-colors">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{report.title}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {format(new Date(report.createdAt), 'MMM d, yyyy h:mm a')}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-[9px] h-5 px-1.5">
                      {report.status}
                    </Badge>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
