'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  ShieldAlert,
  ShieldCheck,
  Shield,
  AlertTriangle,
  Eye,
  MonitorOff,
  Settings,
  Search,
  RefreshCw,
  Clock,
  Cpu,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { EmptyState } from '@/components/ui/empty-state';

// ==================== Constants ====================

// Agent/security-specific alert types (the Alert model's type enum). General
// operational alerts (license, system) belong to the Alerts page; this page
// consumes only the agent-derived security/monitoring subset so the two pages
// are not the exact same list.
const AGENT_SECURITY_TYPES = 'security,device_offline,policy_violation,high_inactivity';

// ==================== Types ====================

interface SecurityAlert {
  id: string;
  title: string;
  description: string;
  type: string;
  severity: string;
  status: string;
  source: string | null;
  metadata: string | null;
  createdAt: string;
}

// ==================== Severity Config ====================

const severityConfig: Record<string, { icon: React.ElementType; color: string; bgColor: string; label: string }> = {
  critical: { icon: ShieldAlert, color: 'text-red-700 dark:text-red-400', bgColor: 'bg-red-100 dark:bg-red-900/30', label: 'Critical' },
  high: { icon: AlertTriangle, color: 'text-amber-700 dark:text-amber-400', bgColor: 'bg-amber-100 dark:bg-amber-900/30', label: 'High' },
  warning: { icon: Eye, color: 'text-orange-600 dark:text-orange-400', bgColor: 'bg-orange-100 dark:bg-orange-900/30', label: 'Warning' },
  medium: { icon: Eye, color: 'text-blue-600 dark:text-blue-400', bgColor: 'bg-blue-100 dark:bg-blue-900/30', label: 'Medium' },
  info: { icon: Shield, color: 'text-slate-600 dark:text-slate-400', bgColor: 'bg-slate-100 dark:bg-slate-800', label: 'Info' },
};

// ==================== Stat Card ====================

