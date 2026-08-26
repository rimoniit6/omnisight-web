'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TIMEZONE_OPTIONS } from '@/lib/timezone';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import {
  Building2,
  Users,
  Monitor,
  AlertTriangle,
  MapPin,
  Globe,
  Phone,
  Mail,
  Calendar,
  Shield,
  Activity,
  Check,
  X,
  Clock,
  Info,
  Loader2,
  KeyRound,
  Copy,
  RefreshCw,
  Trash2,
  AlertCircle,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { TeamHeatmap } from './team-heatmap';
import { HeadcountChart } from './headcount-chart';
import { RecentHires } from './recent-hires';

const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--primary)'];

const deptAvatarColors: Record<string, string> = {
  Engineering: 'bg-emerald-100 text-emerald-700',
  Marketing: 'bg-teal-100 text-teal-700',
  Sales: 'bg-cyan-100 text-cyan-700',
  Design: 'bg-amber-100 text-amber-700',
  HR: 'bg-rose-100 text-rose-700',
  Finance: 'bg-purple-100 text-purple-700',
};

function getDeptColor(deptName: string): string {
  return deptAvatarColors[deptName] || 'bg-slate-100 text-slate-700';
}

// Friendly labels for the org-scoped monitoring configuration card.
const MONITORING_LABELS: Record<string, { label: string; suffix?: string }> = {
  heartbeat_interval: { label: 'Heartbeat Interval', suffix: 'sec' },
  screenshot_enabled: { label: 'Screenshots' },
  screenshot_frequency: { label: 'Screenshot Frequency', suffix: 'min' },
  app_tracking: { label: 'App Tracking' },
  website_tracking: { label: 'Website Tracking' },
  idle_detection: { label: 'Idle Detection' },
  idle_timeout: { label: 'Idle Timeout', suffix: 'min' },
  working_hours_only: { label: 'Working Hours Only' },
  work_start_time: { label: 'Work Start' },
  work_end_time: { label: 'Work End' },
  ai_anomaly_detection: { label: 'AI Anomaly Detection' },
};

