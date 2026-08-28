'use client';

import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  UserCircle,
  Clock,
  TrendingUp,
  Monitor,
  ShieldCheck,
  Fingerprint,
  Camera,
  ClipboardCheck,
  Keyboard,
  Usb,
  Webcam,
  MapPin,
  Mail,
  Loader2,
  ShieldAlert,
  Zap,
  BarChart3,
  FolderKanban,
  HeartPulse,
  ChevronRight as ChevronRightIcon,
  Activity,
  Globe,
  Pause,
} from 'lucide-react';
import { useAppStore } from '@/lib/store';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmployeeCombobox } from '@/components/employees/employee-combobox';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { toast } from 'sonner';
import { setPendingEmployeeTab } from '@/lib/employee-details-tab';
import { unwrapDashboard, type DashboardData } from '@/lib/self-dashboard';

// ==================== Utility Functions ====================

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function formatHours(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const date = new Date(dateStr).getTime();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr !== 1 ? 's' : ''} ago`;
  if (diffDay < 30) return `${diffDay} day${diffDay !== 1 ? 's' : ''} ago`;
  return new Date(dateStr).toLocaleDateString();
}

// Safe numeric coercion for API data. The backend contract guarantees numbers,
// but defensive normalization here prevents any future undefined/null value from
// crashing `.toFixed()` / `.toLocaleString()` during render.
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// The self-service APIs wrap their lists in { data }; this unwraps that envelope
// (or a bare array) and always returns a real array, so `.map()` can never crash
// on an object/undefined at runtime.
function asArray<T>(json: unknown): T[] {
  if (Array.isArray(json)) return json as T[];
  if (json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data)) {
    return (json as { data: T[] }).data;
  }
  return [];
}

// ==================== Constants ====================

const CONSENT_TYPE_CONFIG: Record<string, { icon: React.ElementType; label: string; color: string; bg: string }> = {
  monitoring: { icon: Fingerprint, label: 'General Monitoring', color: 'text-emerald-500', bg: 'bg-emerald-100 dark:bg-emerald-900/30' },
  screenshot: { icon: Camera, label: 'Screenshot Capture', color: 'text-violet-500', bg: 'bg-violet-100 dark:bg-violet-900/30' },
  activity_tracking: { icon: ClipboardCheck, label: 'Activity Tracking', color: 'text-blue-500', bg: 'bg-blue-100 dark:bg-blue-900/30' },
  keystroke: { icon: Keyboard, label: 'Keystroke Logging', color: 'text-rose-500', bg: 'bg-rose-100 dark:bg-rose-900/30' },
  usb_monitoring: { icon: Usb, label: 'USB Monitoring', color: 'text-amber-500', bg: 'bg-amber-100 dark:bg-amber-900/30' },
  webcam_access: { icon: Webcam, label: 'Webcam Access', color: 'text-red-500', bg: 'bg-red-100 dark:bg-red-900/30' },
  location: { icon: MapPin, label: 'Location Tracking', color: 'text-cyan-500', bg: 'bg-cyan-100 dark:bg-cyan-900/30' },
  email_monitoring: { icon: Mail, label: 'Email Monitoring', color: 'text-indigo-500', bg: 'bg-indigo-100 dark:bg-indigo-900/30' },
};

const CONSENT_STATUS_CONFIG: Record<string, { label: string; color: string }> = {
  granted: { label: 'Granted', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
  pending: { label: 'Pending', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  denied: { label: 'Denied', color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  revoked: { label: 'Revoked', color: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400' },
  expired: { label: 'Expired', color: 'bg-slate-100 text-slate-600 dark:bg-slate-900/30 dark:text-slate-400' },
};

const SEVERITY_CONFIG: Record<string, { label: string; color: string; border: string }> = {
  critical: { label: 'Critical', color: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400', border: 'border-l-rose-500' },
  high: { label: 'High', color: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400', border: 'border-l-orange-500' },
  medium: { label: 'Medium', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400', border: 'border-l-amber-500' },
  low: { label: 'Low', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400', border: 'border-l-blue-500' },
};

// ==================== Types ====================

interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  employeeId: string;
  status: string;
  designation?: string | null;
  department?: { name: string } | null;
}

interface ConsentItem {
  id: string;
  consentType: string;
  status: string;
  grantedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  consentVersion: string | null;
  notes: string | null;
  requiresReconsent?: boolean;
  policy?: {
    id: string;
    title: string;
    version: string;
    content: string;
  } | null;
}

interface AnomalyItem {
  id: string;
  type: string;
  severity: string;
  status: string;
  title: string;
  description: string;
  score: number;
  createdAt: string;
}

interface TelemetrySummary {
  websites: {
    available: boolean;
    consentGranted: boolean;
    configEnabled: boolean;
    topDomains: Array<{ domain: string; visits: number; totalSeconds: number; lastSeen: string }>;
  };
  keyboard: {
    available: boolean;
    consentGranted: boolean;
    configEnabled: boolean;
    intervals: number;
    totalKeystrokes: number;
    totalActiveTypingSeconds: number;
  };
  location: {
    available: boolean;
    consentGranted: boolean;
    configEnabled: boolean;
    latest: { latitude: number; longitude: number; accuracy: number | null; recordedAt: string; source: string } | null;
  };
  webcam: {
    available: boolean;
    consentGranted: boolean;
    configEnabled: boolean;
    session: { id: string; status: string; startedAt: string | null } | null;
  };
}

interface SelfProject {
  projectId: string;
  project: {
    id: string;
    name: string;
    status: string;
    priority: string;
    deadline: string | null;
    color: string;
    estimatedHours: number;
  };
  role: string;
  hoursPerWeek: number;
  totalHours: number;
  sentiment: {
    id: string;
    score: number | null;
    mood: string;
    aiProviderUsed: string | null;
    periodStart: string;
    periodEnd: string;
  } | null;
}

const cardClass = 'bg-card border rounded-xl p-4 md:p-6 shadow-sm hover:shadow-md transition-shadow';

// ==================== Main Component ====================

export function SelfPortalPage() {
  const queryClient = useQueryClient();
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
  const [activeTab, setActiveTab] = useState('overview');

  // Anomalies filters
  const [anomalySeverity, setAnomalySeverity] = useState('all');
  const [anomalyStatus, setAnomalyStatus] = useState('all');

  // Revoke confirmation dialog
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokeConsentId, setRevokeConsentId] = useState<string | null>(null);
  const [revokeConsentType, setRevokeConsentType] = useState<string | null>(null);

  // ===== Fetch active employees (auto-select first) =====
  // Bounded list: the auto-selected employee is the first active one, and the
  // selection is used both for the portal tabs AND to resolve the human-readable
  // label of the deep-link to Employee Details (never the raw DB id).
  // Bounded list: the auto-selected employee is the first active one. The
  // limit must stay within the search API's MAX_LIMIT (50) — a higher value
  // 400s and the portal would never auto-select (P1 fixed in browser E2E).
  // The EmployeeCombobox search is server-backed and not bounded by this list.
  const { data: employeesData } = useQuery({
    queryKey: ['active-employees-list'],
    queryFn: () => fetch('/api/employees/search?status=active&limit=50').then(r => r.json()),
  });

  const employees: Employee[] = useMemo(() => employeesData?.data ?? [], [employeesData]);

  // Auto-select first employee
  useEffect(() => {
    if (employees.length > 0 && !selectedEmployeeId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate default initialization from async data
      setSelectedEmployeeId(employees[0].id);
    }
  }, [employees, selectedEmployeeId]);

  // ===== Fetch dashboard data =====
  const { data: dashboard, isLoading: dashboardLoading, isError: dashboardError } = useQuery<DashboardData>({
    queryKey: ['self-dashboard', selectedEmployeeId],
    // The API wraps the flat contract in { data: {...} } (same envelope as the
    // other /api/self routes). Unwrap it so the Overview reads real fields;
    // throw on non-OK so failures surface as the error state instead of being
    // coerced to 0 by num() (previously every Overview card silently rendered
    // zeros — P1 found in browser E2E).
    queryFn: async () => {
      const res = await fetch(`/api/self/dashboard?employeeId=${selectedEmployeeId}`);
      if (!res.ok) throw new Error(`Dashboard request failed: ${res.status}`);
      return unwrapDashboard(await res.json());
    },
    enabled: !!selectedEmployeeId,
  });

  // ===== Fetch consents =====
  const { data: consents, isLoading: consentsLoading, isError: consentsError } = useQuery<ConsentItem[]>({
    queryKey: ['self-consents', selectedEmployeeId],
    queryFn: async () => {
      const res = await fetch(`/api/self/consents?employeeId=${selectedEmployeeId}`);
      const json = await res.json();
      return asArray<ConsentItem>(json);
    },
    enabled: !!selectedEmployeeId && activeTab === 'consents',
  });

  // ===== Fetch assigned projects =====
  const { data: selfProjects, isLoading: selfProjectsLoading, isError: selfProjectsError } = useQuery<SelfProject[]>({
    queryKey: ['self-projects', selectedEmployeeId],
    queryFn: async () => {
      const res = await fetch(`/api/self/projects?employeeId=${selectedEmployeeId}`);
      const json = await res.json();
      return asArray<SelfProject>(json);
    },
    enabled: !!selectedEmployeeId && activeTab === 'projects',
  });

  // ===== Fetch anomalies =====
  const { data: anomalies, isLoading: anomaliesLoading, isError: anomaliesError } = useQuery<AnomalyItem[]>({
    queryKey: ['self-anomalies', selectedEmployeeId, anomalySeverity, anomalyStatus],
    queryFn: async () => {
      const params = new URLSearchParams({ employeeId: selectedEmployeeId });
      if (anomalySeverity !== 'all') params.set('severity', anomalySeverity);
      if (anomalyStatus !== 'all') params.set('status', anomalyStatus);
      const res = await fetch(`/api/self/anomalies?${params}`);
      const json = await res.json();
      return asArray<AnomalyItem>(json);
    },
    enabled: !!selectedEmployeeId && activeTab === 'anomalies',
  });

  // ===== Fetch telemetry summary (consent + config gated server-side) =====
  const { data: telemetry, isLoading: telemetryLoading, isError: telemetryError } = useQuery<TelemetrySummary>({
    queryKey: ['self-telemetry-summary', selectedEmployeeId],
    queryFn: async () => {
      const res = await fetch(`/api/self/telemetry-summary?employeeId=${selectedEmployeeId}`);
      const json = await res.json();
      return json?.data as TelemetrySummary;
    },
    enabled: !!selectedEmployeeId && activeTab === 'telemetry',
  });

  // ===== Consent mutation =====
  const consentMutation = useMutation({
    mutationFn: async ({ id, status, consentType }: { id: string; status: string; consentType?: string }) => {
      const res = await fetch(`/api/self/consents/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, employeeId: selectedEmployeeId, consentType }),
      });
      if (!res.ok) throw new Error('Failed to update consent');
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['self-consents', selectedEmployeeId] });
      queryClient.invalidateQueries({ queryKey: ['self-dashboard', selectedEmployeeId] });
      toast.success(
        variables.status === 'granted' ? 'Consent granted successfully' :
        variables.status === 'denied' ? 'Consent denied' :
        'Consent revoked successfully'
      );
    },
    onError: () => {
      toast.error('Failed to update consent');
    },
  });

  // ===== Handlers =====
  const handleGrantConsent = (id: string, consentType?: string) => {
    consentMutation.mutate({ id, status: 'granted', consentType });
  };

  const handleDenyConsent = (id: string, consentType?: string) => {
    consentMutation.mutate({ id, status: 'denied', consentType });
  };

  const handleRevokeConsent = (id: string, consentType?: string) => {
    setRevokeConsentId(id);
    setRevokeConsentType(consentType ?? null);
    setRevokeDialogOpen(true);
  };

  const confirmRevoke = () => {
    if (revokeConsentId) {
      consentMutation.mutate({ id: revokeConsentId, status: 'revoked', consentType: revokeConsentType ?? undefined });
      setRevokeDialogOpen(false);
      setRevokeConsentId(null);
      setRevokeConsentType(null);
    }
  };

  // ===== Break / Privacy Mode =====
  const { data: breakStatus, isLoading: breakStatusLoading, isError: breakStatusError } = useQuery<{
    data: { employeeId: string; onBreak: boolean; startedAt: string | null; sessionId: string | null };
  }>({
    queryKey: ['self-break-status', selectedEmployeeId],
    queryFn: async () => {
      const res = await fetch(`/api/self/break-status?employeeId=${selectedEmployeeId}`);
      if (!res.ok) throw new Error('Failed to fetch break status');
      return res.json();
    },
    enabled: !!selectedEmployeeId,
    refetchInterval: 30000,
  });

  const breakMutation = useMutation({
    mutationFn: async (breakMode: boolean) => {
      const res = await fetch('/api/self/break-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: selectedEmployeeId, breakMode }),
      });
      if (!res.ok) throw new Error('Failed to update break status');
      return res.json();
    },
    onSuccess: (data: { breakMode?: boolean; message?: string }) => {
      queryClient.invalidateQueries({ queryKey: ['self-break-status', selectedEmployeeId] });
      toast.success(data.message || (data.breakMode ? 'Break started' : 'Break ended'));
    },
    onError: () => {
      toast.error('Failed to update break status');
    },
  });

  const handleTabChange = (value: string) => {
    setActiveTab(value);
  };

  // Deep-link into the canonical Employees → Employee Details surface for the
  // employee this portal is currently viewing (full monitoring profile).
  const openEmployeeDetails = (tabOrEvent?: string | React.MouseEvent<HTMLButtonElement>) => {
    if (!selectedEmployeeId) return;
    const store = useAppStore.getState();
    const tab = typeof tabOrEvent === 'string' ? tabOrEvent : undefined;
    if (tab) setPendingEmployeeTab(tab);
    store.setCurrentPage('employee-details');
    store.setPageContext(selectedEmployeeId);
    const emp = employees.find((e) => e.id === selectedEmployeeId);
    store.setPageContextLabel(emp ? `${emp.firstName} ${emp.lastName}`.trim() || emp.employeeId : '');
  };

  // ===== Render helpers =====
  const renderErrorState = (title: string, description: string) => (
    <EmptyState
      icon={ShieldAlert}
      title={title}
      description={description}
    />
  );

  // ===== Render helpers =====
  const renderOverviewSkeleton = () => (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      {[...Array(4)].map((_, i) => (
        <Skeleton key={i} className="h-28 rounded-xl" />
      ))}
    </div>
  );

  const renderOverviewTab = () => {
    if (dashboardLoading) return renderOverviewSkeleton();
    if (dashboardError) return renderErrorState('Unable to load dashboard', 'The dashboard data could not be fetched. Please try again.');
    if (!dashboard) return <EmptyState icon={BarChart3} title="No dashboard data" description="There is no dashboard data for this employee yet." />;

    // Normalize every dashboard value before rendering so no undefined/null
    // can reach a number method (weeklyProductivity, productivityChange, …).
    const todayHours = num(dashboard.todayHours);
    const productiveToday = num(dashboard.productiveToday);
    const unproductiveToday = num(dashboard.unproductiveToday);
    const weeklyProductivity = num(dashboard.weeklyProductivity);
    const productivityChange = num(dashboard.productivityChange);
    const deviceOnline = num(dashboard.deviceOnline);
    const deviceTotal = num(dashboard.deviceTotal);
    const consentGranted = num(dashboard.consentGranted);
    const consentTotal = num(dashboard.consentTotal);
    const consentPending = num(dashboard.consentPending);
    const deviceNames = dashboard.deviceNames ?? [];

    const tb = dashboard.timeBreakdown || { productive: 0, neutral: 0, unproductive: 0 };
    const totalBreakdown = num(tb.productive) + num(tb.neutral) + num(tb.unproductive);
    const pPct = totalBreakdown > 0 ? (tb.productive / totalBreakdown) * 100 : 0;
    const nPct = totalBreakdown > 0 ? (tb.neutral / totalBreakdown) * 100 : 0;
    const uPct = totalBreakdown > 0 ? (tb.unproductive / totalBreakdown) * 100 : 0;

    return (
      <div className="space-y-6">
        {/* Stat Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0 }}>
            <Card className={cardClass}>
              <CardContent className="p-0">
                <div className="flex items-center gap-3 mb-2">
                  <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
                    <Clock className="w-4 h-4 text-emerald-600" />
                  </div>
                  <span className="text-xs text-muted-foreground font-medium">Today's Hours</span>
                </div>
                <div className="text-2xl font-bold">{(todayHours / 3600).toFixed(1)}h</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatDuration(productiveToday)} productive · {formatDuration(unproductiveToday)} unproductive
                </p>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.05 }}>
            <Card className={cardClass}>
              <CardContent className="p-0">
                <div className="flex items-center gap-3 mb-2">
                  <div className="h-9 w-9 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                    <TrendingUp className="w-4 h-4 text-blue-600" />
                  </div>
                  <span className="text-xs text-muted-foreground font-medium">Weekly Productivity</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold">{weeklyProductivity.toFixed(0)}%</span>
                  {productivityChange !== 0 && (
                    <span className={`text-xs font-medium ${productivityChange > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {productivityChange > 0 ? '+' : ''}{productivityChange.toFixed(1)}%
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">Productive share of weekly activity</p>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.1 }}>
            <Card className={cardClass}>
              <CardContent className="p-0">
                <div className="flex items-center gap-3 mb-2">
                  <div className="h-9 w-9 rounded-lg bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center">
                    <Monitor className="w-4 h-4 text-violet-600" />
                  </div>
                  <span className="text-xs text-muted-foreground font-medium">Devices</span>
                </div>
                <div className="text-2xl font-bold">{deviceOnline} / {deviceTotal}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {deviceNames.length > 0 ? deviceNames.join(', ') : 'No devices'}
                </p>
              </CardContent>
            </Card>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.15 }}>
            <Card className={cardClass}>
              <CardContent className="p-0">
                <div className="flex items-center gap-3 mb-2">
                  <div className="h-9 w-9 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
                    <ShieldCheck className="w-4 h-4 text-amber-600" />
                  </div>
                  <span className="text-xs text-muted-foreground font-medium">Consent Status</span>
                </div>
                <div className="text-2xl font-bold">{consentGranted} / {consentTotal}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {consentPending > 0 ? `${consentPending} pending action` : 'All consents up to date'}
                </p>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Break / Privacy Mode */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.18 }}>
          <Card className={cardClass}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Pause className="w-4 h-4 text-amber-600" /> Break / Privacy Mode
              </CardTitle>
              <CardDescription className="text-xs">
                Monitoring pauses while a break is active.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {breakStatusLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading break status…
                </div>
              ) : breakStatusError ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-rose-600">Failed to load break status.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      queryClient.invalidateQueries({ queryKey: ['self-break-status', selectedEmployeeId] })
                    }
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Badge
                      className={
                        breakStatus?.data.onBreak
                          ? 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800'
                          : 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800'
                      }
                    >
                      {breakStatus?.data.onBreak ? 'On Break' : 'Active'}
                    </Badge>
                    {breakStatus?.data.onBreak && breakStatus.data.startedAt && (
                      <span className="text-xs text-muted-foreground">
                        Since{' '}
                        {new Date(breakStatus.data.startedAt).toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    disabled={breakMutation.isPending}
                    onClick={() => breakMutation.mutate(!breakStatus?.data.onBreak)}
                    variant={breakStatus?.data.onBreak ? 'outline' : 'default'}
                    className={
                      breakStatus?.data.onBreak
                        ? 'text-emerald-600 border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700'
                        : 'bg-amber-600 hover:bg-amber-700 text-white'
                    }
                  >
                    {breakMutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
                    {breakStatus?.data.onBreak ? 'End Break' : 'Start Break'}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Activity Breakdown */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.2 }}>
          <Card className={cardClass}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Activity Breakdown</CardTitle>
              <CardDescription className="text-xs">Time distribution for today</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-4 rounded-full bg-muted overflow-hidden flex">
                {pPct > 0 && (
                  <motion.div
                    className="bg-emerald-500 h-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${pPct}%` }}
                    transition={{ duration: 0.6, delay: 0.2 }}
                  />
                )}
                {nPct > 0 && (
                  <motion.div
                    className="bg-amber-500 h-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${nPct}%` }}
                    transition={{ duration: 0.6, delay: 0.3 }}
                  />
                )}
                {uPct > 0 && (
                  <motion.div
                    className="bg-rose-500 h-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${uPct}%` }}
                    transition={{ duration: 0.6, delay: 0.4 }}
                  />
                )}
              </div>
              <div className="flex items-center gap-5 mt-3">
                <div className="flex items-center gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                  <span className="text-xs text-muted-foreground">Productive {num(pPct).toFixed(0)}%</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                  <span className="text-xs text-muted-foreground">Neutral {num(nPct).toFixed(0)}%</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-2.5 w-2.5 rounded-full bg-rose-500" />
                  <span className="text-xs text-muted-foreground">Unproductive {num(uPct).toFixed(0)}%</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        {/* Quick Links */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.25 }}>
          <Card className={cardClass}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold">Quick Links</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {[
                  { label: 'Consents', value: 'consents', icon: ShieldCheck },
                  { label: 'Anomalies', value: 'anomalies', icon: Zap },
                  { label: 'Projects', value: 'projects', icon: FolderKanban },
                ].map(link => (
                  <Button
                    key={link.value}
                    variant="outline"
                    size="sm"
                    onClick={() => setActiveTab(link.value)}
                    className="gap-1.5 text-emerald-600 border-emerald-200 hover:bg-emerald-50 hover:text-emerald-700 dark:border-emerald-800 dark:hover:bg-emerald-900/20"
                  >
                    <link.icon className="w-3.5 h-3.5" />
                    {link.label}
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  };

  const renderConsentsTab = () => {
    if (consentsLoading) {
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-48 rounded-xl" />
          ))}
        </div>
      );
    }

    if (consentsError) return renderErrorState('Unable to load consents', 'Consent records could not be fetched. Please try again.');

    if (!consents || consents.length === 0) {
      return <EmptyState icon={ShieldCheck} title="No consents found" description="There are no consent records for this employee." />;
    }

    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {consents.map((consent, idx) => {
          const typeCfg = CONSENT_TYPE_CONFIG[consent.consentType] || { icon: ShieldAlert, label: consent.consentType, color: 'text-slate-500', bg: 'bg-slate-100 dark:bg-slate-800' };
          const statusCfg = CONSENT_STATUS_CONFIG[consent.status] || CONSENT_STATUS_CONFIG.pending;
          const TypeIcon = typeCfg.icon;
          const isGranted = consent.status === 'granted';
          const isPending = consent.status === 'pending';
          const isDenied = consent.status === 'denied';
          // Re-consent is required when the granted policy version no longer
          // matches the current published version — must re-grant explicitly.
          const needsReconsent = Boolean(consent.requiresReconsent) && isGranted;
          const canGrant = isPending || consent.status === 'revoked' || consent.status === 'expired' || isDenied || needsReconsent;

          return (
            <motion.div
              key={consent.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: idx * 0.05 }}
            >
              <Card className={cardClass}>
                <CardContent className="p-0">
                  <div className="flex flex-col items-center text-center">
                    <div className={`h-12 w-12 rounded-xl flex items-center justify-center mb-3 ${typeCfg.bg}`}>
                      <TypeIcon className={`w-6 h-6 ${typeCfg.color}`} />
                    </div>
                    <h3 className="text-sm font-semibold">{typeCfg.label}</h3>
                    <div className="mt-2 mb-3">
                      <Badge variant="secondary" className={`text-xs px-3 py-1 ${statusCfg.color}`}>
                        {statusCfg.label}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground space-y-0.5 w-full">
                      {needsReconsent && (
                        <p className="text-amber-600 font-medium">
                          Re-consent required — policy updated to v{consent.policy?.version?.replace('v', '')}
                        </p>
                      )}
                      {consent.policy && (
                        <p className="truncate" title={consent.policy.title}>
                          Policy: {consent.policy.title} (v{consent.policy.version.replace('v', '')})
                        </p>
                      )}
                      {isGranted && consent.grantedAt && (
                        <p>Granted on {new Date(consent.grantedAt).toLocaleDateString()}</p>
                      )}
                      {isGranted && consent.expiresAt && (
                        <p>Expires on {new Date(consent.expiresAt).toLocaleDateString()}</p>
                      )}
                      {consent.status === 'revoked' && consent.revokedAt && (
                        <p>Revoked on {new Date(consent.revokedAt).toLocaleDateString()}</p>
                      )}
                      {consent.status === 'denied' && (
                        <p className="italic">You declined this consent type</p>
                      )}
                      {isPending && (
                        <p className="italic">Awaiting your action</p>
                      )}
                      {consent.status === 'expired' && (
                        <p>Consent has expired</p>
                      )}
                    </div>
                    {consent.notes && (
                      <p className="text-xs text-muted-foreground mt-2 p-2 rounded-md bg-muted/50 w-full text-left">{consent.notes}</p>
                    )}
                    <div className="mt-3 w-full space-y-2">
                      {canGrant && (
                        <Button
                          size="sm"
                          className="w-full bg-emerald-600 hover:bg-emerald-700 text-white"
                          onClick={() => handleGrantConsent(consent.id, consent.consentType)}
                          disabled={consentMutation.isPending}
                        >
                          {consentMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
                          {needsReconsent ? 'Re-consent to new policy' : isDenied ? 'Grant Consent' : 'Grant Consent'}
                        </Button>
                      )}
                      {isPending && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-800 dark:hover:bg-red-900/20"
                          onClick={() => handleDenyConsent(consent.id, consent.consentType)}
                          disabled={consentMutation.isPending}
                        >
                          Deny
                        </Button>
                      )}
                      {isGranted && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:border-rose-800 dark:hover:bg-rose-900/20"
                          onClick={() => handleRevokeConsent(consent.id, consent.consentType)}
                        >
                          Revoke
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>
    );
  };

  const renderAnomaliesTab = () => {
    if (anomaliesLoading) {
      return (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      );
    }

    if (anomaliesError) return renderErrorState('Unable to load anomalies', 'Anomaly records could not be fetched. Please try again.');

    const filteredAnomalies = (anomalies || []).filter(a => {
      if (anomalySeverity !== 'all' && a.severity !== anomalySeverity) return false;
      if (anomalyStatus !== 'all' && a.status !== anomalyStatus) return false;
      return true;
    });

    return (
      <div className="space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <Select value={anomalySeverity} onValueChange={setAnomalySeverity}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Severity" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Severities</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <Select value={anomalyStatus} onValueChange={setAnomalyStatus}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="detected">Detected</SelectItem>
              <SelectItem value="investigating">Investigating</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="false_positive">False Positive</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Anomaly Cards */}
        {filteredAnomalies.length === 0 ? (
          <EmptyState icon={ShieldAlert} title="No anomalies found" description="No anomalies matching your filters." />
        ) : (
          <div className="space-y-3">
            {filteredAnomalies.map((anomaly, idx) => {
              const sevCfg = SEVERITY_CONFIG[anomaly.severity] || SEVERITY_CONFIG.low;
              return (
                <motion.div
                  key={anomaly.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.2, delay: idx * 0.03 }}
                >
                  <Card className={`${cardClass} border-l-4 ${sevCfg.border}`}>
                    <CardContent className="p-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${sevCfg.color}`}>
                              {anomaly.type}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                              {anomaly.status}
                            </Badge>
                          </div>
                          <h3 className="text-sm font-semibold">{anomaly.title}</h3>
                          {anomaly.description && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{anomaly.description}</p>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-lg font-bold">{anomaly.score}</div>
                          <div className="w-16 h-1.5 rounded-full bg-muted mt-1 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${anomaly.score >= 80 ? 'bg-rose-500' : anomaly.score >= 60 ? 'bg-orange-500' : anomaly.score >= 40 ? 'bg-amber-500' : 'bg-blue-500'}`}
                              style={{ width: `${anomaly.score}%` }}
                            />
                          </div>
                          <p className="text-[10px] text-muted-foreground mt-1">{formatRelativeTime(anomaly.createdAt)}</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // ===== Render projects tab =====
  const renderProjectsTab = () => {
    const { setPageContext, setCurrentPage } = useAppStore.getState();

    if (selfProjectsLoading) {
      return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      );
    }

    if (selfProjectsError) return renderErrorState('Unable to load projects', 'Project assignments could not be fetched. Please try again.');

    if (!selfProjects || selfProjects.length === 0) {
      return (
        <EmptyState
          icon={FolderKanban}
          title="No projects assigned"
          description="This employee has no active project assignments."
        />
      );
    }

    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {selfProjects.map((item, idx) => {
          const mood = item.sentiment?.mood;
          const score = item.sentiment?.score;
          return (
            <motion.div
              key={item.projectId}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05, duration: 0.3 }}
            >
              <Card className="h-full transition-all hover:shadow-md group">
                <CardContent className="pt-5 pb-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
                        style={{ backgroundColor: `${item.project.color || '#10b981'}1a`, color: item.project.color || '#10b981' }}
                      >
                        <FolderKanban className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold truncate">{item.project.name}</h3>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1">
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                            {item.project.status}
                          </Badge>
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                            {item.role}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <span className="text-sm font-bold tabular-nums shrink-0">
                      {formatHours(item.totalHours)}
                    </span>
                  </div>

                  {/* Sentiment availability — real DB-backed status */}
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5 text-xs">
                      <HeartPulse className="w-3.5 h-3.5 text-primary" />
                      {mood ? (
                        <span className="text-muted-foreground">
                          Sentiment{' '}
                          <span className="font-medium text-foreground">
                            {score !== null ? `${score}` : 'not scored'}
                          </span>{' '}
                          · {mood.replace('-', ' ')}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">Not analyzed</span>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs gap-1"
                      onClick={() => {
                        setPageContext(`project:${item.projectId}:sentiment`);
                        setCurrentPage('projects');
                      }}
                    >
                      Open Project
                      <ChevronRightIcon className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          );
        })}
      </div>
    );
  };

  // ===== Render telemetry tab =====
  const renderTelemetryTab = () => {
    if (telemetryLoading) {
      return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      );
    }

    if (telemetryError || !telemetry) {
      return renderErrorState('Unable to load telemetry', 'Telemetry summary could not be fetched. Please try again.');
    }

    const { websites, keyboard, location, webcam } = telemetry;

    // Status label per capability: consent/config gates surface explicitly
    // instead of silently showing zeros.
    const gateLabel = (cap: { consentGranted: boolean; configEnabled: boolean; available: boolean }): { label: string; tone: 'ok' | 'warn' | 'off' } => {
      if (!cap.consentGranted) return { label: 'Consent revoked', tone: 'warn' };
      if (!cap.configEnabled) return { label: 'Disabled by org config', tone: 'warn' };
      if (!cap.available) return { label: 'Not available', tone: 'off' };
      return { label: 'Active', tone: 'ok' };
    };

    const toneClass = (tone: 'ok' | 'warn' | 'off') =>
      tone === 'ok' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : 'text-muted-foreground';

    const cards: Array<{
      key: string;
      icon: React.ElementType;
      title: string;
      detail: string;
      tab: string;
      gate: { label: string; tone: 'ok' | 'warn' | 'off' };
    }> = [
      {
        key: 'websites',
        icon: Globe,
        title: 'Websites',
        detail: websites.topDomains.length > 0
          ? websites.topDomains.slice(0, 3).map((d) => `${d.domain} (${num(d.visits)}×)`).join(' · ')
          : 'No website activity in the last 30 days',
        tab: 'apps',
        gate: gateLabel(websites),
      },
      {
        key: 'keyboard',
        icon: Keyboard,
        title: 'Keyboard Activity',
        detail: `${num(keyboard.totalKeystrokes).toLocaleString()} keystrokes · ${formatDuration(num(keyboard.totalActiveTypingSeconds))} typing · ${num(keyboard.intervals)} intervals`,        tab: 'keyboard',
        gate: gateLabel(keyboard),
      },
      {
        key: 'location',
        icon: MapPin,
        title: 'Location',
        detail: location.latest
          ? `${location.latest.source === 'native' ? '📡 Device' : '🌐 IP'} · ${num(location.latest.latitude).toFixed(5)}, ${num(location.latest.longitude).toFixed(5)} · ${location.latest.accuracy !== null ? `±${num(location.latest.accuracy).toFixed(0)}m` : 'approximate'} · ${formatRelativeTime(location.latest.recordedAt)}`
          : 'No location fix recorded',
        tab: 'location',
        gate: gateLabel(location),
      },
      {
        key: 'webcam',
        icon: Webcam,
        title: 'Webcam',
        detail: webcam.session
          ? `Session active since ${webcam.session.startedAt ? new Date(webcam.session.startedAt).toLocaleTimeString() : '—'}`
          : 'No active webcam session',
        tab: 'webcam',
        gate: gateLabel(webcam),
      },
    ];

    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cards.map((card) => {
            const CardIcon = card.icon;
            return (
              <motion.div key={card.key} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                <Card className={cardClass}>
                  <CardContent className="p-0">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                          <CardIcon className="w-5 h-5 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-sm font-semibold">{card.title}</h3>
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{card.detail}</p>
                          <p className={`text-xs font-medium mt-1 ${toneClass(card.gate.tone)}`}>{card.gate.label}</p>
                        </div>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs gap-1 mt-4"
                      onClick={() => openEmployeeDetails(card.tab)}
                      type="button"
                    >
                      Open in Employee Details
                      <ChevronRightIcon className="w-3.5 h-3.5" />
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Telemetry shown here is a summary. Full operational views (activity, screenshots, devices, consent history) live in Employee Details.
        </p>
      </div>
    );
  };

  // ===== Main Render =====
  return (
    <div className="space-y-6" role="region" aria-label="Employee Portal">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
            <UserCircle className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">Employee Portal</h1>
            <p className="text-sm text-muted-foreground">Manager view of a selected employee's monitoring summary</p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <EmployeeCombobox
            value={selectedEmployeeId || null}
            onValueChange={(v) => setSelectedEmployeeId((v as string) ?? '')}
            status="active"
            placeholder="Select employee"
            labelFormat="name-designation"
            className="w-full sm:w-[260px]"
            ariaLabel="Switch employee"
          />
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 whitespace-nowrap"
            onClick={openEmployeeDetails}
            disabled={!selectedEmployeeId}
          >
            <UserCircle className="w-3.5 h-3.5" />
            View Employee Details
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="w-full flex h-auto p-1 bg-muted/50 rounded-lg">
          <TabsTrigger value="overview" className="flex-1 gap-1.5 text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <BarChart3 className="w-3.5 h-3.5 hidden sm:inline" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="consents" className="flex-1 gap-1.5 text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <ShieldCheck className="w-3.5 h-3.5 hidden sm:inline" />
            Consents
          </TabsTrigger>
          <TabsTrigger value="anomalies" className="flex-1 gap-1.5 text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Zap className="w-3.5 h-3.5 hidden sm:inline" />
            Anomalies
          </TabsTrigger>
          <TabsTrigger value="projects" className="flex-1 gap-1.5 text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <FolderKanban className="w-3.5 h-3.5 hidden sm:inline" />
            Projects
          </TabsTrigger>
          <TabsTrigger value="telemetry" className="flex-1 gap-1.5 text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Activity className="w-3.5 h-3.5 hidden sm:inline" />
            Telemetry
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          {selectedEmployeeId ? renderOverviewTab() : (
            <EmptyState icon={UserCircle} title="Select an employee" description="Please select an employee to view their portal data." />
          )}
        </TabsContent>

        <TabsContent value="consents" className="mt-6">
          {selectedEmployeeId ? renderConsentsTab() : (
            <EmptyState icon={UserCircle} title="Select an employee" description="Please select an employee to manage their consents." />
          )}
        </TabsContent>

        <TabsContent value="anomalies" className="mt-6">
          {selectedEmployeeId ? renderAnomaliesTab() : (
            <EmptyState icon={UserCircle} title="Select an employee" description="Please select an employee to view their anomalies." />
          )}
        </TabsContent>

        <TabsContent value="projects" className="mt-6">
          {selectedEmployeeId ? renderProjectsTab() : (
            <EmptyState icon={FolderKanban} title="Select an employee" description="Please select an employee to view their assigned projects." />
          )}
        </TabsContent>

        <TabsContent value="telemetry" className="mt-6">
          {selectedEmployeeId ? renderTelemetryTab() : (
            <EmptyState icon={UserCircle} title="Select an employee" description="Please select an employee to view their telemetry summary." />
          )}
        </TabsContent>
      </Tabs>

      {/* Revoke Confirmation Dialog */}
      <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Revoke Consent</DialogTitle>
            <DialogDescription>
              Are you sure you want to revoke this consent for the selected employee? This will disable the associated monitoring feature immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setRevokeDialogOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={confirmRevoke}
              disabled={consentMutation.isPending}
            >
              {consentMutation.isPending && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
              Revoke Consent
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
