'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ShieldCheck,
  ShieldX,
  Plus,
  Trash2,
  Usb,
  Search,
  RefreshCw,
  AlertTriangle,
  Laptop,
  Gavel,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

// ==================== Types ====================

interface AppEntry {
  id: string;
  appName: string;
  executableName: string | null;
  category: string | null;
  listType: string;
  reason: string | null;
  createdAt: string;
}

interface UsbEvent {
  id: string;
  eventType: string;
  deviceName: string | null;
  vendorName: string | null;
  serialNumber: string | null;
  filePath: string | null;
  blocked: boolean;
  createdAt: string;
  employee?: { id: string; firstName: string; lastName: string; employeeId: string } | null;
  device?: { id: string; name: string } | null;
}

interface UsbSummary {
  total: number;
  blocked: number;
  inserts: number;
  removes: number;
}

interface PolicyViolation {
  id: string;
  executableName: string;
  processPath: string | null;
  severity: string;
  action: string;
  policyId: string;
  occurredAt: string;
  createdAt: string;
  employee?: { id: string; firstName: string; lastName: string; employeeId: string } | null;
  device?: { id: string; name: string } | null;
}

interface ViolationsSummary {
  total: number;
  blocked: number;
  low: number;
  medium: number;
  high: number;
  critical: number;
}

// ==================== Add App Dialog ====================

function AddAppDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [appName, setAppName] = useState('');
  const [executableName, setExecutableName] = useState('');
  const [listType, setListType] = useState<'whitelist' | 'blacklist'>('whitelist');
  const [reason, setReason] = useState('');

  const queryClient = useQueryClient();

  const addMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/app-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appName, executableName, listType, reason }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to add app');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['app-list'] });
      toast.success(`Added ${appName} to ${listType}`);
      setAppName('');
      setExecutableName('');
      setReason('');
      onClose();
    },
    onError: (err) => {
      toast.error(err.message || 'Failed to add app');
    },
  });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add Application to {listType === 'whitelist' ? 'Whitelist' : 'Blacklist'}</DialogTitle>
          <DialogDescription>
            {listType === 'whitelist'
              ? 'Adds the app to this organization\'s allowed-app policy list. Configured policy — enforcement depends on omnisight-agent support.'
              : 'Adds the app to this organization\'s blocked-app policy list. Configured policy — enforcement depends on omnisight-agent support.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="appName">Application Name *</Label>
            <Input id="appName" placeholder="e.g., Google Chrome" value={appName} onChange={(e) => setAppName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="execName">Executable Name</Label>
            <Input id="execName" placeholder="e.g., chrome.exe" value={executableName} onChange={(e) => setExecutableName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Policy Type *</Label>
            <Select value={listType} onValueChange={(v) => setListType(v as 'whitelist' | 'blacklist')}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="whitelist">
                  <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-500" /> Whitelist (Allowed)</div>
                </SelectItem>
                <SelectItem value="blacklist">
                  <div className="flex items-center gap-2"><ShieldX className="h-4 w-4 text-rose-500" /> Blacklist (Blocked)</div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reason">Reason (optional)</Label>
            <Textarea id="reason" placeholder="Why is this app being added?" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => addMutation.mutate()} disabled={!appName || addMutation.isPending}>
            {addMutation.isPending ? 'Adding...' : `Add to ${listType === 'whitelist' ? 'Whitelist' : 'Blacklist'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ==================== App List Tab ====================

function AppListTab() {
  const [listTypeFilter, setListTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AppEntry | null>(null);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['app-list', listTypeFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (listTypeFilter) params.set('type', listTypeFilter);
      if (search) params.set('search', search);
      params.set('pageSize', '100');
      const res = await fetch(`/api/app-list?${params}`);
      if (!res.ok) throw new Error('Failed to load app policies');
      return res.json();
    },
  });

  const entries: AppEntry[] = data?.data || [];
  const policyVersion: string = data?.policyVersion ?? '';

  const whitelistCount = entries.filter(e => e.listType === 'whitelist').length;
  const blacklistCount = entries.filter(e => e.listType === 'blacklist').length;

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/app-list/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to remove');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['app-list'] });
      toast.success('App removed from list');
    },
    onError: () => toast.error('Failed to remove app'),
  });

  return (
    <div className="space-y-4" role="region" aria-label="Policies">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-4">
        <Card className="falcon-card p-0">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Whitelisted</p>
              <p className="text-lg font-bold text-emerald-600">{whitelistCount}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="falcon-card p-0">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
              <ShieldX className="h-4 w-4 text-rose-600 dark:text-rose-400" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Blacklisted</p>
              <p className="text-lg font-bold text-rose-600">{blacklistCount}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Enforcement status banner — honest about agent-side behavior */}
      <Card className="falcon-card p-0 border-l-2 border-l-amber-500">
        <CardContent className="p-3 flex items-center gap-2 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span className="text-muted-foreground">
            Policy <span className="font-mono text-foreground">v{policyVersion || '0'}</span> — pushed to
            approved desktop agents on their next config sync. Enforcement is{' '}
            <span className="font-medium text-foreground">report-only unless enabled</span> in the
            organization monitoring settings; blocking never terminates a process unless termination
            is explicitly enabled.
          </span>
        </CardContent>
      </Card>

      {/* Toolbar */}
      <Card className="falcon-card p-0">
        <CardContent className="p-3">
          <div className="flex flex-wrap gap-2 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input placeholder="Search apps..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-8 h-8 text-xs" />
            </div>
            <Select value={listTypeFilter || 'all'} onValueChange={(v) => setListTypeFilter(v === 'all' ? '' : v)}>
              <SelectTrigger className="h-8 text-xs w-[130px]">
                <SelectValue placeholder="All Lists" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Lists</SelectItem>
                <SelectItem value="whitelist">Whitelist</SelectItem>
                <SelectItem value="blacklist">Blacklist</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 h-3.5 mr-1" /> Refresh
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 h-3.5 mr-1" /> Add App
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* App List */}
      {isError ? (
        <Card className="falcon-card p-0">
          <CardContent className="p-4 flex flex-col items-center gap-2 text-center">
            <AlertTriangle className="h-6 w-6 text-rose-500" />
            <p className="text-sm font-medium">Failed to load app policies</p>
            <p className="text-xs text-muted-foreground">Check your connection and try again.</p>
            <Button variant="outline" size="sm" className="h-8 text-xs mt-1" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
            </Button>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No apps in list"
          description="Add applications to whitelist or blacklist using the button above."
          action={{ label: 'Add First App', onClick: () => setAddOpen(true) }}
        />
      ) : (
        <div className="space-y-2">
          <AnimatePresence mode="popLayout">
            {entries.map((entry) => (
              <motion.div
                key={entry.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className={`falcon-card p-0 flex items-center gap-3 ${entry.listType === 'whitelist' ? 'border-l-2 border-l-emerald-500' : 'border-l-2 border-l-rose-500'}`}
              >
                <CardContent className="p-3 flex items-center gap-3 flex-1 min-w-0">
                  <div className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${
                    entry.listType === 'whitelist' ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-rose-100 dark:bg-rose-900/30'
                  }`}>
                    {entry.listType === 'whitelist'
                      ? <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                      : <ShieldX className="h-4 w-4 text-rose-600 dark:text-rose-400" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{entry.appName}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {entry.executableName && (
                        <span className="text-[10px] text-muted-foreground font-mono">{entry.executableName}</span>
                      )}
                      {entry.category && (
                        <Badge variant="outline" className="text-[9px] h-4 px-1">{entry.category}</Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
                <div className="pr-3 flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleDateString()}
                  </span>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
                    onClick={() => setDeleteTarget(entry)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      <AddAppDialog open={addOpen} onClose={() => setAddOpen(false)} />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Remove App from Policy List"
        description={`Are you sure you want to remove \"${deleteTarget?.appName ?? ''}\" from the ${deleteTarget?.listType ?? ''} list? The agent will stop enforcing this policy for this app on its next config sync.`}
        confirmLabel="Remove"
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        disabled={deleteMutation.isPending}
      />
    </div>
  );
}

// ==================== USB Events Tab ====================

function UsbEventsTab() {
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [blockedOnly, setBlockedOnly] = useState(false);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['usb-events', eventTypeFilter, blockedOnly],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('pageSize', '20');
      if (eventTypeFilter) params.set('eventType', eventTypeFilter);
      if (blockedOnly) params.set('blocked', 'true');
      const res = await fetch(`/api/usb-events?${params}`);
      if (!res.ok) throw new Error('Failed to load USB events');
      return res.json();
    },
  });

  const events: UsbEvent[] = data?.data || [];
  const summary: UsbSummary = data?.summary || { total: 0, blocked: 0, inserts: 0, removes: 0 };

  const eventIcons: Record<string, { icon: React.ElementType; color: string }> = {
    usb_insert: { icon: Usb, color: 'text-blue-500' },
    usb_remove: { icon: Usb, color: 'text-slate-500' },
    usb_blocked: { icon: Usb, color: 'text-rose-500' },
  };

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="falcon-card p-0">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
              <Usb className="h-4 w-4 text-blue-600" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">USB Events (7d)</p>
              <p className="text-lg font-bold">{summary.total}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="falcon-card p-0">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
              <Usb className="h-4 w-4 text-emerald-600" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Inserts</p>
              <p className="text-lg font-bold text-emerald-600">{summary.inserts}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="falcon-card p-0">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
              <Usb className="h-4 w-4 text-slate-600" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Removes</p>
              <p className="text-lg font-bold text-slate-600">{summary.removes}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="falcon-card p-0">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
              <AlertTriangle className="h-4 w-4 text-rose-600" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Blocked</p>
              <p className="text-lg font-bold text-rose-600">{summary.blocked}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Toolbar */}
      <Card className="falcon-card p-0">
        <CardContent className="p-3">
          <div className="flex flex-wrap gap-2 items-center">
            <Select value={eventTypeFilter || 'all'} onValueChange={(v) => setEventTypeFilter(v === 'all' ? '' : v)}>
              <SelectTrigger className="h-8 text-xs w-[130px]">
                <SelectValue placeholder="All Events" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Events</SelectItem>
                <SelectItem value="usb_insert">USB Insert</SelectItem>
                <SelectItem value="usb_remove">USB Remove</SelectItem>
                <SelectItem value="usb_blocked">USB Blocked</SelectItem>
              </SelectContent>
            </Select>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={blockedOnly}
                onChange={(e) => setBlockedOnly(e.target.checked)}
                className="rounded border-muted-foreground"
              />
              <span>Blocked only</span>
            </label>
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 h-3.5 mr-1" /> Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Events List */}
      {isError ? (
        <Card className="falcon-card p-0">
          <CardContent className="p-4 flex flex-col items-center gap-2 text-center">
            <AlertTriangle className="h-6 w-6 text-rose-500" />
            <p className="text-sm font-medium">Failed to load USB events</p>
            <Button variant="outline" size="sm" className="h-8 text-xs mt-1" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
            </Button>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          icon={Usb}
          title="No USB events"
          description="USB monitoring events will appear here when devices connect USB peripherals."
        />
      ) : (
        <div className="space-y-2">
          {events.map((event, idx) => {
            const config = eventIcons[event.eventType] || eventIcons.usb_insert;
            const Icon = config.icon;
            return (
              <motion.div
                key={event.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.03 }}
                className={`falcon-card p-0 flex items-start gap-3 ${event.blocked ? 'border-l-2 border-l-rose-500' : ''}`}
              >
                <CardContent className="p-3">
                  <div className="flex items-start gap-3 w-full">
                    <div className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 mt-0.5 ${
                      event.blocked ? 'bg-rose-100 dark:bg-rose-900/30' : 'bg-blue-100 dark:bg-blue-900/30'
                    }`}>
                      <Icon className={`h-4 w-4 ${config.color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant={event.blocked ? 'destructive' : 'secondary'} className="text-[9px] h-4 px-1">
                          {event.eventType.replace('usb_', 'USB ')}
                        </Badge>
                        {event.deviceName && (
                          <span className="text-xs font-medium truncate">{event.deviceName}</span>
                        )}
                        {event.blocked && (
                          <span className="text-[9px] text-rose-600 font-medium">BLOCKED</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
                        {event.vendorName && <span>Vendor: {event.vendorName}</span>}
                        {event.vendorName && event.serialNumber && <span> ·</span>}
                        {event.serialNumber && <span>SN: {event.serialNumber.substring(0, 12)}</span>}
                      </div>
                      {event.filePath && (
                        <p className="text-[10px] text-muted-foreground/70 mt-0.5 font-mono truncate">
                          <Laptop className="h-3 w-3 inline mr-0.5" />{event.filePath}
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground/60">
                        {event.employee && (
                          <span>{event.employee.firstName} {event.employee.lastName}</span>
                        )}
                        {event.employee && event.device && <span> ·</span>}
                        {event.device && <span>{event.device.name}</span>}
                        <span className="ml-auto">{new Date(event.createdAt).toLocaleString()}</span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}// ==================== Policy Violations Tab ====================

function PolicyViolationsTab() {
  const [severityFilter, setSeverityFilter] = useState('');
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['policy-violations', severityFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (severityFilter) params.set('severity', severityFilter);
      params.set('pageSize', '50');
      const res = await fetch(`/api/policy-violations?${params}`);
      if (!res.ok) throw new Error('Failed to load policy violations');
      return res.json();
    },
  });

  const violations: PolicyViolation[] = data?.data || [];
  const summary: ViolationsSummary = data?.summary || { total: 0, blocked: 0, low: 0, medium: 0, high: 0, critical: 0 };

  const severityColor: Record<string, string> = {
    low: 'text-emerald-600 bg-emerald-100 dark:bg-emerald-900/30',
    medium: 'text-amber-600 bg-amber-100 dark:bg-amber-900/30',
    high: 'text-orange-600 bg-orange-100 dark:bg-orange-900/30',
    critical: 'text-rose-600 bg-rose-100 dark:bg-rose-900/30',
  };

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="falcon-card p-0">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-rose-100 dark:bg-rose-900/30 flex items-center justify-center">
              <Gavel className="h-4 w-4 text-rose-600" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Blocked Events</p>
              <p className="text-lg font-bold text-rose-600">{summary.blocked}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="falcon-card p-0">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
              <AlertTriangle className="h-4 w-4 text-orange-600" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">High/Critical</p>
              <p className="text-lg font-bold text-orange-600">{summary.high + summary.critical}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="falcon-card p-0">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Medium</p>
              <p className="text-lg font-bold text-amber-600">{summary.medium}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="falcon-card p-0">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground">Low</p>
              <p className="text-lg font-bold text-emerald-600">{summary.low}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Toolbar */}
      <Card className="falcon-card p-0">
        <CardContent className="p-3">
          <div className="flex flex-wrap gap-2 items-center">
            <Select value={severityFilter || 'all'} onValueChange={(v) => setSeverityFilter(v === 'all' ? '' : v)}>
              <SelectTrigger className="h-8 text-xs w-[130px]">
                <SelectValue placeholder="All Severities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Severities</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex-1" />
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 h-3.5 mr-1" /> Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Violations List */}
      {isError ? (
        <Card className="falcon-card p-0">
          <CardContent className="p-4 flex flex-col items-center gap-2 text-center">
            <AlertTriangle className="h-6 w-6 text-rose-500" />
            <p className="text-sm font-medium">Failed to load policy violations</p>
            <Button variant="outline" size="sm" className="h-8 text-xs mt-1" onClick={() => refetch()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
            </Button>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
        </div>
      ) : violations.length === 0 ? (
        <EmptyState
          icon={Gavel}
          title="No policy violations"
          description="Blocked application events appear here when the desktop agent enforces the blacklist."
        />
      ) : (
        <div className="space-y-2">
          {violations.map((v) => (
            <div key={v.id} className={`falcon-card p-0 flex items-start gap-3 border-l-2 ${severityColor[v.severity]?.split(' ')[0] ? 'border-l-rose-500' : 'border-l-amber-500'}`}>
              <CardContent className="p-3 w-full">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={v.severity === 'critical' || v.severity === 'high' ? 'destructive' : 'secondary'} className="text-[9px] h-4 px-1 uppercase">
                    {v.severity}
                  </Badge>
                  <span className="text-xs font-medium font-mono truncate">{v.executableName}</span>
                  <span className="text-[9px] text-rose-600 font-medium">BLOCKED</span>
                </div>
                {v.processPath && (
                  <p className="text-[10px] text-muted-foreground/70 mt-0.5 font-mono truncate">{v.processPath}</p>
                )}
                <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground/60">
                  <span>Action: {v.action}</span>
                  <span className="ml-auto">{new Date(v.createdAt).toLocaleString()}</span>
                </div>
              </CardContent>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== Main Page ====================

export function PoliciesPage() {
  const [activeTab, setActiveTab] = useState('app-list');

  return (
    <div className="space-y-4">
      {/* Header */}
      <Card className="falcon-card p-0">
        <CardContent className="p-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <ShieldCheck className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Policy Management</h2>
              <p className="text-xs text-muted-foreground">Application whitelist/blacklist, enforcement and USB device monitoring</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="app-list" className="gap-2">
            <ShieldCheck className="h-4 w-4" />
            App Lists
          </TabsTrigger>
          <TabsTrigger value="violations" className="gap-2">
            <Gavel className="h-4 w-4" />
            Violations
          </TabsTrigger>
          <TabsTrigger value="usb" className="gap-2">
            <Usb className="h-4 w-4" />
            USB Monitoring
          </TabsTrigger>
        </TabsList>
        <TabsContent value="app-list">
          <AppListTab />
        </TabsContent>
        <TabsContent value="violations">
          <PolicyViolationsTab />
        </TabsContent>
        <TabsContent value="usb">
          <UsbEventsTab />
        </TabsContent>
      </Tabs>
    </div>
  );

}