export function OrganizationPage() {
  const queryClient = useQueryClient();
  // Draft timezone override; the server value (org.timezone) is authoritative
  // until the user picks a different one.
  const [timezoneOverride, setTimezoneOverride] = useState<string | null>(null);
  const [timezoneSaving, setTimezoneSaving] = useState(false);

  // ── Enrollment Code state ──────────────────────────────────────────────
  const [enrollmentCode, setEnrollmentCode] = useState<string | null>(null);
  const [enrollmentSaving, setEnrollmentSaving] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [enrollmentCodeCopied, setEnrollmentCodeCopied] = useState(false);



  const handleGenerateEnrollmentCode = async () => {
    setEnrollmentSaving(true);
    try {
      const res = await fetch('/api/organization/enrollment-code', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to generate enrollment code');
        return;
      }
      setEnrollmentCode(data.code);
      setEnrollmentCodeCopied(false);
      toast.success('Enrollment code generated. Copy it now — it will not be shown again.');
    } catch {
      toast.error('Failed to generate enrollment code');
    } finally {
      setEnrollmentSaving(false);
    }
  };

  const handleRevokeEnrollmentCode = async () => {
    setEnrollmentSaving(true);
    try {
      const res = await fetch('/api/organization/enrollment-code', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to revoke enrollment code');
        return;
      }
      setEnrollmentCode(null);
      setShowRevokeConfirm(false);
      toast.success('Enrollment code revoked. New agent registrations will require a new code.');
    } catch {
      toast.error('Failed to revoke enrollment code');
    } finally {
      setEnrollmentSaving(false);
    }
  };

  const copyEnrollmentCode = async () => {
    if (!enrollmentCode) return;
    try {
      await navigator.clipboard.writeText(enrollmentCode);
      setEnrollmentCodeCopied(true);
      toast.success('Enrollment code copied to clipboard');
      setTimeout(() => setEnrollmentCodeCopied(false), 2000);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  const { data: org, isLoading: orgLoading } = useQuery({
    queryKey: ['organization'],
    queryFn: async () => {
      const res = await fetch('/api/organization');
      if (!res.ok) throw new Error('Failed to fetch organization');
      return res.json();
    },
  });

  // Org-scoped monitoring configuration — from the real settings API (the
  // dead MonitoringPolicy table was removed; there is no policy fallback).
  const { data: monitoringData } = useQuery({
    queryKey: ['org-monitoring'],
    queryFn: async () => {
      const res = await fetch('/api/settings/monitoring');
      if (!res.ok) return { data: [] };
      return res.json();
    },
  });
  const monitoring = (monitoringData?.data || []) as Array<{
    key: string;
    value: boolean | number | string;
    type: string;
    default: boolean | number | string;
    min?: number;
    max?: number;
  }>;

  const timezone = timezoneOverride ?? (org?.timezone ?? 'UTC');

  // Save the timezone through PATCH /api/organization (admin+, IANA-validated,
  // audited). The timezone is NEVER duplicated into SystemSetting.
  const handleTimezoneChange = async (value: string) => {
    if (!value || value === timezone) return;
    setTimezoneSaving(true);
    try {
      const res = await fetch('/api/organization', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: value }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || 'Failed to update timezone');
        return;
      }
      setTimezoneOverride(value);
      toast.success('Organization timezone updated');
      queryClient.invalidateQueries({ queryKey: ['organization'] });
    } catch {
      toast.error('Failed to update timezone');
    } finally {
      setTimezoneSaving(false);
    }
  };

  const { data: employeesData, isLoading: empLoading } = useQuery({
    queryKey: ['employees-list-org'],
    queryFn: async () => {
      const res = await fetch('/api/employees?pageSize=100');
      if (!res.ok) return { data: [] };
      return res.json();
    },
  });

  const employees = employeesData?.data || [];

  const { data: teamData, isLoading: teamLoading } = useQuery({
    queryKey: ['organization-team-data'],
    queryFn: async () => {
      const res = await fetch('/api/organization/team-data');
      if (!res.ok) return null;
      return res.json();
    },
  });

  if (orgLoading || empLoading || teamLoading) {
    return (
      <div className="space-y-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-32 bg-muted/30 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (!org) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Building2 className="w-10 h-10 mx-auto mb-3" />
        <p>No organization found</p>
      </div>
    );
  }

  const activeEmployees = org.activeEmployeeCount || 0;

  // Department chart data
  const deptChartData = (org.departments || []).map((dept: Record<string, unknown>) => ({
    name: dept.name as string,
    count: (dept._count as Record<string, number>)?.employees || 0,
  }));

  return (
    <div className="space-y-6" role="region" aria-label="Organization">
      {/* Header Card with Gradient */}
      <Card className="border-0 shadow-lg overflow-hidden">
        <div className="relative bg-gradient-to-br from-primary to-primary/85 p-6">
          {/* Decorative elements */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/3" />
          <div className="absolute bottom-0 left-0 w-40 h-40 bg-white/5 rounded-full translate-y-1/2 -translate-x-1/4" />
          <div className="absolute top-1/2 right-1/4 w-20 h-20 bg-white/5 rounded-full" />

          <div className="relative z-10 flex flex-col sm:flex-row gap-6">
            <div className="h-20 w-20 rounded-xl bg-white/15 backdrop-blur-sm flex items-center justify-center shrink-0 border border-white/20">
              <Building2 className="w-10 h-10 text-white" />
            </div>
            <div className="flex-1 min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-bold text-white">{org.name}</h1>
                <Badge
                  className={
                    org.status === 'active'
                      ? 'bg-white/20 text-white hover:bg-white/30 border border-white/30'
                      : 'bg-amber-400/20 text-amber-100 hover:bg-amber-400/30 border border-amber-300/30'
                  }
                  variant="default"
                >
                  {org.status.charAt(0).toUpperCase() + org.status.slice(1)}
                </Badge>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 text-sm text-white/80">
                {org.email && (
                  <div className="flex items-center gap-2">
                    <Mail className="w-4 h-4 text-white/60" />
                    <span>{org.email}</span>
                  </div>
                )}
                {org.phone && (
                  <div className="flex items-center gap-2">
                    <Phone className="w-4 h-4 text-white/60" />
                    <span>{org.phone}</span>
                  </div>
                )}
                {org.address && (
                  <div className="flex items-center gap-2">
                    <MapPin className="w-4 h-4 text-white/60" />
                    <span>{org.address}</span>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Globe className="w-4 h-4 text-white/60" />
                  <span>{org.timezone} · {org.language.toUpperCase()} · {org.currency}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-white/60" />
                  <span>Created {format(new Date(org.createdAt), 'MMM d, yyyy')}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Stats Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-emerald-500 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                <Users className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{org.activeEmployeeCount || 0}</p>
                <p className="text-xs text-muted-foreground">Active Employees</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-teal-500 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-teal-500/10 flex items-center justify-center">
                <Monitor className="w-5 h-5 text-teal-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{org.deviceCount || 0}</p>
                <p className="text-xs text-muted-foreground">Total Devices</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-cyan-500 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                <Building2 className="w-5 h-5 text-cyan-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{org.departments?.length || 0}</p>
                <p className="text-xs text-muted-foreground">Departments</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-rose-500 shadow-sm">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-rose-500/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{org.activeAlertsCount || 0}</p>
                <p className="text-xs text-muted-foreground">Active Alerts</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Team Members */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-4 h-4 text-emerald-500" />
            Team Members
          </CardTitle>
        </CardHeader>
        <CardContent>
          {employees.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No team members found</p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-4">
              {employees.map((emp: Record<string, unknown>) => {
                const deptName = (emp.department as Record<string, string>)?.name || 'Unknown';
                const firstName = emp.firstName as string;
                const lastName = emp.lastName as string;
                return (
                  <div key={emp.id as string} className="flex flex-col items-center gap-1.5 p-2 rounded-lg hover:bg-muted/30 transition-colors">
                    <Avatar className="h-10 w-10 border-2 border-transparent">
                      <AvatarFallback className={`text-xs font-bold ${getDeptColor(deptName)}`}>
                        {firstName[0]}{lastName[0]}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-[11px] font-medium text-center leading-tight truncate w-full">
                      {firstName} {lastName}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Employee Capacity — real headcount, no artificial seat limit */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="w-4 h-4 text-emerald-500" />
            Employees
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="rounded-lg bg-muted/30 p-4">
            <p className="text-2xl font-bold">{org.employeeCount || 0}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Total Employees</p>
          </div>
          <div className="rounded-lg bg-muted/30 p-4">
            <p className="text-2xl font-bold">{activeEmployees}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Active Employees</p>
          </div>
          <div className="rounded-lg bg-muted/30 p-4">
            <p className="text-2xl font-bold">{(org.employeeCount || 0) - activeEmployees}</p>
            <p className="text-xs text-muted-foreground mt-0.5">Inactive Employees</p>
          </div>
        </CardContent>
      </Card>

      {/* Departments & Subscription */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Department Distribution Chart */}
        <Card className="border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="w-4 h-4 text-emerald-500" />
              Department Distribution
            </CardTitle>
          </CardHeader>
          <CardContent>
            {deptChartData.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No departments found</p>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={deptChartData} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                    <XAxis type="number" tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
                    <YAxis
                      type="category"
                      dataKey="name"
                      tick={{ fontSize: 11 }}
                      stroke="var(--muted-foreground)"
                      width={90}
                    />
                    <Tooltip
                      contentStyle={{
                        background: 'var(--card)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        fontSize: '12px',
                      }}
                      formatter={(value: number) => [`${value} employees`, 'Count']}
                    />
                    <Bar dataKey="count" radius={[0, 6, 6, 0]} animationDuration={800}>
                      {deptChartData.map((_entry: Record<string, unknown>, index: number) => (
                        <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Subscription Info */}
        <Card className="border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Shield className="w-4 h-4 text-emerald-500" />
              Subscription
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* P3-5: no subscription source exists in the DB — never fabricate
                a plan/renewal date. The card only shows database-driven facts
                and an explicit not-configured note. */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-lg font-semibold">Not configured</p>
                <p className="text-xs text-muted-foreground">No subscription information is available for this organization.</p>
              </div>
              <Badge variant="outline" className="text-muted-foreground">N/A</Badge>
            </div>
            <Separator />
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Active Employees</span>
                <span className="font-medium">{activeEmployees}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Team Heatmap */}
      {teamData?.teamHeatmap && <TeamHeatmap data={teamData.teamHeatmap} />}

      {/* Headcount Section */}
      {teamData?.headcount && <HeadcountChart data={teamData.headcount} />}

      {/* Headcount & Recent Hires row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Hires */}
        {teamData?.recentHires && <RecentHires hires={teamData.recentHires} />}

        {/* Department Performance Table */}
        <Card className="border shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="w-4 h-4 text-emerald-500" />
              Department Performance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="pb-2 text-xs font-medium text-muted-foreground">Department</th>
                    <th className="pb-2 text-xs font-medium text-muted-foreground text-right">Team</th>
                    <th className="pb-2 text-xs font-medium text-muted-foreground text-right">Hours</th>
                    <th className="pb-2 text-xs font-medium text-muted-foreground text-right">Productivity</th>
                  </tr>
                </thead>
                <tbody>
                  {teamData?.departments?.map((dept: Record<string, unknown>) => (
                    <tr key={dept.id as string} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="py-2.5 font-medium">{dept.name as string}</td>
                      <td className="py-2.5 text-right text-muted-foreground">
                        {dept.activeCount as number}<span className="text-muted-foreground/60">/{dept.employeeCount as number}</span>
                      </td>
                      <td className="py-2.5 text-right text-muted-foreground">{dept.totalHours as number}h</td>
                      <td className="py-2.5 text-right">
                        <span className={`font-medium ${((dept.avgProductivity as number) || 0) > 0.5 ? 'text-emerald-600' : 'text-amber-600'}`}>
                          {(((dept.avgProductivity as number) || 0) * 100).toFixed(0)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Organization Timezone — Organization.timezone is the single source of
          truth; PATCH /api/organization (admin+, IANA-validated, audited). */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Globe className="w-4 h-4 text-emerald-500" />
            Timezone
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 flex-wrap">
            <Select value={timezone || undefined} onValueChange={(v) => void handleTimezoneChange(v)}>
              <SelectTrigger className="w-full sm:w-80">
                <SelectValue placeholder="Select timezone..." />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {timezoneSaving && <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />}
            <span className="text-xs text-muted-foreground">
              Drives working-hours windows and dashboard day buckets for all agents.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Enrollment Code — zero-touch device enrollment credential.
          POST /api/organization/enrollment-code generates/rotates (plaintext
          returned exactly once); DELETE revokes. Admin-only, org-scoped. */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-emerald-500" />
            Device Enrollment Code
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg bg-muted/30 p-4">
            <div className="flex items-start gap-3">
              <div className="h-10 w-10 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
                <KeyRound className="w-5 h-5 text-amber-600" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium">Zero-Touch Device Enrollment</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Allow new Windows Agent users to request joining your organization without
                  manually creating an employee account. The enrollment code is required for
                  the Agent's "Join as Guest" feature to work.
                </p>
              </div>
            </div>
          </div>

          {enrollmentCode ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  <div className="text-sm text-amber-800">
                    <p className="font-medium">Copy this code now</p>
                    <p className="text-xs mt-1">
                      This code is returned only once at generation time. It cannot be retrieved later.
                      Provide it to agents via build script, environment variable, or MDM.
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-muted rounded-lg text-sm font-mono break-all select-all">
                  {enrollmentCode}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void copyEnrollmentCode()}
                  className="shrink-0"
                >
                  {enrollmentCodeCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {enrollmentCodeCopied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleGenerateEnrollmentCode()}
                  disabled={enrollmentSaving}
                >
                  {enrollmentSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                  Regenerate Code
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowRevokeConfirm(true)}
                  disabled={enrollmentSaving}
                >
                  <Trash2 className="w-4 h-4" /> Revoke Code
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="h-2 w-2 rounded-full bg-red-400" />
                <span className="text-sm text-muted-foreground">No enrollment code configured</span>
              </div>
              <Button
                variant="outline"
                onClick={() => void handleGenerateEnrollmentCode()}
                disabled={enrollmentSaving}
              >
                {enrollmentSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
                Generate Enrollment Code
              </Button>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Anyone with this code can request device enrollment. Revoke it immediately if compromised.
            Agent configuration: AGENT_ENROLLMENT_CODE (build-time) or WL_ENROLLMENT_CODE (runtime).
          </p>
        </CardContent>
      </Card>

      {/* Revoke confirmation dialog */}
      <AlertDialog open={showRevokeConfirm} onOpenChange={setShowRevokeConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke Enrollment Code?</AlertDialogTitle>
            <AlertDialogDescription>
              This will disable zero-touch device enrollment. New Agent installations will not be
              able to request joining until a new code is generated. Existing enrolled devices are
              not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={enrollmentSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleRevokeEnrollmentCode()}
              disabled={enrollmentSaving}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {enrollmentSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Revoke Code
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Monitoring Configuration — real org-scoped values from
          /api/settings/monitoring (the dead MonitoringPolicy table is gone). */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="w-4 h-4 text-emerald-500" />
            Monitoring Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {monitoring.map((item) => {
              const meta = MONITORING_LABELS[item.key] || { label: item.key.replace(/_/g, ' ') };
              const isBoolean = item.type === 'boolean';
              const enabled = item.value === true;
              // Capability notes: website tracking is LIVE and collects
              // DOMAIN names only (privacy-first — see src/lib/domain.ts);
              // AI anomaly detection is server-side only (never an agent
              // runtime setting — mirror of the Settings page separation).
              const unsupported = item.key === 'ai_anomaly_detection';
              const note = unsupported ? 'Server-side only — not used by the Desktop Agent' : null;
              return (
                <div key={item.key} className="flex items-center gap-3 p-3 rounded-lg bg-muted/30">
                  {isBoolean && !unsupported ? (
                    enabled ? <Check className="w-5 h-5 text-emerald-500 shrink-0" /> : <X className="w-5 h-5 text-red-400 shrink-0" />
                  ) : unsupported ? (
                    <Info className="w-5 h-5 text-amber-500 shrink-0" />
                  ) : (
                    <Clock className="w-5 h-5 text-emerald-500 shrink-0" />
                  )}
                  <div>
                    <p className="text-sm font-medium">{meta.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {note ?? (isBoolean ? (enabled ? 'Enabled' : 'Disabled') : `${String(item.value)}${meta.suffix ? ` ${meta.suffix}` : ''}`)}
                    </p>
                    {item.key === 'website_tracking' && (
                      <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                        Collects the domains employees visit (e.g. github.com) — never full URLs, paths or queries.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Managed in Settings → Monitoring — applied to agents on their next config refresh.
          </p>
        </CardContent>
      </Card>

      {/* Recent Activity */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-500" />
            Recent Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="max-h-96 overflow-y-auto custom-scrollbar">
            <div className="space-y-1">
              {org.recentAuditLogs?.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-6">No recent activity</p>
              )}
              {org.recentAuditLogs?.map((log: Record<string, unknown>) => {
                const actionColor: Record<string, string> = {
                  create: 'bg-emerald-100 text-emerald-700',
                  update: 'bg-blue-100 text-blue-700',
                  delete: 'bg-rose-100 text-rose-700',
                  login: 'bg-teal-100 text-teal-700',
                  logout: 'bg-slate-100 text-slate-600',
                  export: 'bg-amber-100 text-amber-700',
                  configure: 'bg-purple-100 text-purple-700',
                };
                return (
                  <div key={log.id as string} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/30 transition-colors">
                    <Badge
                      className={`text-[10px] h-5 px-1.5 border-0 shrink-0 ${actionColor[(log.action as string)] || 'bg-gray-100 text-gray-600'}`}
                      variant="secondary"
                    >
                      {log.action as string}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{log.description as string}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="outline" className="text-[10px] h-4 px-1.5">{log.resource as string}</Badge>
                        {log.userId ? <span className="text-[10px] text-muted-foreground">User: {(log.userId as string).slice(0, 8)}</span> : null}
                      </div>
                    </div>
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {formatDistanceToNow(new Date(log.createdAt as string), { addSuffix: true })}
                    </span>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
