'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useTheme } from 'next-themes';
import { Save, Shield, Cpu, Bell, Settings, ToggleLeft, Wrench, Sun, Moon, Monitor, Users, Trash2, ShieldCheck, Sparkles, AlertTriangle } from 'lucide-react';
import { UserManagement } from '@/components/auth/user-management';
import { ChangePasswordDialog } from '@/components/auth/change-password-dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';

const sections = [
  { key: 'general', label: 'General', icon: Settings },
  { key: 'security', label: 'Security', icon: Shield },
  { key: 'monitoring', label: 'Monitoring', icon: Cpu },
  { key: 'notification', label: 'Notifications', icon: Bell },
  { key: 'users', label: 'User Management', icon: Users },
];

function ThemeSelector() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const currentValue = resolvedTheme || theme || 'light';

  const options = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'System', icon: Monitor },
  ];

  return (
    <div className='flex items-center gap-3'>
      <span className='text-sm text-muted-foreground'>Theme</span>
      <div className='relative inline-flex items-center rounded-full bg-muted p-1'>
        {/* Animated sliding indicator */}
        <div
          className='absolute top-1 bottom-1 rounded-full bg-white dark:bg-card shadow-sm transition-all duration-300 ease-out'
          style={{
            width: `calc((100% - 8px) / 3)`,
            left: `calc(${options.findIndex((o) => o.value === currentValue) * (100 / 3)}% + 4px)`,
          }}
        />
        {options.map((opt) => {
          const Icon = opt.icon;
          const isActive = opt.value === currentValue;
          return (
            <button
              key={opt.value}
              onClick={() => setTheme(opt.value)}
              className={cn(
                'relative z-10 flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium transition-colors duration-200',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className={cn('w-3.5 h-3.5', isActive && 'text-primary')} />
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ==================== Data Retention (org-scoped, backend-enforced) ====================

interface RetentionSetting {
  key: string;
  category: string;
  days: number;
  default: number;
  behavior: 'delete' | 'anonymize';
}

const RETENTION_LABELS: Record<string, string> = {
  screenshot_retention_days: 'Screenshot Retention',
  activity_retention_days: 'Activity Retention',
  report_retention_days: 'Report Retention',
  ai_insight_retention_days: 'AI Insight Retention',
  audit_log_retention_days: 'Audit Log Retention',
  consent_log_retention_days: 'Consent Log Retention',
};

function DataRetentionCard() {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['retention-settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/retention');
      if (!res.ok) throw new Error('Failed to load retention settings');
      const json = await res.json();
      const map: Record<string, string> = {};
      (json.data || []).forEach((s: RetentionSetting) => { map[s.key] = String(s.days); });
      setValues(map);
      return json;
    },
  });

  const retention = (data?.data || []) as RetentionSetting[];

  const handleSave = async (key: string) => {
    const raw = values[key] ?? '';
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 3650) {
      toast.error('Retention must be a whole number of days between 0 and 3650');
      return;
    }
    setSaving(key);
    try {
      const res = await fetch('/api/settings/retention', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: String(n) }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || 'Failed to update');
      }
      toast.success('Retention policy updated — enforced by the background cleanup job');
      queryClient.invalidateQueries({ queryKey: ['retention-settings'] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update retention');
    } finally {
      setSaving(null);
    }
  };

  if (isLoading) {
    return (
      <Card className='falcon-card falcon-card-hover'>
        <CardContent className='p-6'><div className='space-y-3'>{Array.from({ length: 3 }).map((_, i) => <div key={i} className='h-10 bg-muted/30 rounded animate-pulse' />)}</div></CardContent>
      </Card>
    );
  }

  return (
    <Card className='falcon-card falcon-card-hover'>
      <CardHeader className='pb-3'>
        <div className='flex items-center gap-3'>
          <div className='w-1 h-8 rounded-full bg-emerald-500' />
          <div className='flex items-center gap-2'>
            <div className='h-8 w-8 rounded-lg bg-emerald-50 dark:bg-emerald-900/40 flex items-center justify-center'>
              <Trash2 className='w-4 h-4 text-emerald-600 dark:text-emerald-400' />
            </div>
            <div>
              <CardTitle className='text-sm font-semibold'>Data Retention</CardTitle>
              <p className='text-xs text-muted-foreground mt-0.5'>Org-scoped retention in days — enforced by the scheduled cleanup job (0 = keep forever)</p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-3'>
        {retention.map((r) => (
          <div key={r.key} className='flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors'>
            <div className='min-w-0'>
              <div className='flex items-center gap-2'>
                <Label className='text-sm font-medium'>{RETENTION_LABELS[r.key] || r.key.replace(/_/g, ' ')}</Label>
                {r.behavior === 'anonymize' ? (
                  <span className='inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300'>
                    <ShieldCheck className='h-3 w-3' /> anonymized, never deleted
                  </span>
                ) : (
                  <span className='inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'>
                    deleted past cutoff
                  </span>
                )}
              </div>
              <p className='text-xs text-muted-foreground mt-0.5 font-mono truncate'>{r.key}</p>
            </div>
            <div className='flex items-center gap-2 shrink-0'>
              <Input
                type='number'
                min={0}
                max={3650}
                value={values[r.key] ?? String(r.days)}
                onChange={(e) => setValues((prev) => ({ ...prev, [r.key]: e.target.value }))}
                className='w-24 h-8'
              />
              <Button size='sm' variant='ghost' className='h-8 text-primary hover:text-primary' onClick={() => handleSave(r.key)} disabled={saving === r.key}>
                <Save className='w-3.5 h-3.5' />
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ==================== Agent Monitoring (org-scoped, drives GET /api/agent/config) ====================

interface MonitoringSetting {
  key: string;
  value: boolean | number | string;
  type: 'boolean' | 'number' | 'time';
  default: boolean | number | string;
  min?: number;
  max?: number;
}

const MONITORING_LABELS: Record<string, string> = {
  heartbeat_interval: 'Heartbeat Interval (seconds)',
  screenshot_enabled: 'Screenshots Enabled',
  screenshot_frequency: 'Screenshot Frequency (minutes)',
  app_tracking: 'App Tracking',
  website_tracking: 'Website Tracking',
  idle_detection: 'Idle Detection',
  idle_timeout: 'Idle Timeout (minutes)',
  working_hours_only: 'Working Hours Only',
  work_start_time: 'Work Start Time',
  work_end_time: 'Work End Time',
  ai_anomaly_detection: 'Anomaly Detection',
  usb_monitoring: 'USB Device Monitoring',
  app_policy_enforcement: 'App Policy Enforcement',
  app_policy_terminate: 'Terminate Blocked Apps',
};

interface MonitoringRowProps {
  s: MonitoringSetting;
  onSaved: () => void;
  /** Optional outline badge next to the label (e.g. "Not implemented"). */
  badge?: string;
  /** Optional capability-truthfulness helper text under the key line. */
  helper?: string;
  /** When true the control is read-only — the stored value is still shown. */
  disabled?: boolean;
  /** Confirmation dialog config for destructive boolean toggles (false→true only). */
  confirmEnable?: { title: string; description: string };
}

function MonitoringRow({ s, onSaved, badge, helper, disabled = false, confirmEnable }: MonitoringRowProps) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState<string | number | boolean>(s.value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  // Local state initializes from the server value; the parent remounts this
  // row (key includes s.value) whenever the server value changes, so no
  // effect-based sync is needed.

  const handleSave = async (raw: unknown) => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/settings/monitoring', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: s.key, value: raw }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || 'Failed to update');
      }
      toast.success('Agent setting updated — synced to agents on their next config refresh');
      queryClient.invalidateQueries({ queryKey: ['monitoring-settings'] });
      onSaved();
    } catch (err) {
      // Rollback: restore the previous value on failure so the UI does not
      // show a false-success state.
      setValue(s.value);
      setError(err instanceof Error ? err.message : 'Failed to update setting');
    } finally {
      setSaving(false);
    }
  };

  const handleBooleanToggle = (newValue: boolean) => {
    // Destructive enable (false→true) with confirmation dialog.
    if (newValue && confirmEnable) {
      setShowConfirm(true);
      return; // do NOT change value yet — wait for confirmation
    }
    // Non-destructive change (true→false, or no confirmation needed): apply immediately.
    setValue(newValue);
    if (!disabled) void handleSave(newValue);
  };

  const handleConfirmEnable = () => {
    setShowConfirm(false);
    setValue(true);
    if (!disabled) void handleSave(true);
  };

  const handleCancelConfirm = () => {
    // Cancel must leave the value unchanged — the Switch reverts via the key prop.
    setShowConfirm(false);
  };

  const meta = s.type === 'number' && s.min !== undefined && s.max !== undefined
    ? `${s.min}–${s.max}`
    : s.type;

  return (
    <>
    <div className='flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors'>
      <div className='min-w-0'>
        <div className='flex items-center gap-2 flex-wrap'>
          <Label className='text-sm font-medium'>{MONITORING_LABELS[s.key] || s.key.replace(/_/g, ' ')}</Label>
          {badge && <Badge variant='outline' className='text-[10px] h-4 px-1.5'>{badge}</Badge>}
        </div>
        <p className='text-xs text-muted-foreground mt-0.5 font-mono truncate'>{s.key} · {meta} · default {String(s.default)}</p>
        {helper && <p className='text-xs text-muted-foreground mt-0.5'>{helper}</p>}
        {error && <p className='text-xs text-destructive mt-1'>{error}</p>}
      </div>
      <div className='flex items-center gap-2 shrink-0'>
        {s.type === 'boolean' ? (
          <div className={cn('px-1 py-1 rounded-full transition-all duration-300', value === true ? 'bg-success/10 ring-success/20' : 'bg-muted')}>
            <Switch
              checked={value === true}
              disabled={disabled || saving}
              onCheckedChange={handleBooleanToggle}
            />
          </div>
        ) : s.type === 'time' ? (
          <Input
            type='time'
            value={String(value)}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            className='w-32 h-8'
          />
        ) : (
          <Input
            type='number'
            min={s.min}
            max={s.max}
            value={String(value)}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value)}
            className='w-24 h-8'
          />
        )}
        {s.type !== 'boolean' && (
          <Button size='sm' variant='ghost' className='h-8 text-primary hover:text-primary' onClick={() => void handleSave(value)} disabled={saving || disabled}>
            <Save className='w-3.5 h-3.5' />
          </Button>
        )}
      </div>
    </div>
    {/* Confirmation dialog for destructive boolean enable */}
    {confirmEnable && (
      <AlertDialog open={showConfirm} onOpenChange={(open) => { if (!open) handleCancelConfirm(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className='flex items-center gap-2'>
              <AlertTriangle className='h-5 w-5 text-amber-500' />
              {confirmEnable.title}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmEnable.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancelConfirm}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmEnable}
              className='bg-amber-600 hover:bg-amber-700 text-white'
            >
              Enable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    )}
    </>
  );
}

function AgentMonitoringCard() {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['monitoring-settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/monitoring');
      if (!res.ok) throw new Error('Failed to load monitoring settings');
      return res.json();
    },
  });

  const monitoring = (data?.data || []) as MonitoringSetting[];

  if (isLoading) {
    return (
      <Card className='falcon-card falcon-card-hover'>
        <CardContent className='p-6'><div className='space-y-3'>{Array.from({ length: 4 }).map((_, i) => <div key={i} className='h-10 bg-muted/30 rounded animate-pulse' />)}</div></CardContent>
      </Card>
    );
  }

  return (
    <Card className='falcon-card falcon-card-hover'>
      <CardHeader className='pb-3'>
        <div className='flex items-center gap-3'>
          <div className='w-1 h-8 rounded-full bg-primary' />
          <div className='flex items-center gap-2'>
            <div className='h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center'>
              <Cpu className='w-4 h-4 text-primary' />
            </div>
            <div>
              <CardTitle className='text-sm font-semibold'>Desktop Agent</CardTitle>
              <p className='text-xs text-muted-foreground mt-0.5'>Runtime settings fetched by agents via GET /api/agent/config — applied without an agent restart</p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-3'>
        {monitoring
          .filter((s) => s.key !== 'ai_anomaly_detection') // server-side only — rendered below
          .map((s) => (
            <MonitoringRow
              key={`${s.key}:${String(s.value)}`}
              s={s}
              onSaved={() => queryClient.invalidateQueries({ queryKey: ['monitoring-settings'] })}
              {...(s.key === 'website_tracking'
                ? {
                    helper: 'Website tracking requires either the OmniSight browser extension (Chrome/Edge/Firefox) OR Native Website Tracking to be enabled. If both are unavailable, no website activity will be collected even when this setting is on. Requires active activity-tracking consent. Collects DOMAIN names only (e.g. github.com) — never full URLs, paths, queries or page contents.',
                  }
                : {})}
              {...(s.key === 'usb_monitoring'
                ? {
                    helper: 'When enabled (AND the employee holds active USB monitoring consent) the desktop agent reports real USB device insert/remove events. The server re-checks both on every upload.',
                  }
                : {})}
              {...(s.key === 'app_policy_enforcement'
                ? {
                    helper: 'When enabled, the desktop agent monitors running processes against this organization\'s whitelist/blacklist and reports blocked processes (Policy Management → Violations). Disabled by default — the agent never enforces until this is turned on.',
                  }
                : {})}
              {...(s.key === 'app_policy_terminate'
                ? {
                    helper: 'When enabled on top of App Policy Enforcement, a blocked application is actively TERMINATED on managed devices. This is a destructive action that may interrupt employee work. Report-only (false) is the safe default.',
                    confirmEnable: {
                      title: 'Enable application termination?',
                      description: 'This will allow OmniSight to automatically terminate applications that violate an active application policy on managed devices. This is a destructive action and may interrupt employee work. Only enable this if you understand the consequences.',
                    },
                  }
                : {})}
              {...(s.key === 'webcam_capture_enabled'
                ? {
                    helper: 'Enabling this allows authorized webcam sessions on managed devices. Webcam access remains subject to employee consent and server-side monitoring policy. Disabling this setting immediately stops server-side webcam frame acceptance.',
                    confirmEnable: {
                      title: 'Enable webcam capture?',
                      description: 'Enabling this setting allows authorized webcam sessions on managed devices. Webcam access remains subject to employee consent — enabling this does not bypass employee consent requirements. The server re-validates consent and this setting during active sessions.',
                    },
                  }
                : {})}
            />
          ))}
      </CardContent>
    </Card>
  );
}

/**
 * Server-side monitoring & intelligence settings. These keys are consumed by
 * server-side jobs/routes only — they are intentionally NOT part of the
 * Desktop Agent runtime contract (GET /api/agent/config), so they are shown
 * apart from the agent-facing settings to avoid implying agent behavior.
 */
function ServerSideIntelligenceCard() {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['monitoring-settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings/monitoring');
      if (!res.ok) throw new Error('Failed to load monitoring settings');
      return res.json();
    },
  });

  const serverSettings = ((data?.data || []) as MonitoringSetting[]).filter(
    (s) => s.key === 'ai_anomaly_detection'
  );
  if (serverSettings.length === 0) return null;

  return (
    <Card className='falcon-card falcon-card-hover'>
      <CardHeader className='pb-3'>
        <div className='flex items-center gap-3'>
          <div className='w-1 h-8 rounded-full bg-indigo-500' />
          <div className='flex items-center gap-2'>
            <div className='h-8 w-8 rounded-lg bg-indigo-50 dark:bg-indigo-900/40 flex items-center justify-center'>
              <Sparkles className='w-4 h-4 text-indigo-600 dark:text-indigo-300' />
            </div>
            <div>
              <CardTitle className='text-sm font-semibold'>Server-Side Monitoring &amp; Intelligence</CardTitle>
              <p className='text-xs text-muted-foreground mt-0.5'>Processed by the OmniSight server — not fetched by or used on Desktop Agents</p>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className='space-y-3'>
        {serverSettings.map((s) => (
          <MonitoringRow
            key={`${s.key}:${String(s.value)}`}
            s={s}
            onSaved={() => queryClient.invalidateQueries({ queryKey: ['monitoring-settings'] })}
            badge='Server-side only'
            helper='Rule-based statistical detection that runs automatically on a server-side schedule and on demand from the Anomalies page. Disabling stops detection for this organization (fails closed) and does not change Desktop Agent behavior.'
          />
        ))}
      </CardContent>
    </Card>
  );
}