function StatCard({ label, value, icon: Icon, color, sub }: {
  label: string; value: number; icon: React.ElementType; color: string; sub?: string;
}) {
  return (
    <Card className="falcon-card p-0">
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={`h-10 w-10 rounded-lg ${color} flex items-center justify-center shrink-0`}>
            <Icon className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold leading-tight">{value}</p>
            {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ==================== Alert Card ====================

function AlertCard({ alert, index }: { alert: SecurityAlert; index: number }) {
  const config = severityConfig[alert.severity] || severityConfig.info;
  const Icon = config.icon;

  let metaObj: Record<string, string> | null = null;
  try {
    metaObj = alert.metadata ? JSON.parse(alert.metadata) : null;
  } catch {
    // ignore
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.04 }}
      className="falcon-card border-l-4 hover:shadow-md transition-shadow"
      style={{ borderLeftColor: alert.severity === 'critical' ? '#ef4444' : alert.severity === 'high' ? '#f59e0b' : '#3b82f6' }}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <div className={`h-9 w-9 rounded-lg ${config.bgColor} flex items-center justify-center shrink-0 mt-0.5`}>
            <Icon className={`h-4 w-4 ${config.color}`} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold truncate">{alert.title}</h3>
              <Badge className={`${config.bgColor} ${config.color} text-[9px] h-4 px-1.5 border-0`}>
                {config.label}
              </Badge>
              {alert.status === 'pending' && (
                <Badge className="bg-amber-100 text-amber-700 text-[9px] h-4 px-1.5 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400">
                  Pending
                </Badge>
              )}
              {alert.status === 'acknowledged' && (
                <Badge className="bg-blue-100 text-blue-700 text-[9px] h-4 px-1.5 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400">
                  Acknowledged
                </Badge>
              )}
              {alert.status === 'resolved' && (
                <Badge className="bg-emerald-100 text-emerald-700 text-[9px] h-4 px-1.5 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400">
                  Resolved
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{alert.description}</p>
            <div className="flex items-center gap-3 mt-2 text-[10px] text-muted-foreground/60">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {new Date(alert.createdAt).toLocaleString()}
              </span>
              {alert.source && (
                <span className="flex items-center gap-1">
                  <MonitorOff className="h-3 w-3" />
                  Source: {alert.source}
                </span>
              )}
            </div>
            {metaObj && Object.keys(metaObj).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(metaObj).slice(0, 4).map(([key, value]) => (
                  <span key={key} className="text-[9px] bg-muted px-1.5 py-0.5 rounded">
                    {key}: {String(value).substring(0, 30)}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </motion.div>
  );
}

// ==================== Tamper Types Info ====================

function TamperTypesInfo() {
  const types = [
    { icon: Cpu, title: 'Agent Stopped', desc: 'Monitoring agent process was terminated unexpectedly', severity: 'critical' },
    { icon: Cpu, title: 'Process Killed', desc: 'Agent detected attempt to kill monitoring process', severity: 'critical' },
    { icon: Eye, title: 'Screenshot Blocked', desc: 'Screenshot capture was blocked or tampered', severity: 'high' },
    { icon: MonitorOff, title: 'Uninstall Attempt', desc: 'Attempt to uninstall or disable the monitoring agent', severity: 'critical' },
    { icon: Settings, title: 'Config Changed', desc: 'Agent configuration was modified without authorization', severity: 'high' },
    { icon: Shield, title: 'Suspicious Activity', desc: 'Unusual patterns detected in employee behavior', severity: 'medium' },
  ];

  return (
    <Card className="falcon-card p-0">
      <CardContent className="p-4">
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Shield className="h-4 w-4 text-primary" />
          Tamper Detection Types
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {types.map((t) => {
            const Icon = t.icon;
            return (
              <div key={t.title} className="flex items-start gap-2.5 p-2.5 rounded-lg bg-muted/20">
                <div className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${
                  t.severity === 'critical' ? 'bg-red-100 dark:bg-red-900/20' : 'bg-amber-100 dark:bg-amber-900/20'
                }`}>
                  <Icon className={`h-4 w-4 ${
                    t.severity === 'critical' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'
                  }`} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-medium">{t.title}</p>
                  <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">{t.desc}</p>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ==================== Main Page ====================

export function SecurityPage() {
  const [severityFilter, setSeverityFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showInfo, setShowInfo] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['security-alerts', severityFilter, statusFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('type', AGENT_SECURITY_TYPES);
      params.set('pageSize', '50');
      if (severityFilter && severityFilter !== 'all') params.set('severity', severityFilter);
      if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter);
      if (search) params.set('search', search);
      const res = await fetch(`/api/alerts?${params}`);
      const json = await res.json();
      return json;
    },
  });

  const alerts: SecurityAlert[] = data?.data || [];
  const total = data?.total || 0;

  // Stats
  const criticalCount = alerts.filter(a => a.severity === 'critical').length;
  const highCount = alerts.filter(a => a.severity === 'high').length;
  const pendingCount = alerts.filter(a => a.status === 'pending').length;

  const hasFilters = severityFilter || statusFilter || search;

  return (
    <div className="space-y-4" role="region" aria-label="Agent Security">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Agent Security Alerts" value={total} icon={ShieldAlert} color="bg-red-500" sub="Agent/security-specific events" />
        <StatCard label="Critical" value={criticalCount} icon={ShieldAlert} color="bg-red-600" />
        <StatCard label="High Severity" value={highCount} icon={AlertTriangle} color="bg-amber-500" />
        <StatCard label="Pending Review" value={pendingCount} icon={Eye} color="bg-blue-500" />
      </div>

      {/* Tamper Detection Info */}
      {showInfo && <TamperTypesInfo />}

      {/* Filters */}
      <Card className="falcon-card p-0">
        <CardContent className="p-3">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search alerts..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-8 text-xs"
              />
            </div>
            <Select value={severityFilter || 'all'} onValueChange={(v) => setSeverityFilter(v === 'all' ? '' : v)}>
              <SelectTrigger className="h-8 text-xs w-[130px]">
                <SelectValue placeholder="All Severity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Severity</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="info">Info</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter || 'all'} onValueChange={(v) => setStatusFilter(v === 'all' ? '' : v)}>
              <SelectTrigger className="h-8 text-xs w-[130px]">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="acknowledged">Acknowledged</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex-1" />
            {hasFilters && (
              <Button variant="ghost" size="sm" className="h-8 text-xs"
                onClick={() => { setSeverityFilter(''); setStatusFilter(''); setSearch(''); }}>
                Reset
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" />
              Refresh
            </Button>
            <Button variant="outline" size="sm" className="h-8 text-xs"
              onClick={() => setShowInfo(!showInfo)}>
              <ShieldCheck className="h-3.5 w-3.5 mr-1" />
              {showInfo ? 'Hide Info' : 'Detection Types'}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-2">
            Agent/security-specific alerts (security events, device offline, policy violations, high inactivity).
            General operational alerts are managed under Alerts.
          </p>
        </CardContent>
      </Card>

      {/* Alert List */}
      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No Agent Security Alerts"
          description={hasFilters ? 'No alerts match your current filters. Try adjusting your search criteria.' : 'No agent/security events detected. Tamper, offline, and policy-violation alerts appear here.'}
          action={hasFilters ? { label: 'Clear Filters', onClick: () => { setSeverityFilter(''); setStatusFilter(''); setSearch(''); } } : undefined}
        />
      ) : (
        <div className="space-y-3">
          {alerts.map((alert, idx) => (
            <AlertCard key={alert.id} alert={alert} index={idx} />
          ))}
        </div>
      )}
    </div>
  );
}