export function SettingsPage() {
  const [activeSection, setActiveSection] = useState('general');
  const [settings, setSettings] = useState<Record<string, string>>({});
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch('/api/settings');
      const json = await res.json();
      const map: Record<string, string> = {};
      (json.data || []).forEach((s: { key: string; value: string }) => { map[s.key] = s.value; });
      setSettings(map);
      return json;
    },
  });

  const handleSave = async (key: string, value: string) => {
    try {
      // Global SystemSetting writes are super_admin-only (P1-7): surface the
      // server error truthfully instead of pretending the save succeeded.
      const res = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(json.error || 'Failed to update setting');
        return;
      }
      setSettings((prev) => ({ ...prev, [key]: value }));
      toast.success('Setting updated');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    } catch {
      toast.error('Failed to update setting');
    }
  };

  const sectionSettings = (data?.grouped?.[activeSection] || []) as Array<{ id: string; key: string; value: string; category: string | null }>;

  const boolSettings = sectionSettings.filter((s) => s.value === 'true' || s.value === 'false');
  const configSettings = sectionSettings.filter((s) => s.value !== 'true' && s.value !== 'false');

  return (
    <div className='grid grid-cols-1 lg:grid-cols-4 gap-6' role='region' aria-label='Settings'>
      {/* Section nav */}
      <Card className='falcon-card lg:col-span-1 h-fit sticky top-20'>
        <CardContent className='p-2'>
          <nav className='space-y-1' aria-label='Settings sections'>
            {sections.map((s) => {
              const Icon = s.icon;
              const isActive = activeSection === s.key;
              return (
                <button
                  key={s.key}
                  onClick={() => setActiveSection(s.key)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all relative',
                    isActive
                      ? 'text-primary'
                      : 'text-muted-foreground hover:bg-muted'
                  )}
                >
                  {/* Active left border indicator */}
                  <div className={cn(
                    'absolute left-0 top-1/2 -translate-y-1/2 w-1 h-6 rounded-r-full transition-all',
                    isActive ? 'bg-primary' : 'bg-transparent'
                  )} />
                  {/* Subtle background gradient for active */}
                  <div className={cn(
                    'absolute inset-0 rounded-lg transition-all',
                    isActive ? 'bg-muted' : ''
                  )} />
                  <Icon className={cn('w-4 h-4 relative z-10', isActive ? 'text-primary' : '')} />
                  <span className='relative z-10'>{s.label}</span>
                </button>
              );
            })}
          </nav>
        </CardContent>
      </Card>

      {/* Settings content */}
      <div className='lg:col-span-3 space-y-6'>
        {/* Theme Selector (Pill/Segmented Control) */}
        <Card className='falcon-card falcon-card-hover'>
          <CardHeader className='pb-3'>
            <div className='flex items-center gap-2'>
              <div className='h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center'>
                <Settings className='w-4 h-4 text-primary' />
              </div>
              <div>
                <CardTitle className='text-sm font-semibold'>Appearance</CardTitle>
                <p className='text-xs text-muted-foreground mt-0.5'>Customize how OmniSight looks for you</p>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <ThemeSelector />
          </CardContent>
        </Card>

        {/* Toggle Settings Group */}
        {boolSettings.length > 0 && (
          <Card className='falcon-card falcon-card-hover'>
            <CardHeader className='pb-3'>
              <div className='flex items-center gap-3'>
                <div className='w-1 h-8 rounded-full bg-primary' />
                <div className='flex items-center gap-2'>
                  <div className='h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center'>
                    <ToggleLeft className='w-4 h-4 text-primary' />
                  </div>
                  <div>
                    <CardTitle className='text-sm font-semibold'>Toggle Settings</CardTitle>
                    <p className='text-xs text-muted-foreground mt-0.5'>Enable or disable features and behaviors</p>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className='space-y-4'>
              {boolSettings.map((s) => {
                const isEnabled = s.value === 'true';
                return (
                  <div key={s.id} className='flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors'>
                    <div>
                      <Label className='text-sm font-medium'>{s.key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}</Label>
                      <p className='text-xs text-muted-foreground mt-0.5 font-mono'>{s.key}</p>
                    </div>
                    {/* Animated toggle with colored pill background */}
                    <div className={cn(
                      'px-1 py-1 rounded-full transition-all duration-300',
                      isEnabled ? 'bg-success/10 ring-success/20' : 'bg-muted'
                    )}>
                      <Switch
                        checked={isEnabled}
                        onCheckedChange={(v) => handleSave(s.key, String(v))}
                      />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        {/* Data Retention (org-scoped, backend-enforced) */}
        {activeSection === 'monitoring' && <DataRetentionCard />}

        {/* Agent Monitoring (org-scoped, drives GET /api/agent/config) */}
        {activeSection === 'monitoring' && <AgentMonitoringCard />}

        {/* Server-side monitoring & intelligence (not an agent runtime feature) */}
        {activeSection === 'monitoring' && <ServerSideIntelligenceCard />}

        {/* Configuration Group */}
        {configSettings.length > 0 && (
          <Card className='falcon-card falcon-card-hover'>
            <CardHeader className='pb-3'>
              <div className='flex items-center gap-3'>
                <div className='w-1 h-8 rounded-full bg-info' />
                <div className='flex items-center gap-2'>
                  <div className='h-8 w-8 rounded-lg bg-info/10 flex items-center justify-center'>
                    <Wrench className='w-4 h-4 text-info' />
                  </div>
                  <div>
                    <CardTitle className='text-sm font-semibold'>Configuration</CardTitle>
                    <p className='text-xs text-muted-foreground mt-0.5'>Adjust numeric and text-based settings</p>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent className='space-y-4'>
              {configSettings.map((s) => (
                <div key={s.id} className='flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors'>
                  <div>
                    <Label className='text-sm font-medium'>{s.key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}</Label>
                    <p className='text-xs text-muted-foreground mt-0.5 font-mono'>{s.key}</p>
                  </div>
                  <div className='flex items-center gap-2'>
                    <Input
                      value={settings[s.key] || s.value}
                      onChange={(e) => setSettings((prev) => ({ ...prev, [s.key]: e.target.value }))}
                      className='w-48 h-8'
                    />
                    <Button size='sm' variant='ghost' className='h-8 text-primary hover:text-primary' onClick={() => handleSave(s.key, settings[s.key] || s.value)}>
                      <Save className='w-3.5 h-3.5' />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {isLoading ? (
          <Card className='border shadow-sm'>
            <CardContent className='p-6'>
              <div className='space-y-4'>{Array.from({ length: 3 }).map((_, i) => <div key={i} className='h-12 bg-muted/30 rounded animate-pulse' />)}</div>
            </CardContent>
          </Card>
        ) : sectionSettings.length === 0 ? (
          <Card className='border shadow-sm'>
            <CardContent className='p-6'>
              <p className='text-muted-foreground text-sm py-8 text-center'>No settings in this category</p>
            </CardContent>
          </Card>
        ) : null}

        {/* User Management Section */}
        {activeSection === 'users' && (
          <UserManagement />
        )}

        {/* Account Security (Change Password) - shown in Security section */}
        {activeSection === 'security' && (
          <Card className='falcon-card falcon-card-hover'>
            <CardHeader className='pb-3'>
              <div className='flex items-center gap-2'>
                <div className='h-8 w-8 rounded-lg bg-gradient-to-br from-rose-50 to-orange-50 dark:from-rose-900/40 dark:to-orange-900/40 flex items-center justify-center'>
                  <Shield className='w-4 h-4 text-rose-600 dark:text-rose-400' />
                </div>
                <div className='flex-1'>
                  <CardTitle className='text-sm font-semibold'>Account Security</CardTitle>
                  <p className='text-xs text-muted-foreground mt-0.5'>Manage your password and account credentials</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className='flex items-center justify-between'>
              <div className='text-sm text-muted-foreground'>Update your password to keep your account secure</div>
              <ChangePasswordDialog>
                <Button variant='outline' size='sm' className='gap-2'>
                  <Shield className='w-3.5 h-3.5' /> Change Password
                </Button>
              </ChangePasswordDialog>
            </CardContent>
          </Card>
        )}

      </div>
    </div>
  );
}
